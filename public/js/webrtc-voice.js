/**
 * VoiceEngine - Direct WebRTC P2P Voice Mesh + WebRTC Video & Screen Sharing
 * High-performance, low-latency UDP voice communication with 0% server audio relay load
 */
class WebRTCVoiceManager {
  constructor(socket, user = null) {
    this.socket = socket;
    this.user = user;
    this.localStream = null;
    this.audioCtx = null;
    this.micSource = null;
    this.micAnalyser = null;
    this.vadInterval = null;
    this.remoteSpeakingInterval = null;
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
    this.peerAudioNodes = new Map(); // socketId -> { audioEl, sourceNode, gainNode, analyserNode, stream }

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

    // Mic test state
    this.isTestingMic = false;
    this.onMicTestUpdate = null;
    this.testStream = null;
    this.testSource = null;
    this.testAnalyser = null;
    this.testInterval = null;

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

    // Apply immediately to Web Audio GainNode
    const node = this.peerAudioNodes.get(socketId);
    if (node && node.gainNode && this.audioCtx) {
      const isLocallyMuted = this.isPeerLocallyMuted(socketId, userId);
      const effectiveVol = (this.isDeafened || isLocallyMuted) ? 0 : vol;
      node.gainNode.gain.setValueAtTime(effectiveVol, this.audioCtx.currentTime);
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

    // Apply immediately to Web Audio GainNode
    const node = this.peerAudioNodes.get(socketId);
    if (node && node.gainNode && this.audioCtx) {
      const vol = this.getPeerVolume(socketId, userId);
      const effectiveVol = (this.isDeafened || nowMuted) ? 0 : vol;
      node.gainNode.gain.setValueAtTime(effectiveVol, this.audioCtx.currentTime);
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
      this.audioCtx.resume();
    }
    return this.audioCtx;
  }

  setPeersUpdateCallback(cb) {
    this.onPeersUpdateCallback = cb;
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
          // Ensure local tracks are attached before answering
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
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' }
      ]
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

  // Route remote WebRTC audio through Web Audio GainNode for volume & local mute control
  setupRemoteAudio(socketId, track, stream) {
    try {
      this.cleanupRemoteAudio(socketId);

      const ctx = this.getAudioContext();
      const audioStream = new MediaStream([track]);

      // Hidden audio element attached to stream to prevent Chromium background-tab garbage collection
      const audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      audioEl.muted = true; // Audio is routed to destination through Web Audio GainNode
      audioEl.srcObject = audioStream;
      audioEl.style.display = 'none';
      document.body.appendChild(audioEl);
      audioEl.play().catch(() => {});

      // Web Audio GainNode pipeline
      const sourceNode = ctx.createMediaStreamSource(audioStream);
      const gainNode = ctx.createGain();

      const peer = this.peers.get(socketId);
      const userId = peer ? peer.userId : null;
      const vol = this.getPeerVolume(socketId, userId);
      const isMuted = this.isPeerLocallyMuted(socketId, userId);
      gainNode.gain.value = (this.isDeafened || isMuted) ? 0 : vol;

      // AnalyserNode for ultra-fast remote speaking detection
      const analyserNode = ctx.createAnalyser();
      analyserNode.fftSize = 256;
      analyserNode.smoothingTimeConstant = 0.3;

      sourceNode.connect(analyserNode);
      analyserNode.connect(gainNode);
      gainNode.connect(ctx.destination);

      this.peerAudioNodes.set(socketId, {
        audioEl,
        sourceNode,
        gainNode,
        analyserNode,
        stream: audioStream
      });
    } catch (err) {
      console.warn(`setupRemoteAudio error for ${socketId}:`, err);
    }
  }

  cleanupRemoteAudio(socketId) {
    const node = this.peerAudioNodes.get(socketId);
    if (node) {
      if (node.audioEl) {
        try {
          node.audioEl.srcObject = null;
          node.audioEl.remove();
        } catch (e) {}
      }
      if (node.sourceNode) {
        try { node.sourceNode.disconnect(); } catch (e) {}
      }
      if (node.gainNode) {
        try { node.gainNode.disconnect(); } catch (e) {}
      }
      if (node.analyserNode) {
        try { node.analyserNode.disconnect(); } catch (e) {}
      }
      this.peerAudioNodes.delete(socketId);
    }
  }

  // Periodic client-side waveform analysis to detect speaking without network overhead
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
      await ctx.resume();
    }

    await this.acquireLocalAudio();
    this.currentChannelId = channelId;

    // Start local VAD / mic monitoring and remote speaking detection
    this.startVADMonitoring();
    this.startRemoteSpeakingMonitor();

