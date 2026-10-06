/**
 * VoiceEngine - Direct WebSocket Audio Relay + WebRTC Video & Screen Sharing
 * 100% firewall-piercing audio + WebRTC peer video streaming
 */
class WebRTCVoiceManager {
  constructor(socket, user = null) {
    this.socket = socket;
    this.user = user;
    this.localStream = null;
    this.audioCtx = null;
    this.micSource = null;
    this.processor = null;
    this.gainNode = null;
    this.currentChannelId = null;

    this.isMuted = false;
    this.isDeafened = false;
    this.lastSpeakingState = false;
    this.silenceHoldFrames = 0;

    // Feature 2: Push-to-Talk (PTT)
    this.inputMode = localStorage.getItem('cordlite_input_mode') || 'vad'; // 'vad' or 'ptt'
    this.pttKey = localStorage.getItem('cordlite_ptt_key') || 'Space';
    this.isPttActive = false;

    // Feature 3: Voice Input Sensitivity Gate & Mic Level
    this.autoSensitivity = localStorage.getItem('cordlite_auto_sens') !== 'false';
    this.sensitivityThreshold = parseFloat(localStorage.getItem('cordlite_sens_threshold') || '0.02');
    this.onMicLevelUpdate = null;

    // Feature 1: Video & Screen Sharing
    this.isCameraOn = false;
    this.isScreenSharing = false;
    this.localCameraStream = null;
    this.localScreenStream = null;
    this.peerConnections = new Map(); // socketId -> RTCPeerConnection
    this.peerVideoStreams = new Map(); // socketId -> MediaStream

    // Local mute and volume control for peers (Discord style)
    this.peerVolumes = new Map(); // (socketId/userId) -> volume (0.0 to 1.5)
    this.locallyMutedUsers = new Set(); // Set of socketIds/userIds muted locally

    // socketId -> { socketId, userId, name, avatarColor, avatarUrl, isSpeaking, isMuted, isDeafened, isCameraOn, isScreenSharing }
    this.peers = new Map();
    // socketId -> next scheduled playback time
    this.playbackTimes = new Map();

    this.onPeersUpdateCallback = null;
    this.onLocalSpeaking = null;
    this.onPeerSpeakingCallback = null;
    this.onPeerVideoUpdate = null;
    this.onPeerScreenFrame = null;
    this.onSoundboardPlayed = null;

    // Dual-Engine Fallback for Screen Sharing
    this.peerScreenFrames = new Map(); // socketId -> frame data URL
    this.pendingIceCandidates = new Map(); // socketId -> [candidates]
    this._lastStreamRequests = new Map(); // socketId -> timestamp
    this.screenFrameInterval = null;
    this.screenCaptureVideo = null;
    this.screenCaptureCanvas = null;

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
    this.notifyPeersUpdate();
  }

