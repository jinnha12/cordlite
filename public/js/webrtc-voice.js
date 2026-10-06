/**
 * VoiceEngine - Direct WebSocket Audio Relay with Web Audio API PCM streaming
 * 100% firewall-piercing, works across all mobile networks and Wi-Fis without STUN/TURN or cards!
 */
class WebRTCVoiceManager {
  constructor(socket) {
    this.socket = socket;
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

    // socketId -> { socketId, userId, name, avatarColor, isSpeaking, isMuted, isDeafened, speakingTimeout }
    this.peers = new Map();
    // socketId -> next scheduled playback time
    this.playbackTimes = new Map();

    this.onPeersUpdateCallback = null;
    this.setupSocketEvents();
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
          isSpeaking: false,
          isMuted: peer.isMuted || false,
          isDeafened: peer.isDeafened || false
        });
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
        isSpeaking: false,
        isMuted: peer.isMuted || false,
        isDeafened: peer.isDeafened || false
      });
      this.notifyPeersUpdate();
    });

    // Direct WebSocket audio stream chunk from a friend
    this.socket.on('voice:audio_stream', ({ fromSocketId, fromUser, audioData, sampleRate }) => {
      if (this.isDeafened) return;

      let peer = this.peers.get(fromSocketId);
      if (!peer) {
        peer = {
          socketId: fromSocketId,
          userId: fromUser.userId,
          name: fromUser.name || 'Friend',
          avatarColor: fromUser.avatarColor || '#5865F2',
          isSpeaking: true,
          isMuted: false,
          isDeafened: false
        };
        this.peers.set(fromSocketId, peer);
      }

      // Indicate speaking
      peer.isSpeaking = true;
      if (peer.speakingTimeout) clearTimeout(peer.speakingTimeout);
      peer.speakingTimeout = setTimeout(() => {
        peer.isSpeaking = false;
        this.notifyPeersUpdate();
      }, 350);
      this.notifyPeersUpdate();

      // Play audio through Web Audio buffer queue
      this.playAudioChunk(fromSocketId, audioData, sampleRate);
    });

    // Speaking indicator event
    this.socket.on('voice:user_speaking', ({ socketId, isSpeaking }) => {
      const peer = this.peers.get(socketId);
      if (peer) {
        peer.isSpeaking = isSpeaking;
        this.notifyPeersUpdate();
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

    // User left voice channel
    this.socket.on('voice:user_left', ({ socketId }) => {
      this.peers.delete(socketId);
      this.playbackTimes.delete(socketId);
      this.notifyPeersUpdate();
    });

    // Profile update
    this.socket.on('voice:user_updated', ({ socketId, name, avatarColor }) => {
      const peer = this.peers.get(socketId);
      if (peer) {
        peer.name = name;
        peer.avatarColor = avatarColor;
        this.notifyPeersUpdate();
      }
    });
  }

  // Smooth jitter-buffered Web Audio playback
  playAudioChunk(socketId, buffer, sampleRate) {
    try {
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
      gain.gain.value = 1.0;
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

        // Voice Activity Detection (RMS amplitude)
        let sum = 0;
        for (let i = 0; i < input.length; i++) {
          sum += input[i] * input[i];
        }
        const rms = Math.sqrt(sum / input.length);
        const isSpeaking = rms > 0.018;

        if (isSpeaking !== this.lastSpeakingState) {
          this.lastSpeakingState = isSpeaking;
          this.socket.emit('voice:speaking', { isSpeaking });
          if (this.onLocalSpeaking) this.onLocalSpeaking(isSpeaking);
        }

        // Transmit audio when speaking (plus 4 trailing frames for natural sound decay)
        if (isSpeaking || this.silenceHoldFrames > 0) {
          if (!isSpeaking) this.silenceHoldFrames--;
          else this.silenceHoldFrames = 4;

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
        isSpeaking: p.isSpeaking,
        isMuted: p.isMuted,
        isDeafened: p.isDeafened
      }));
      this.onPeersUpdateCallback(peerList);
    }
  }
}

window.WebRTCVoiceManager = WebRTCVoiceManager;