    this.socket.emit('voice:join', { serverId, channelId });
    if (window.audioManager) {
      window.audioManager.playJoin();
    }
  }

  // Non-blocking AnalyserNode based mic metering & Voice Activity Detection
  startVADMonitoring() {
    this.stopVADMonitoring();
    if (!this.localStream) return;

    try {
      const ctx = this.getAudioContext();
      this.micSource = ctx.createMediaStreamSource(this.localStream);
      this.micAnalyser = ctx.createAnalyser();
      this.micAnalyser.fftSize = 512;
      this.micAnalyser.smoothingTimeConstant = 0.3;
      this.micSource.connect(this.micAnalyser);

      this.vadInterval = setInterval(() => {
        if (!this.micAnalyser || !this.currentChannelId) return;

        const data = new Uint8Array(this.micAnalyser.frequencyBinCount);
        this.micAnalyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / (data.length * 255); // 0.0 to 1.0

        const micLevel = Math.min(1, avg * 4.5);
        const isAboveGate = this.autoSensitivity ? (avg > 0.018) : (avg > this.sensitivityThreshold);

        if (this.onMicLevelUpdate) {
          this.onMicLevelUpdate(micLevel, isAboveGate);
        }

        if (this.isMuted) {
          if (this.lastSpeakingState) {
            this.lastSpeakingState = false;
            this.socket.emit('voice:speaking', { isSpeaking: false });
            if (this.onLocalSpeaking) this.onLocalSpeaking(false);
          }
          return;
        }

        if (this.inputMode === 'ptt') {
          // In PTT mode, speaking state is controlled by setPttActive
          return;
        }

        // VAD Mode: Apply silence hold frames (~280ms) to prevent clipping between words
        let isSpeaking = isAboveGate;
        if (isSpeaking) {
          this.silenceHoldFrames = 4;
        } else if (this.silenceHoldFrames > 0) {
          this.silenceHoldFrames--;
          isSpeaking = true;
        }

        if (isSpeaking !== this.lastSpeakingState) {
          this.lastSpeakingState = isSpeaking;
          this.socket.emit('voice:speaking', { isSpeaking });
          if (this.onLocalSpeaking) this.onLocalSpeaking(isSpeaking);
        }
      }, 70);
    } catch (err) {
      console.warn('VAD Monitoring error:', err);
    }
  }

  stopVADMonitoring() {
    if (this.vadInterval) {
      clearInterval(this.vadInterval);
      this.vadInterval = null;
    }
    if (this.micAnalyser) {
      try { this.micAnalyser.disconnect(); } catch (e) {}
      this.micAnalyser = null;
    }
    if (this.micSource) {
      try { this.micSource.disconnect(); } catch (e) {}
      this.micSource = null;
    }
    if (this.lastSpeakingState) {
      this.lastSpeakingState = false;
      if (this.onLocalSpeaking) this.onLocalSpeaking(false);
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

  // Microphone Test / Calibration
  async startMicTest(callback) {
    this.isTestingMic = true;
    this.onMicTestUpdate = callback;
    try {
      if (!this.testStream) {
        this.testStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      }
      const ctx = this.getAudioContext();
      this.testSource = ctx.createMediaStreamSource(this.testStream);
      this.testAnalyser = ctx.createAnalyser();
      this.testAnalyser.fftSize = 512;
      this.testAnalyser.smoothingTimeConstant = 0.3;
      this.testSource.connect(this.testAnalyser);

      this.testInterval = setInterval(() => {
        if (!this.isTestingMic || !this.testAnalyser) return;
        const data = new Uint8Array(this.testAnalyser.frequencyBinCount);
        this.testAnalyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const avg = sum / (data.length * 255);
        const micLevel = Math.min(1, avg * 4.5);
        const isAboveGate = this.autoSensitivity ? (avg > 0.018) : (avg > this.sensitivityThreshold);
        if (this.onMicTestUpdate) {
          this.onMicTestUpdate(micLevel, isAboveGate);
        }
      }, 70);
      return true;
    } catch (err) {
      console.warn('Microphone test access error:', err);
      return false;
    }
  }

  stopMicTest() {
    this.isTestingMic = false;
    this.onMicTestUpdate = null;
    if (this.testInterval) {
      clearInterval(this.testInterval);
      this.testInterval = null;
    }
    if (this.testAnalyser) {
      try { this.testAnalyser.disconnect(); } catch (e) {}
      this.testAnalyser = null;
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
      // 720p30 standard
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
      return; // Throttled to prevent renegotiation hammering
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

    this.stopVADMonitoring();
    this.stopRemoteSpeakingMonitor();

    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
      this.localStream = null;
    }

    this.stopCamera();
    this.stopScreenShare();

    for (const pc of this.peerConnections.values()) {
      try { pc.close(); } catch (e) {}
    }
    this.peerConnections.clear();
    this.peerVideoStreams.clear();

    for (const socketId of this.peerAudioNodes.keys()) {
      this.cleanupRemoteAudio(socketId);
    }
    this.peerAudioNodes.clear();

    this.peers.clear();
    this.pendingIceCandidates.clear();

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

    // Apply mute/unmute to all remote peer GainNodes
    const ctx = this.getAudioContext();
    for (const [peerSocketId, node] of this.peerAudioNodes.entries()) {
      if (node && node.gainNode && ctx) {
        const peer = this.peers.get(peerSocketId);
        const userId = peer ? peer.userId : null;
        const vol = this.getPeerVolume(peerSocketId, userId);
        const effectiveVol = this.isDeafened ? 0 : vol;
        node.gainNode.gain.setValueAtTime(effectiveVol, ctx.currentTime);
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
