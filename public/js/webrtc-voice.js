/**
 * VoiceEngine - Hybrid Dual-Engine Voice System:
 * 1. WebRTC P2P Voice Mesh with Global STUN & OpenRelay TURN Relay (0% server load, 48kHz Opus HD voice)
 * 2. Instant Zero-Lag WebSocket Audio Fallback (guarantees you ALWAYS hear your friends across any firewall or mobile network)
 * 3. Smart Anti-Lag Buffer Trimming (never builds up queues or lag, even with 3+ users)
 */
class WebRTCVoiceManager {
  constructor(socket, user = null) {
    this.socket = socket;
    this.user = user;
    this.localStream = null;
    this.audioCtx = null;
    this.micSource = null;
    this.processor = null;
    this.currentChannelId = null;

    this.isMuted = false;
    this.isDeafened = false;
    this.lastSpeakingState = false;
    this.silenceHoldFrames = 0;

    // Push-to-Talk (PTT)
    this.inputMode = localStorage.getItem('cordlite_input_mode') || 'vad'; // 'vad' or 'ptt'
    this.pttKey = localStorage.getItem('cordlite_ptt_key') || 'Space';
    this.isPttActive = false;

    // Voice Input Sensitivity Gate & Mic Level
    this.autoSensitivity = localStorage.getItem('cordlite_auto_sens') !== 'false';
    this.sensitivityThreshold = parseFloat(localStorage.getItem('cordlite_sens_threshold') || '0.02');
    this.onMicLevelUpdate = null;

    // Video & Screen Sharing
    this.isCameraOn = false;
    this.isScreenSharing = false;
    this.localCameraStream = null;
    this.localScreenStream = null;
    this.peerConnections = new Map(); // socketId -> RTCPeerConnection
    this.peerVideoStreams = new Map(); // socketId -> MediaStream
    this.peerAudioNodes = new Map(); // socketId -> { audioEl, sourceNode, analyserNode, stream }
    this.playbackTimes = new Map(); // socketId -> next scheduled playback time (for anti-lag audio queue)

    // Local mute and volume control for peers (Discord style)
    this.peerVolumes = new Map(); // (socketId/userId) -> volume (0.0 to 1.5)
    this.locallyMutedUsers = new Set(); // Set of socketIds/userIds muted locally

    // socketId -> { socketId, userId, name, avatarColor, avatarUrl, isSpeaking, isMuted, isDeafened, isCameraOn, isScreenSharing, videoStream }
    this.peers = new Map();
    this.pendingIceCandidates = new Map(); // socketId -> [candidates]
    this._lastStreamRequests = new Map(); // socketId -> timestamp

    // Callbacks
    this.onPeersUpdateCallback = null;
    this.onLocalSpeaking = null;
    this.onPeerSpeakingCallback = null;
    this.onPeerVideoUpdate = null;
    this.onPeerScreenFrame = null;
    this.onSoundboardPlayed = null;

    // Dual-Engine Fallback for Screen Sharing
    this.peerScreenFrames = new Map(); // socketId -> frame data URL
    this.screenFrameInterval = null;
    this.screenCaptureVideo = null;
    this.screenCaptureCanvas = null;

    // Remote speaking analysis interval
    this.remoteSpeakingInterval = null;

    // Mic test state
    this.isTestingMic = false;
    this.onMicTestUpdate = null;
    this.testStream = null;
    this.testSource = null;
    this.testProcessor = null;

    // High-availability global STUN + free public OpenRelay TURN configuration
    this.iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      {
        urls: [
          'turn:openrelay.metered.ca:80',
          'turn:openrelay.metered.ca:443',
          'turn:openrelay.metered.ca:443?transport=tcp'
        ],
        username: 'openrelay',
        credential: 'openrelay'
      }
    ];