  toggleMutePeer(socketId, userId) {
    const isMuted = this.isPeerLocallyMuted(socketId, userId);
    if (isMuted) {
      if (socketId) this.locallyMutedUsers.delete(socketId);
      if (userId) this.locallyMutedUsers.delete(userId);
      const curr = this.getPeerVolume(socketId, userId);
      if (curr <= 0.01) {
        if (socketId) this.peerVolumes.set(socketId, 1.0);
        if (userId) this.peerVolumes.set(userId, 1.0);
      }
      this.notifyPeersUpdate();
      return false; // now unmuted
    } else {
      if (socketId) this.locallyMutedUsers.add(socketId);
      if (userId) this.locallyMutedUsers.add(userId);
      this.notifyPeersUpdate();
      return true; // now muted
    }
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
          isSpeaking: false,
          isMuted: peer.isMuted || false,
          isDeafened: peer.isDeafened || false,
          isCameraOn: peer.isCameraOn || false,
          isScreenSharing: peer.isScreenSharing || false
        });
      });
      this.notifyPeersUpdate();
      // If we have an active video stream, negotiate with these existing peers
      if (this.isCameraOn || this.isScreenSharing) {
        peers.forEach(peer => this.initiateVideoOfferTo(peer.socketId));
      }
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
        isSpeaking: false,
        isMuted: peer.isMuted || false,
        isDeafened: peer.isDeafened || false,
        isCameraOn: peer.isCameraOn || false,
        isScreenSharing: peer.isScreenSharing || false
      });
      this.notifyPeersUpdate();
      // If we have an active video stream, initiate offer to newcomer
      if (this.isCameraOn || this.isScreenSharing) {
        this.initiateVideoOfferTo(peer.socketId);
      }
    });

    // Direct WebSocket audio stream chunk from a friend
    this.socket.on('voice:audio_stream', ({ fromSocketId, fromUser, audioData, sampleRate }) => {
      if (this.isDeafened) return;
      if (fromSocketId === this.socket.id) return;
      if (this.user && fromUser && fromUser.userId === this.user.userId) return;
      if (this.isPeerLocallyMuted(fromSocketId, fromUser ? fromUser.userId : null)) return;

      let peer = this.peers.get(fromSocketId);
      if (!peer) {
        peer = {
          socketId: fromSocketId,
          userId: fromUser.userId,
          name: fromUser.name || 'Friend',
          avatarColor: fromUser.avatarColor || '#5865F2',
          avatarUrl: fromUser.avatarUrl || null,
          isSpeaking: true,
          isMuted: false,
          isDeafened: false,
          isCameraOn: false,
          isScreenSharing: false
        };
        this.peers.set(fromSocketId, peer);
      }

      // Indicate speaking - only notify on state transition to prevent render thrashing
      const wasSpeaking = peer.isSpeaking;
      peer.isSpeaking = true;
      if (peer.speakingTimeout) clearTimeout(peer.speakingTimeout);
      peer.speakingTimeout = setTimeout(() => {
        peer.isSpeaking = false;
        this.notifyPeerSpeaking(fromSocketId, false);
      }, 400);

      if (!wasSpeaking) {
        this.notifyPeerSpeaking(fromSocketId, true);
      }

      // Play audio through Web Audio buffer queue
      this.playAudioChunk(fromSocketId, audioData, sampleRate, fromUser);
    });

    // Speaking indicator event
    this.socket.on('voice:speaking', ({ socketId, isSpeaking }) => {
      const peer = this.peers.get(socketId);
      if (peer && peer.isSpeaking !== isSpeaking) {
        peer.isSpeaking = isSpeaking;
        this.notifyPeerSpeaking(socketId, isSpeaking);
      }
    });

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
        }
        this.notifyPeersUpdate();
      }
    });

    // WebRTC Video Signaling (Offer / Answer / ICE Candidates) with Candidate Queuing
    this.socket.on('voice:video_signal', async ({ fromSocketId, signal }) => {
      try {
        const pc = this.getOrCreatePeerConnection(fromSocketId);
        if (signal.type === 'offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
          // Drain any queued ICE candidates for this peer
          const pending = this.pendingIceCandidates.get(fromSocketId) || [];
          for (const cand of pending) {
            try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (e) {}
          }
          this.pendingIceCandidates.delete(fromSocketId);

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.socket.emit('voice:video_signal', {
            toSocketId: fromSocketId,
            signal: { type: 'answer', sdp: answer }
          });
        } else if (signal.type === 'answer') {
          await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
          // Drain any queued ICE candidates for this peer
          const pending = this.pendingIceCandidates.get(fromSocketId) || [];
          for (const cand of pending) {
            try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch (e) {}
          }
          this.pendingIceCandidates.delete(fromSocketId);
        } else if (signal.type === 'candidate' && signal.candidate) {
          if (pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
          } else {
            // Queue candidate until remote description is set
            if (!this.pendingIceCandidates.has(fromSocketId)) {
              this.pendingIceCandidates.set(fromSocketId, []);
            }
            this.pendingIceCandidates.get(fromSocketId).push(signal.candidate);
          }
        }
      } catch (err) {
        console.warn('WebRTC video signal error:', err);
      }
    });

    // Feature 1: Peer requested live stream (e.g. clicked "Watch Stream")
    this.socket.on('voice:request_stream', async ({ fromSocketId }) => {
      if ((this.isScreenSharing && this.localScreenStream) || (this.isCameraOn && this.localCameraStream)) {
        await this.initiateVideoOfferTo(fromSocketId);
      }
    });

    // Feature 1: Dual-Engine WebSocket screen frame relay fallback
    this.socket.on('voice:screen_frame', ({ fromSocketId, frameData }) => {
      this.peerScreenFrames.set(fromSocketId, frameData);
      if (this.onPeerScreenFrame) {
        this.onPeerScreenFrame(fromSocketId, frameData);
      }
    });

    // Feature 4: Soundboard event
    this.socket.on('voice:soundboard', ({ fromSocketId, fromName, soundId }) => {
      if (fromSocketId !== this.socket.id) {
        window.audioManager.playSoundboard(soundId);
      }
      if (this.onSoundboardPlayed) {
        this.onSoundboardPlayed({ fromSocketId, fromName, soundId });
      }
    });

    // User left voice channel
    this.socket.on('voice:user_left', ({ socketId }) => {
      this.peers.delete(socketId);
      this.playbackTimes.delete(socketId);
      this.peerVideoStreams.delete(socketId);
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

  // Smooth jitter-buffered Web Audio playback
  playAudioChunk(socketId, buffer, sampleRate, fromUser = null) {
    try {
      const volume = this.getPeerVolume(socketId, fromUser ? fromUser.userId : null);
      if (volume <= 0.001) return; // Muted locally, drop audio chunk

      const ctx = this.getAudioContext();
      if (!ctx) return;

      const int16 = new Int16Array(buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / (int16[i] < 0 ? 32768.0 : 32767.0);
      }

      const audioBuffer = ctx.createBuffer(1, float32.length, sampleRate || ctx.sampleRate);
      audioBuffer.getChannelData(0).set(float32);

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;

      const gain = ctx.createGain();
      gain.gain.value = volume;
      source.connect(gain);
      gain.connect(ctx.destination);

      const now = ctx.currentTime;
      let nextTime = this.playbackTimes.get(socketId) || now;
      if (nextTime < now) {
        nextTime = now + 0.025; // 25ms jitter buffer
      }

      source.start(nextTime);
      this.playbackTimes.set(socketId, nextTime + audioBuffer.duration);
    } catch (err) {
      console.warn('Playback error:', err);
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
    this.startMicrophoneStream();

    this.socket.emit('voice:join', { serverId, channelId });
    window.audioManager.playJoin();
  }

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
        const micLevel = Math.min(1, rms * 5.5);
        const isAboveGate = this.autoSensitivity ? (rms > 0.018) : (rms > this.sensitivityThreshold);

        if (this.onMicLevelUpdate) {
          this.onMicLevelUpdate(micLevel, isAboveGate);
        }

        let shouldTransmit = false;

        if (this.inputMode === 'ptt') {
          // Feature 2: Push-to-Talk Mode
          shouldTransmit = this.isPttActive;
        } else {
          // Voice Activity Detection with Sensitivity Gate
          const isSpeaking = isAboveGate;

          if (isSpeaking !== this.lastSpeakingState) {
            this.lastSpeakingState = isSpeaking;
            this.socket.emit('voice:speaking', { isSpeaking });
            if (this.onLocalSpeaking) this.onLocalSpeaking(isSpeaking);
          }

          if (isSpeaking) {
            this.silenceHoldFrames = 4;
            shouldTransmit = true;
          } else if (this.silenceHoldFrames > 0) {
            this.silenceHoldFrames--;
            shouldTransmit = true;
          }
        }

        if (shouldTransmit) {
          // Convert to Int16 PCM to reduce transfer size
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
      console.error('Error starting mic stream:', err);
    }
  }

  // Feature 3: Set Voice Sensitivity Gate
  setSensitivity(autoDetermined, threshold) {
    this.autoSensitivity = !!autoDetermined;
    if (threshold !== undefined) {
      this.sensitivityThreshold = threshold;
      localStorage.setItem('cordlite_sens_threshold', threshold.toString());
    }
    localStorage.setItem('cordlite_auto_sens', this.autoSensitivity ? 'true' : 'false');
  }

  // Feature 3: Microphone Test / Calibration
  async startMicTest(callback) {
    this.isTestingMic = true;
    this.onMicTestUpdate = callback;
    if (this.localStream && this.processor) {
      return true;
    }
    try {
      this.testStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
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
        const micLevel = Math.min(1, rms * 5.5);
        const isAboveGate = this.autoSensitivity ? (rms > 0.018) : (rms > this.sensitivityThreshold);
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

  // Feature 2: Push-to-Talk activation
  setPttActive(active) {
    if (this.inputMode !== 'ptt' || this.isMuted) return;
    if (this.isPttActive === active) return;
    this.isPttActive = !!active;

    if (this.isPttActive) {
      window.audioManager.playPttActivate();
      this.socket.emit('voice:speaking', { isSpeaking: true });
      if (this.onLocalSpeaking) this.onLocalSpeaking(true);
    } else {
      window.audioManager.playPttDeactivate();
      this.socket.emit('voice:speaking', { isSpeaking: false });
      if (this.onLocalSpeaking) this.onLocalSpeaking(false);
    }
    this.notifyPeersUpdate();
  }

  setInputMode(mode) {
    this.inputMode = mode;
    localStorage.setItem('cordlite_input_mode', mode);
    if (mode === 'vad' && this.isPttActive) {
      this.setPttActive(false);
    }
  }

  // Feature 1: WebRTC Video & Screen Sharing Support
  getOrCreatePeerConnection(socketId) {
    if (this.peerConnections.has(socketId)) {
      return this.peerConnections.get(socketId);
    }

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' }
      ]
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('voice:video_signal', {
          toSocketId: socketId,
          signal: { type: 'candidate', candidate: event.candidate }
        });
      }
    };

    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        this.peerVideoStreams.set(socketId, event.streams[0]);
        if (this.onPeerVideoUpdate) {
          this.onPeerVideoUpdate(socketId, event.streams[0]);
        }
        this.notifyPeersUpdate();
      }
    };

    // Attach active local video track if any
    const activeStream = this.localScreenStream || this.localCameraStream;
    if (activeStream) {
      activeStream.getVideoTracks().forEach(track => {
        pc.addTrack(track, activeStream);
      });
    }

    this.peerConnections.set(socketId, pc);
    return pc;
  }

  async initiateVideoOfferTo(socketId) {
    try {
      const pc = this.getOrCreatePeerConnection(socketId);
      const activeStream = this.localScreenStream || this.localCameraStream;
      if (activeStream) {
        // Replace or add track safely
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        const track = activeStream.getVideoTracks()[0];
        if (sender && track) {
          if (sender.track !== track) {
            await sender.replaceTrack(track);
          }
        } else if (track) {
          pc.addTrack(track, activeStream);
        }
      }

      if (pc.signalingState !== 'stable') {
        // Connection negotiation already in progress, avoid colliding offers
        return;
      }

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.socket.emit('voice:video_signal', {
        toSocketId: socketId,
        signal: { type: 'offer', sdp: offer }
      });
    } catch (err) {
      console.warn('initiateVideoOfferTo error:', err);
    }
  }

  async broadcastVideoTrackToPeers(stream) {
    const videoTrack = stream.getVideoTracks()[0];
    for (const [peerSocketId, _] of this.peers.entries()) {
      try {
        const pc = this.getOrCreatePeerConnection(peerSocketId);
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) {
          await sender.replaceTrack(videoTrack);
        } else if (videoTrack) {
          pc.addTrack(videoTrack, stream);
        }
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        this.socket.emit('voice:video_signal', {
          toSocketId: peerSocketId,
          signal: { type: 'offer', sdp: offer }
        });
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

      // Feature: Mix System Audio into Web Audio pipeline
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
          // Only resize canvas if dimensions actually changed to avoid clearing buffer
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
    this.socket.emit('voice:video_state', {
      channelId: this.currentChannelId,
      isCameraOn: this.isCameraOn,
      isScreenSharing: false
    });
    this.notifyPeersUpdate();
  }

  // Feature 4: Soundboard Trigger
  playSoundboard(soundId) {
    window.audioManager.playSoundboard(soundId);
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

    this.stopCamera();
    this.stopScreenShare();

    for (const [_, pc] of this.peerConnections.entries()) {
      try { pc.close(); } catch (e) {}
    }
    this.peerConnections.clear();
    this.peerVideoStreams.clear();

    this.peers.clear();
    this.playbackTimes.clear();
    window.audioManager.playLeave();
    this.notifyPeersUpdate();
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = !this.isMuted;
      });
    }
    window.audioManager.playMute(this.isMuted);
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
    window.audioManager.playMute(this.isDeafened);
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