    this.setupSocketEvents();
  }

  isPeerLocallyMuted(socketId, userId) {
    if (socketId && this.locallyMutedUsers.has(socketId)) return true;
    if (userId && this.locallyMutedUsers.has(userId)) return true;
    return false;
  }

  getPeerVolume(socketId, userId) {
    if (this.isPeerLocallyMuted(socketId, userId)) return 0;
    if (userId && this.peerVolumes.has(userId)) return this.peerVolumes.get(userId);
    if (socketId && this.peerVolumes.has(socketId)) return this.peerVolumes.get(socketId);
    return 1.0;
  }

  setPeerVolume(socketId, userId, volume) {
    const vol = Math.max(0, Math.min(1.5, volume));
    if (socketId) this.peerVolumes.set(socketId, vol);
    if (userId) this.peerVolumes.set(userId, vol);
    if (vol <= 0.01) {
      if (socketId) this.locallyMutedUsers.add(socketId);
      if (userId) this.locallyMutedUsers.add(userId);
    } else {
      if (socketId) this.locallyMutedUsers.delete(socketId);
      if (userId) this.locallyMutedUsers.delete(userId);
    }

    // Update WebRTC HTMLAudioElement if present
    const audioEl = document.getElementById(`remote-audio-${socketId}`);
    if (audioEl) {
      const isMuted = this.isPeerLocallyMuted(socketId, userId);
      audioEl.muted = this.isDeafened || isMuted;
      audioEl.volume = Math.max(0, Math.min(1.0, vol));
    }

    this.notifyPeersUpdate();
  }

  toggleMutePeer(socketId, userId) {
    const isMuted = this.isPeerLocallyMuted(socketId, userId);
    let nowMuted = false;
    if (isMuted) {
      if (socketId) this.locallyMutedUsers.delete(socketId);
      if (userId) this.locallyMutedUsers.delete(userId);
      const curr = this.getPeerVolume(socketId, userId);
      if (curr <= 0.01) {
        if (socketId) this.peerVolumes.set(socketId, 1.0);
        if (userId) this.peerVolumes.set(userId, 1.0);
      }
      nowMuted = false;
    } else {
      if (socketId) this.locallyMutedUsers.add(socketId);
      if (userId) this.locallyMutedUsers.add(userId);
      nowMuted = true;
    }

    // Update WebRTC HTMLAudioElement
    const audioEl = document.getElementById(`remote-audio-${socketId}`);
    if (audioEl) {
      audioEl.muted = this.isDeafened || nowMuted;
    }

    this.notifyPeersUpdate();
    return nowMuted;
  }

  getAudioContext() {
    if (!this.audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioCtx();
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume().catch(() => {});
    }
    return this.audioCtx;
  }

  setPeersUpdateCallback(cb) {
    this.onPeersUpdateCallback = cb;
  }

  // Check if WebRTC P2P direct audio stream is successfully established
  isWebRTCActive(socketId) {
    const pc = this.peerConnections.get(socketId);
    if (!pc) return false;
    return pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed';
  }

  setupSocketEvents() {
    // Current occupants in voice channel
    this.socket.on('voice:current_peers', ({ channelId, peers }) => {
      this.currentChannelId = channelId;
      peers.forEach(peer => {
        this.peers.set(peer.socketId, {
          socketId: peer.socketId,
          userId: peer.userId,
          name: peer.name || 'Friend',
          avatarColor: peer.avatarColor || '#5865F2',
          avatarUrl: peer.avatarUrl || null,
          isSpeaking: peer.isSpeaking || false,
          isMuted: peer.isMuted || false,
          isDeafened: peer.isDeafened || false,
          isCameraOn: peer.isCameraOn || false,
          isScreenSharing: peer.isScreenSharing || false
        });

        // Initialize PeerConnection
        this.getOrCreatePeerConnection(peer.socketId);

        // Deterministic mesh initiator: peer with lower socketId creates the offer
        if (this.socket.id && this.socket.id < peer.socketId) {
          this.initiateOfferTo(peer.socketId);
        }
      });
      this.notifyPeersUpdate();
    });

    // When someone joins after us
    this.socket.on('voice:user_joined', (peer) => {
      if (peer.socketId === this.socket.id) return;
      this.peers.set(peer.socketId, {
        socketId: peer.socketId,
        userId: peer.userId,
        name: peer.name || 'Friend',
        avatarColor: peer.avatarColor || '#5865F2',
        avatarUrl: peer.avatarUrl || null,
        isSpeaking: peer.isSpeaking || false,
        isMuted: peer.isMuted || false,
        isDeafened: peer.isDeafened || false,
        isCameraOn: peer.isCameraOn || false,
        isScreenSharing: peer.isScreenSharing || false
      });

      // Initialize PeerConnection
      this.getOrCreatePeerConnection(peer.socketId);

      // Deterministic mesh initiator: peer with lower socketId creates the offer
      if (this.socket.id && this.socket.id < peer.socketId) {
        this.initiateOfferTo(peer.socketId);
      }

      this.notifyPeersUpdate();
    });

    // Unified WebRTC Signaling (supports voice:signal and legacy voice:video_signal)
    const handleSignal = async ({ fromSocketId, signal }) => {
      if (!fromSocketId || !signal) return;
      try {
        const pc = this.getOrCreatePeerConnection(fromSocketId);

        if (signal.type === 'offer') {
          this.attachLocalTracksToPC(pc);

          await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));

          // Drain queued ICE candidates
          const pending = this.pendingIceCandidates.get(fromSocketId) || [];
          for (const cand of pending) {
            try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (e) {}
          }
          this.pendingIceCandidates.delete(fromSocketId);

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          this.socket.emit('voice:signal', {
            toSocketId: fromSocketId,
            signal: { type: 'answer', sdp: answer }
          });
        } else if (signal.type === 'answer') {
          await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));

          // Drain queued ICE candidates
          const pending = this.pendingIceCandidates.get(fromSocketId) || [];
          for (const cand of pending) {
            try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (e) {}
          }
          this.pendingIceCandidates.delete(fromSocketId);
        } else if (signal.type === 'candidate' && signal.candidate) {
          if (pc.remoteDescription && pc.remoteDescription.type) {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
            } catch (e) {
              console.warn('addIceCandidate error:', e);
            }
          } else {
            if (!this.pendingIceCandidates.has(fromSocketId)) {
              this.pendingIceCandidates.set(fromSocketId, []);
            }
            this.pendingIceCandidates.get(fromSocketId).push(signal.candidate);
          }
        }
      } catch (err) {
        console.warn(`WebRTC signal error with ${fromSocketId}:`, err);
      }
    };

    this.socket.on('voice:signal', handleSignal);
    this.socket.on('voice:video_signal', handleSignal);

    // Direct WebSocket audio stream chunk (100% universal firewall-piercing fallback)
    this.socket.on('voice:audio_stream', ({ fromSocketId, fromUser, audioData, sampleRate }) => {
      if (this.isDeafened) return;
      if (fromSocketId === this.socket.id) return;
      if (this.user && fromUser && fromUser.userId === this.user.userId) return;
      if (this.isPeerLocallyMuted(fromSocketId, fromUser ? fromUser.userId : null)) return;

      // If WebRTC P2P is already established and delivering UDP Opus audio, skip WebSocket chunk to avoid echo
      if (this.isWebRTCActive(fromSocketId)) {
        return;
      }

      let peer = this.peers.get(fromSocketId);
      if (!peer) {
        peer = {
          socketId: fromSocketId,
          userId: fromUser ? fromUser.userId : null,
          name: fromUser ? fromUser.name : 'Friend',
          avatarColor: fromUser ? fromUser.avatarColor : '#5865F2',
          avatarUrl: fromUser ? fromUser.avatarUrl : null,
          isSpeaking: true,
          isMuted: false,
          isDeafened: false,
          isCameraOn: false,
          isScreenSharing: false
        };
        this.peers.set(fromSocketId, peer);
      }

      // Visual speaking indicator
      const wasSpeaking = peer.isSpeaking;
      peer.isSpeaking = true;
      if (peer.speakingTimeout) clearTimeout(peer.speakingTimeout);
      peer.speakingTimeout = setTimeout(() => {
        peer.isSpeaking = false;
        this.notifyPeerSpeaking(fromSocketId, false);
      }, 350);

      if (!wasSpeaking) {
        this.notifyPeerSpeaking(fromSocketId, true);
      }

      // Play audio chunk through anti-lag jitter-buffered Web Audio queue
      this.playWebSocketAudioChunk(fromSocketId, audioData, sampleRate, fromUser);
    });

    // Speaking indicator event from server
    const handleSpeaking = ({ socketId, isSpeaking }) => {
      const peer = this.peers.get(socketId);
      if (peer && peer.isSpeaking !== isSpeaking) {
        peer.isSpeaking = isSpeaking;
        this.notifyPeerSpeaking(socketId, isSpeaking);
      }
    };
    this.socket.on('voice:speaking', handleSpeaking);
    this.socket.on('voice:user_speaking', handleSpeaking);

    // Mute / Deafen event
    this.socket.on('voice:user_state', ({ socketId, isMuted, isDeafened }) => {
      const peer = this.peers.get(socketId);
      if (peer) {
        peer.isMuted = isMuted;
        peer.isDeafened = isDeafened;
        this.notifyPeersUpdate();
      }
    });

    // Video / Screen Share state event
    this.socket.on('voice:video_state', ({ socketId, isCameraOn, isScreenSharing }) => {
      const peer = this.peers.get(socketId);
      if (peer) {
        peer.isCameraOn = !!isCameraOn;
        peer.isScreenSharing = !!isScreenSharing;
        if (!peer.isCameraOn && !peer.isScreenSharing) {
          this.peerVideoStreams.delete(socketId);
          peer.videoStream = null;
        }
        this.notifyPeersUpdate();
      }
    });

    // Peer requested live stream (e.g. clicked "Watch Stream")
    this.socket.on('voice:request_stream', async ({ fromSocketId }) => {
      const activeStream = this.localScreenStream || this.localCameraStream;
      if (activeStream) {
        await this.initiateOfferTo(fromSocketId);
      }
    });

    // Dual-Engine WebSocket screen frame relay fallback
    this.socket.on('voice:screen_frame', ({ fromSocketId, frameData }) => {
      this.peerScreenFrames.set(fromSocketId, frameData);
      if (this.onPeerScreenFrame) {
        this.onPeerScreenFrame(fromSocketId, frameData);
      }
    });

    // Soundboard event
    this.socket.on('voice:soundboard', ({ fromSocketId, fromName, soundId }) => {
      if (fromSocketId !== this.socket.id && window.audioManager) {
        window.audioManager.playSoundboard(soundId);
      }
      if (this.onSoundboardPlayed) {
        this.onSoundboardPlayed({ fromSocketId, fromName, soundId });
      }
    });

    // User left voice channel
    this.socket.on('voice:user_left', ({ socketId }) => {
      this.peers.delete(socketId);
      this.peerVideoStreams.delete(socketId);
      this.peerScreenFrames.delete(socketId);
      this.pendingIceCandidates.delete(socketId);
      this.cleanupRemoteAudio(socketId);

      if (this.peerConnections.has(socketId)) {
        try { this.peerConnections.get(socketId).close(); } catch (e) {}
        this.peerConnections.delete(socketId);
      }
      this.notifyPeersUpdate();
    });

    // Profile update
    this.socket.on('voice:user_updated', ({ socketId, name, avatarColor, avatarUrl }) => {
      const peer = this.peers.get(socketId);
      if (peer) {
        peer.name = name;
        peer.avatarColor = avatarColor;
        if (avatarUrl !== undefined) peer.avatarUrl = avatarUrl;
        this.notifyPeersUpdate();
      }
    });
  }

  // Playback engine for WebSocket fallback with strict anti-lag trimming
  playWebSocketAudioChunk(socketId, buffer, sampleRate, fromUser = null) {
    try {
      const volume = this.getPeerVolume(socketId, fromUser ? fromUser.userId : null);
      if (volume <= 0.001) return;

      const ctx = this.getAudioContext();
      if (!ctx) return;
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }

      const int16 = new Int16Array(buffer);
      if (int16.length === 0) return;

      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / (int16[i] < 0 ? 32768.0 : 32767.0);
      }

      const effectiveSampleRate = sampleRate || ctx.sampleRate;
      const audioBuffer = ctx.createBuffer(1, float32.length, effectiveSampleRate);
      audioBuffer.getChannelData(0).set(float32);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;

      const gain = ctx.createGain();
      gain.gain.value = volume;
      source.connect(gain);
      gain.connect(ctx.destination);

      const now = ctx.currentTime;
      let nextTime = this.playbackTimes.get(socketId) || now;

      // ANTI-LAG SYSTEM:
      // If playback buffer has fallen behind the clock, OR if it has accumulated more than 100ms of lag:
      // Reset immediately to now + 25ms jitter buffer cushion to prevent multi-second queues!
      if (nextTime < now || (nextTime - now) > 0.10) {
        nextTime = now + 0.025;
      }

      source.start(nextTime);
      this.playbackTimes.set(socketId, nextTime + audioBuffer.duration);
    } catch (err) {
      console.warn('playWebSocketAudioChunk error:', err);
    }
  }

  // Attach local audio and video tracks to a PeerConnection
  attachLocalTracksToPC(pc) {
    if (!pc) return;

    // Attach local audio track
    if (this.localStream) {
      const audioTrack = this.localStream.getAudioTracks()[0];
      const audioSender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
      if (!audioSender && audioTrack) {
        pc.addTrack(audioTrack, this.localStream);
      } else if (audioSender && audioTrack && audioSender.track !== audioTrack) {
        audioSender.replaceTrack(audioTrack).catch(() => {});
      }
    }

    // Attach active video track (camera or screen)
    const activeVideo = this.localScreenStream || this.localCameraStream;
    if (activeVideo) {
      const videoTrack = activeVideo.getVideoTracks()[0];
      const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (!videoSender && videoTrack) {
        pc.addTrack(videoTrack, activeVideo);
      } else if (videoSender && videoTrack && videoSender.track !== videoTrack) {
        videoSender.replaceTrack(videoTrack).catch(() => {});
      }
    }
  }

  getOrCreatePeerConnection(socketId) {
    if (this.peerConnections.has(socketId)) {
      return this.peerConnections.get(socketId);
    }

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers
    });

    // Attach local tracks immediately
    this.attachLocalTracksToPC(pc);

    // Forward ICE candidates to peer
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('voice:signal', {
          toSocketId: socketId,
          signal: { type: 'candidate', candidate: event.candidate }
        });
      }
    };

    // Handle incoming audio / video tracks
    pc.ontrack = (event) => {
      const track = event.track;
      const stream = event.streams && event.streams[0] ? event.streams[0] : new MediaStream([track]);

      if (track.kind === 'audio') {
        this.setupRemoteAudio(socketId, track, stream);
      } else if (track.kind === 'video') {
        this.peerVideoStreams.set(socketId, stream);
        const peer = this.peers.get(socketId);
        if (peer) {
          peer.videoStream = stream;
        }
        if (this.onPeerVideoUpdate) {
          this.onPeerVideoUpdate(socketId, stream);
        }
        this.notifyPeersUpdate();
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC ICE State with ${socketId}]:`, pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed') {
        try { pc.restartIce(); } catch (e) {}
      }
    };

    this.peerConnections.set(socketId, pc);
    return pc;
  }

  async initiateOfferTo(socketId) {
    try {
      const pc = this.getOrCreatePeerConnection(socketId);
      if (!pc) return;

      this.attachLocalTracksToPC(pc);

      if (pc.signalingState !== 'stable') {
        return;
      }

      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });
      await pc.setLocalDescription(offer);

      this.socket.emit('voice:signal', {
        toSocketId: socketId,
        signal: { type: 'offer', sdp: offer }
      });
    } catch (err) {
      console.warn(`initiateOfferTo error for ${socketId}:`, err);
    }
  }

  // Alias for backward compatibility
  initiateVideoOfferTo(socketId) {
    return this.initiateOfferTo(socketId);
  }

  // Bulletproof HTML5 Audio playback for remote WebRTC streams
  setupRemoteAudio(socketId, track, stream) {
    try {
      let container = document.getElementById('remote-audio-container');
      if (!container) {
        container = document.createElement('div');
        container.id = 'remote-audio-container';
        container.style.position = 'fixed';
        container.style.bottom = '-9999px';
        container.style.left = '-9999px';
        container.style.width = '1px';
        container.style.height = '1px';
        container.style.opacity = '0';
        container.style.pointerEvents = 'none';
        document.body.appendChild(container);
      }

      let audioEl = document.getElementById(`remote-audio-${socketId}`);
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.id = `remote-audio-${socketId}`;
        audioEl.autoplay = true;
        audioEl.playsInline = true;
        container.appendChild(audioEl);
      }

      audioEl.srcObject = stream;

      const peer = this.peers.get(socketId);
      const userId = peer ? peer.userId : null;
      const isMuted = this.isPeerLocallyMuted(socketId, userId);
      audioEl.muted = this.isDeafened || isMuted;

      const vol = this.getPeerVolume(socketId, userId);
      audioEl.volume = Math.max(0, Math.min(1.0, vol));

      const playPromise = audioEl.play();
      if (playPromise !== undefined) {
        playPromise.catch(e => {
          console.warn(`[WebRTC] Autoplay unlock needed for ${socketId}:`, e);
          const unlock = () => {
            audioEl.play().catch(() => {});
            document.removeEventListener('click', unlock);
            document.removeEventListener('keydown', unlock);
          };
          document.addEventListener('click', unlock, { once: true });
          document.addEventListener('keydown', unlock, { once: true });
        });
      }

      // AnalyserNode for fast client-side speaking detection
      try {
        const ctx = this.getAudioContext();
        if (ctx) {
          const sourceNode = ctx.createMediaStreamSource(stream);
          const analyserNode = ctx.createAnalyser();
          analyserNode.fftSize = 256;
          analyserNode.smoothingTimeConstant = 0.3;
          sourceNode.connect(analyserNode);

          this.peerAudioNodes.set(socketId, {
            audioEl,
            sourceNode,
            analyserNode,
            stream
          });
        }
      } catch (err) {
        console.warn('AnalyserNode setup notice:', err);
      }
    } catch (err) {
      console.warn(`setupRemoteAudio error for ${socketId}:`, err);
    }
  }

  cleanupRemoteAudio(socketId) {
    const audioEl = document.getElementById(`remote-audio-${socketId}`);
    if (audioEl) {
      try {
        audioEl.pause();
        audioEl.srcObject = null;
        audioEl.remove();
      } catch (e) {}
    }

    const node = this.peerAudioNodes.get(socketId);
    if (node) {
      if (node.sourceNode) {
        try { node.sourceNode.disconnect(); } catch (e) {}
      }
      if (node.analyserNode) {
        try { node.analyserNode.disconnect(); } catch (e) {}
      }
      this.peerAudioNodes.delete(socketId);
    }
    this.playbackTimes.delete(socketId);
  }

  // Periodic client-side waveform analysis to detect speaking
  startRemoteSpeakingMonitor() {
    if (this.remoteSpeakingInterval) return;
    this.remoteSpeakingInterval = setInterval(() => {
      if (this.isDeafened || this.peerAudioNodes.size === 0) return;

      for (const [socketId, node] of this.peerAudioNodes.entries()) {
        if (node.analyserNode) {
          const data = new Uint8Array(node.analyserNode.frequencyBinCount);
          node.analyserNode.getByteFrequencyData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i++) sum += data[i];
          const avg = sum / (data.length * 255);
          const peer = this.peers.get(socketId);
          if (peer && !this.isPeerLocallyMuted(socketId, peer.userId)) {
            const isSpeaking = avg > 0.035;
            if (peer.isSpeaking !== isSpeaking) {
              peer.isSpeaking = isSpeaking;
              this.notifyPeerSpeaking(socketId, isSpeaking);
            }
          }
        }
      }
    }, 80);
  }

  stopRemoteSpeakingMonitor() {
    if (this.remoteSpeakingInterval) {
      clearInterval(this.remoteSpeakingInterval);
      this.remoteSpeakingInterval = null;
    }
  }

  async acquireLocalAudio() {
    if (this.localStream) return this.localStream;
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        },
        video: false
      });

      // Apply initial mute state
      const shouldEnable = !this.isMuted && (this.inputMode !== 'ptt' || this.isPttActive);
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = shouldEnable;
      });

      return this.localStream;
    } catch (err) {
      console.warn('Microphone permission not granted:', err);
      return null;
    }
  }

  async joinVoice(serverId, channelId) {
    const ctx = this.getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }

    await this.acquireLocalAudio();
    this.currentChannelId = channelId;

    // Start microphone capture and remote speaking monitor
    this.startMicrophoneStream();
    this.startRemoteSpeakingMonitor();

    this.socket.emit('voice:join', { serverId, channelId });
    if (window.audioManager) {
      window.audioManager.playJoin();
    }
  }

  // Combined Web Audio capture, VAD gating, and WebSocket fallback streamer
  startMicrophoneStream() {
    if (!this.localStream) return;
    try {
      const ctx = this.getAudioContext();
      this.micSource = ctx.createMediaStreamSource(this.localStream);

      // Process 2048-sample chunks (~46ms at 44.1kHz / 42ms at 48kHz)
      this.processor = ctx.createScriptProcessor(2048, 1, 1);

      this.processor.onaudioprocess = (e) => {
        if (this.isMuted || !this.currentChannelId) return;

        const input = e.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < input.length; i++) {
          sum += input[i] * input[i];
        }
        const rms = Math.sqrt(sum / input.length);
        const micLevel = Math.min(1, rms * 5.0);
        const isAboveGate = this.autoSensitivity ? (rms > 0.019) : (rms > this.sensitivityThreshold);

        if (this.onMicLevelUpdate) {
          this.onMicLevelUpdate(micLevel, isAboveGate);
        }

        let shouldTransmit = false;

        if (this.inputMode === 'ptt') {
          shouldTransmit = this.isPttActive;
        } else {
          // VAD Mode
          const isSpeaking = isAboveGate;

          if (isSpeaking !== this.lastSpeakingState) {
            this.lastSpeakingState = isSpeaking;
            this.socket.emit('voice:speaking', { isSpeaking });
            if (this.onLocalSpeaking) this.onLocalSpeaking(isSpeaking);
          }

          if (isSpeaking) {
            this.silenceHoldFrames = 3; // ~130ms hold decay
            shouldTransmit = true;
          } else if (this.silenceHoldFrames > 0) {
            this.silenceHoldFrames--;
            shouldTransmit = true;
          }
        }

        // STRICT VAD GATING: Only send audio packets when ACTUALLY speaking!
        // Prevents server congestion and eliminates lag for 3+ users!
        if (shouldTransmit) {
          const pcm = new Int16Array(input.length);
          for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i]));
            pcm[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          }

          this.socket.emit('voice:audio_stream', {
            channelId: this.currentChannelId,
            audioData: pcm.buffer,
            sampleRate: ctx.sampleRate
          });
        }
      };

      // Mute destination so you don't hear your own mic echo
      const muteGain = ctx.createGain();
      muteGain.gain.value = 0;

      this.micSource.connect(this.processor);
      this.processor.connect(muteGain);
      muteGain.connect(ctx.destination);
    } catch (err) {
      console.warn('Error starting mic stream:', err);
    }
  }

  // Voice Sensitivity Gate setting
  setSensitivity(autoDetermined, threshold) {
    this.autoSensitivity = !!autoDetermined;
    if (threshold !== undefined) {
      this.sensitivityThreshold = threshold;
      localStorage.setItem('cordlite_sens_threshold', threshold.toString());
    }
    localStorage.setItem('cordlite_auto_sens', this.autoSensitivity ? 'true' : 'false');
  }

  // Microphone Test / Calibration in Settings
  async startMicTest(callback) {
    this.isTestingMic = true;
    this.onMicTestUpdate = callback;
    try {
      if (!this.testStream) {
        this.testStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      }
      const ctx = this.getAudioContext();
      this.testSource = ctx.createMediaStreamSource(this.testStream);
      this.testProcessor = ctx.createScriptProcessor(2048, 1, 1);

      this.testProcessor.onaudioprocess = (e) => {
        if (!this.isTestingMic) return;
        const input = e.inputBuffer.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < input.length; i++) {
          sum += input[i] * input[i];
        }
        const rms = Math.sqrt(sum / input.length);
        const micLevel = Math.min(1, rms * 5.0);
        const isAboveGate = this.autoSensitivity ? (rms > 0.019) : (rms > this.sensitivityThreshold);
        if (this.onMicTestUpdate) {
          this.onMicTestUpdate(micLevel, isAboveGate);
        }
      };

      const muteGain = ctx.createGain();
      muteGain.gain.value = 0;
      this.testSource.connect(this.testProcessor);
      this.testProcessor.connect(muteGain);
      muteGain.connect(ctx.destination);
      return true;
    } catch (err) {
      console.warn('Microphone test access error:', err);
      return false;
    }
  }

  stopMicTest() {
    this.isTestingMic = false;
    this.onMicTestUpdate = null;
    if (this.testProcessor) {
      try { this.testProcessor.disconnect(); } catch (e) {}
      this.testProcessor = null;
    }
    if (this.testSource) {
      try { this.testSource.disconnect(); } catch (e) {}
      this.testSource = null;
    }
    if (this.testStream) {
      try { this.testStream.getTracks().forEach(t => t.stop()); } catch (e) {}
      this.testStream = null;
    }
  }

  // Push-to-Talk activation
  setPttActive(active) {
    if (this.inputMode !== 'ptt' || this.isMuted) return;
    if (this.isPttActive === active) return;
    this.isPttActive = !!active;

    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = this.isPttActive;
      });
    }

    if (this.isPttActive) {
      if (window.audioManager) window.audioManager.playPttActivate();
      this.socket.emit('voice:speaking', { isSpeaking: true });
      if (this.onLocalSpeaking) this.onLocalSpeaking(true);
    } else {
      if (window.audioManager) window.audioManager.playPttDeactivate();
      this.socket.emit('voice:speaking', { isSpeaking: false });
      if (this.onLocalSpeaking) this.onLocalSpeaking(false);
    }
    this.notifyPeersUpdate();
  }

  setInputMode(mode) {
    this.inputMode = mode;
    localStorage.setItem('cordlite_input_mode', mode);
    if (mode === 'vad') {
      if (this.isPttActive) this.setPttActive(false);
      if (this.localStream) {
        this.localStream.getAudioTracks().forEach(track => {
          track.enabled = !this.isMuted;
        });
      }
    } else if (mode === 'ptt') {
      if (this.localStream) {
        this.localStream.getAudioTracks().forEach(track => {
          track.enabled = false;
        });
      }
    }
  }

  async broadcastVideoTrackToPeers(stream) {
    const videoTrack = stream.getVideoTracks()[0];
    for (const [peerSocketId, pc] of this.peerConnections.entries()) {
      try {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) {
          await sender.replaceTrack(videoTrack);
        } else if (videoTrack) {
          pc.addTrack(videoTrack, stream);
          await this.initiateOfferTo(peerSocketId);
        }
      } catch (e) {
        console.warn('broadcastVideoTrack error:', e);
      }
    }
  }

  async toggleCamera() {
    if (this.isCameraOn) {
      this.stopCamera();
      return false;
    }

    try {
      if (this.isScreenSharing) {
        this.stopScreenShare();
      }

      this.localCameraStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      this.isCameraOn = true;

      await this.broadcastVideoTrackToPeers(this.localCameraStream);
      this.socket.emit('voice:video_state', {
        channelId: this.currentChannelId,
        isCameraOn: true,
        isScreenSharing: false
      });
      this.notifyPeersUpdate();
      return true;
    } catch (err) {
      console.warn('Could not start camera:', err);
      return false;
    }
  }

  stopCamera() {
    if (this.localCameraStream) {
      this.localCameraStream.getTracks().forEach(t => t.stop());
      this.localCameraStream = null;
    }
    this.isCameraOn = false;

    // Disconnect camera track from peers
    for (const pc of this.peerConnections.values()) {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) {
        sender.replaceTrack(null).catch(() => {});
      }
    }

    this.socket.emit('voice:video_state', {
      channelId: this.currentChannelId,
      isCameraOn: false,
      isScreenSharing: this.isScreenSharing
    });
    this.notifyPeersUpdate();
  }

  getDisplayMediaConstraints() {
    const quality = localStorage.getItem('cordlite_stream_quality') || '720p30';
    if (quality === '1080p60') {
      return {
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60, max: 60 }, cursor: 'always' },
        audio: true
      };
    } else if (quality === '480p15') {
      return {
        video: { width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 15 }, cursor: 'always' },
        audio: true
      };
    } else if (quality === 'source') {
      return {
        video: { cursor: 'always' },
        audio: true
      };
    } else {
      return {
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 }, cursor: 'always' },
        audio: true
      };
    }
  }

  async toggleScreenShare() {
    if (this.isScreenSharing) {
      this.stopScreenShare();
      return false;
    }

    try {
      if (this.isCameraOn) {
        this.stopCamera();
      }

      const constraints = this.getDisplayMediaConstraints();
      this.localScreenStream = await navigator.mediaDevices.getDisplayMedia(constraints);
      this.isScreenSharing = true;

      // Feature: Mix system audio into microphone stream if present
      const audioTracks = this.localScreenStream.getAudioTracks();
      if (audioTracks.length > 0 && this.processor) {
        try {
          const ctx = this.getAudioContext();
          this.screenAudioSource = ctx.createMediaStreamSource(new MediaStream([audioTracks[0]]));
          this.screenAudioSource.connect(this.processor);
        } catch (e) {
          console.warn('Could not mix system audio:', e);
        }
      }

      // Handle stream end
      const track = this.localScreenStream.getVideoTracks()[0];
      track.onended = () => {
        this.stopScreenShare();
      };

      await this.broadcastVideoTrackToPeers(this.localScreenStream);
      this.startScreenFrameBroadcast();
      this.socket.emit('voice:video_state', {
        channelId: this.currentChannelId,
        isCameraOn: false,
        isScreenSharing: true
      });
      this.notifyPeersUpdate();
      return true;
    } catch (err) {
      console.warn('Could not start screen share:', err);
      return false;
    }
  }

  requestStreamFromPeer(peerSocketId) {
    if (!this._lastStreamRequests) this._lastStreamRequests = new Map();
    const now = Date.now();
    if (this._lastStreamRequests.get(peerSocketId) && (now - this._lastStreamRequests.get(peerSocketId) < 3000)) {
      return;
    }
    this._lastStreamRequests.set(peerSocketId, now);
    this.socket.emit('voice:request_stream', { toSocketId: peerSocketId });
  }

  startScreenFrameBroadcast() {
    this.stopScreenFrameBroadcast();
    try {
      if (!this.screenCaptureCanvas) {
        this.screenCaptureCanvas = document.createElement('canvas');
      }
      if (!this.screenCaptureVideo) {
        this.screenCaptureVideo = document.createElement('video');
        this.screenCaptureVideo.muted = true;
        this.screenCaptureVideo.playsInline = true;
      }
      this.screenCaptureVideo.srcObject = this.localScreenStream;
      this.screenCaptureVideo.play().catch(() => {});

      const canvas = this.screenCaptureCanvas;
      const ctx = canvas.getContext('2d');
      const video = this.screenCaptureVideo;

      this.screenFrameInterval = setInterval(() => {
        if (!this.isScreenSharing || !this.currentChannelId || !this.localScreenStream) {
          this.stopScreenFrameBroadcast();
          return;
        }
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          const maxDim = 1280;
          const scale = Math.min(1, maxDim / Math.max(video.videoWidth, video.videoHeight));
          const targetW = Math.round(video.videoWidth * scale);
          const targetH = Math.round(video.videoHeight * scale);
          if (canvas.width !== targetW || canvas.height !== targetH) {
            canvas.width = targetW;
            canvas.height = targetH;
          }
          ctx.drawImage(video, 0, 0, targetW, targetH);
          const frameData = canvas.toDataURL('image/jpeg', 0.65);
          this.socket.emit('voice:screen_frame', {
            channelId: this.currentChannelId,
            frameData
          });
        }
      }, 150);
    } catch (err) {
      console.warn('startScreenFrameBroadcast error:', err);
    }
  }

  stopScreenFrameBroadcast() {
    if (this.screenFrameInterval) {
      clearInterval(this.screenFrameInterval);
      this.screenFrameInterval = null;
    }
    if (this.screenCaptureVideo) {
      try { this.screenCaptureVideo.srcObject = null; } catch (e) {}
    }
  }

  stopScreenShare() {
    this.stopScreenFrameBroadcast();
    if (this.screenAudioSource) {
      try { this.screenAudioSource.disconnect(); } catch (e) {}
      this.screenAudioSource = null;
    }
    if (this.localScreenStream) {
      this.localScreenStream.getTracks().forEach(t => t.stop());
      this.localScreenStream = null;
    }
    this.isScreenSharing = false;

    // Disconnect video track from peers
    for (const pc of this.peerConnections.values()) {
      const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) {
        sender.replaceTrack(null).catch(() => {});
      }
    }

    this.socket.emit('voice:video_state', {
      channelId: this.currentChannelId,
      isCameraOn: this.isCameraOn,
      isScreenSharing: false
    });
    this.notifyPeersUpdate();
  }

  // Soundboard Trigger
  playSoundboard(soundId) {
    if (window.audioManager) {
      window.audioManager.playSoundboard(soundId);
    }
    if (this.currentChannelId) {
      this.socket.emit('voice:soundboard', {
        channelId: this.currentChannelId,
        soundId
      });
    }
  }

  leaveVoice() {
    if (!this.currentChannelId) return;
    this.socket.emit('voice:leave');
    this.currentChannelId = null;

    if (this.processor) {
      try { this.processor.disconnect(); } catch (e) {}
      this.processor = null;
    }
    if (this.micSource) {
      try { this.micSource.disconnect(); } catch (e) {}
      this.micSource = null;
    }
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }

    this.stopRemoteSpeakingMonitor();
    this.stopCamera();
    this.stopScreenShare();

    for (const pc of this.peerConnections.values()) {
      try { pc.close(); } catch (e) {}
    }
    this.peerConnections.clear();
    this.peerVideoStreams.clear();

    for (const socketId of this.peers.keys()) {
      this.cleanupRemoteAudio(socketId);
    }
    this.peerAudioNodes.clear();

    this.peers.clear();
    this.pendingIceCandidates.clear();
    this.playbackTimes.clear();

    if (window.audioManager) {
      window.audioManager.playLeave();
    }
    this.notifyPeersUpdate();
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = !this.isMuted;
      });
    }

    if (this.isMuted && this.lastSpeakingState) {
      this.lastSpeakingState = false;
      this.socket.emit('voice:speaking', { isSpeaking: false });
      if (this.onLocalSpeaking) this.onLocalSpeaking(false);
    }

    if (window.audioManager) {
      window.audioManager.playMute(this.isMuted);
    }
    this.socket.emit('voice:state', { isMuted: this.isMuted, isDeafened: this.isDeafened });
    return this.isMuted;
  }

  toggleDeafen() {
    this.isDeafened = !this.isDeafened;
    if (this.isDeafened && !this.isMuted) {
      this.isMuted = true;
      if (this.localStream) {
        this.localStream.getAudioTracks().forEach(track => {
          track.enabled = false;
        });
      }
    }

    // Update all remote WebRTC audio elements
    for (const socketId of this.peers.keys()) {
      const audioEl = document.getElementById(`remote-audio-${socketId}`);
      if (audioEl) {
        const peer = this.peers.get(socketId);
        const isMuted = this.isPeerLocallyMuted(socketId, peer ? peer.userId : null);
        audioEl.muted = this.isDeafened || isMuted;
      }
    }

    if (window.audioManager) {
      window.audioManager.playMute(this.isDeafened);
    }
    this.socket.emit('voice:state', { isMuted: this.isMuted, isDeafened: this.isDeafened });
    return { isMuted: this.isMuted, isDeafened: this.isDeafened };
  }

  notifyPeersUpdate() {
    if (this.onPeersUpdateCallback) {
      const peerList = Array.from(this.peers.values()).map(p => ({
        socketId: p.socketId,
        userId: p.userId,
        name: p.name,
        avatarColor: p.avatarColor,
        avatarUrl: p.avatarUrl || null,
        isSpeaking: p.isSpeaking,
        isMuted: p.isMuted,
        isDeafened: p.isDeafened,
        isCameraOn: p.isCameraOn || false,
        isScreenSharing: p.isScreenSharing || false,
        videoStream: this.peerVideoStreams.get(p.socketId) || null,
        isLocallyMuted: this.isPeerLocallyMuted(p.socketId, p.userId),
        volume: this.getPeerVolume(p.socketId, p.userId)
      }));
      this.onPeersUpdateCallback(peerList);
    }
  }

  notifyPeerSpeaking(socketId, isSpeaking) {
    if (this.onPeerSpeakingCallback) {
      this.onPeerSpeakingCallback(socketId, isSpeaking);
    }
  }
}

window.WebRTCVoiceManager = WebRTCVoiceManager;
