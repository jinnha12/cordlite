/**
 * WebRTC Voice Engine - Mesh voice calling with public STUN & TURN relay servers
 */
class WebRTCVoiceManager {
  constructor(socket) {
    this.socket = socket;
    this.localStream = null;
    this.peers = new Map(); // socketId -> { pc, audioEl, audioNode, isSpeaking, name, avatarColor, pendingCandidates }
    this.currentChannelId = null;
    this.isMuted = false;
    this.isDeafened = false;

    // STUN + Fallback TURN servers
    this.iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ];

    this.onPeersUpdateCallback = null;
    this.setupSocketEvents();
    this.fetchTurnServers();
  }

  // Fetch dynamic TURN servers from server if configured
  async fetchTurnServers() {
    try {
      const res = await fetch('/api/turn-servers');
      if (res.ok) {
        const customServers = await res.json();
        if (Array.isArray(customServers) && customServers.length > 0) {
          this.iceServers = customServers;
          console.log('[WebRTC] Loaded dynamic ICE servers:', this.iceServers);
        }
      }
    } catch (e) {
      // Use built-in servers
    }
  }

  setPeersUpdateCallback(cb) {
    this.onPeersUpdateCallback = cb;
  }

  setupSocketEvents() {
    // When we join, server gives list of existing occupants in that voice channel
    this.socket.on('voice:current_peers', async ({ channelId, peers }) => {
      this.currentChannelId = channelId;
      console.log('[WebRTC] Existing peers in room:', peers);
      for (const peer of peers) {
        await this.initiatePeerConnection(peer.socketId, peer, true);
      }
      this.notifyPeersUpdate();
    });

    // When someone joins after us
    this.socket.on('voice:user_joined', async (peer) => {
      console.log('[WebRTC] New peer joined voice channel:', peer);
      await this.initiatePeerConnection(peer.socketId, peer, false);
      this.notifyPeersUpdate();
    });

    // WebRTC signaling messages (Offer, Answer, ICE Candidate)
    this.socket.on('voice:signal', async ({ fromSocketId, fromUser, signal }) => {
      let peerData = this.peers.get(fromSocketId);
      if (!peerData) {
        await this.initiatePeerConnection(fromSocketId, fromUser, false);
        peerData = this.peers.get(fromSocketId);
      }

      if (!peerData) return;
      const pc = peerData.pc;

      try {
        if (signal.type === 'offer') {
          console.log(`[WebRTC] Received OFFER from ${fromUser.name}`);
          await pc.setRemoteDescription(new RTCSessionDescription(signal));
          await this.flushPendingCandidates(peerData);

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);

          this.socket.emit('voice:signal', {
            toSocketId: fromSocketId,
            signal: pc.localDescription
          });
        } else if (signal.type === 'answer') {
          console.log(`[WebRTC] Received ANSWER from ${fromUser.name}`);
          await pc.setRemoteDescription(new RTCSessionDescription(signal));
          await this.flushPendingCandidates(peerData);
        } else if (signal.candidate) {
          if (!pc.remoteDescription || !pc.remoteDescription.type) {
            peerData.pendingCandidates.push(signal.candidate);
          } else {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
            } catch (err) {
              console.warn('ICE candidate addition failed:', err);
            }
          }
        }
      } catch (err) {
        console.error('Error handling WebRTC signal:', err);
      }
    });

    // Voice speaking indicator from a peer
    this.socket.on('voice:user_speaking', ({ socketId, isSpeaking }) => {
      const peer = this.peers.get(socketId);
      if (peer) {
        peer.isSpeaking = isSpeaking;
        this.notifyPeersUpdate();
      }
    });

    // Peer mute/deafen status change
    this.socket.on('voice:user_state', ({ socketId, isMuted, isDeafened }) => {
      const peer = this.peers.get(socketId);
      if (peer) {
        peer.isMuted = isMuted;
        peer.isDeafened = isDeafened;
        this.notifyPeersUpdate();
      }
    });

    // Peer left voice channel
    this.socket.on('voice:user_left', ({ socketId }) => {
      this.closePeerConnection(socketId);
      this.notifyPeersUpdate();
    });

    // Peer profile updated
    this.socket.on('voice:user_updated', ({ socketId, name, avatarColor }) => {
      const peer = this.peers.get(socketId);
      if (peer) {
        peer.name = name;
        peer.avatarColor = avatarColor;
        this.notifyPeersUpdate();
      }
    });
  }

  async flushPendingCandidates(peerData) {
    if (!peerData || !peerData.pc) return;
    const candidates = peerData.pendingCandidates || [];
    peerData.pendingCandidates = [];

    for (const cand of candidates) {
      try {
        await peerData.pc.addIceCandidate(new RTCIceCandidate(cand));
      } catch (e) {
        console.warn('Failed to flush queued candidate:', e);
      }
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

      this.applyMuteState();

      // Start local Voice Activity Detection
      window.audioManager.startVAD(this.localStream, (isSpeaking) => {
        if (this.isMuted) isSpeaking = false;
        this.socket.emit('voice:speaking', { isSpeaking });
        if (this.onLocalSpeaking) this.onLocalSpeaking(isSpeaking);
      });

      return this.localStream;
    } catch (err) {
      console.warn('Microphone permission not granted or device unavailable:', err);
      const ctx = window.audioManager.getAudioContext();
      if (ctx) {
        const dest = ctx.createMediaStreamDestination();
        this.localStream = dest.stream;
      }
      return this.localStream;
    }
  }

  async joinVoice(serverId, channelId) {
    // Ensure Web Audio context is resumed on user click
    const ctx = window.audioManager.getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      await ctx.resume();
    }

    await this.acquireLocalAudio();
    this.currentChannelId = channelId;
    this.socket.emit('voice:join', { serverId, channelId });
    window.audioManager.playJoin();
  }

  leaveVoice() {
    if (!this.currentChannelId) return;
    this.socket.emit('voice:leave');
    this.currentChannelId = null;

    // Close all peer connections
    for (const [socketId] of this.peers.entries()) {
      this.closePeerConnection(socketId);
    }
    this.peers.clear();

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }
    window.audioManager.stopVAD();
    window.audioManager.playLeave();
    this.notifyPeersUpdate();
  }

  async initiatePeerConnection(peerSocketId, peerUser, isInitiator) {
    if (this.peers.has(peerSocketId)) return;

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers,
      iceCandidatePoolSize: 10
    });

    // Ensure audio element is appended to DOM (fixes Chrome detached element silence bug)
    let audioContainer = document.getElementById('remote-audio-container');
    if (!audioContainer) {
      audioContainer = document.createElement('div');
      audioContainer.id = 'remote-audio-container';
      audioContainer.style.position = 'fixed';
      audioContainer.style.bottom = '-9999px';
      document.body.appendChild(audioContainer);
    }

    const audioEl = document.createElement('audio');
    audioEl.id = `remote-audio-${peerSocketId}`;
    audioEl.autoplay = true;
    audioEl.playsInline = true;
    audioContainer.appendChild(audioEl);

    const peerData = {
      socketId: peerSocketId,
      userId: peerUser.userId,
      name: peerUser.name || 'Friend',
      avatarColor: peerUser.avatarColor || '#5865F2',
      isSpeaking: false,
      isMuted: peerUser.isMuted || false,
      isDeafened: peerUser.isDeafened || false,
      pc,
      audioEl,
      audioNode: null,
      pendingCandidates: []
    };
    this.peers.set(peerSocketId, peerData);

    // Add local audio tracks to peer connection
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    // Handle incoming remote audio stream
    pc.ontrack = (event) => {
      console.log(`[WebRTC] Received remote audio stream from ${peerUser.name}!`);
      audioEl.srcObject = event.streams[0];
      audioEl.muted = this.isDeafened;
      audioEl.volume = 1.0;

      const playPromise = audioEl.play();
      if (playPromise !== undefined) {
        playPromise.catch(e => {
          console.warn('[WebRTC] Autoplay waiting for page click:', e);
          const resumeAudioOnDocClick = () => {
            audioEl.play().catch(() => {});
            document.removeEventListener('click', resumeAudioOnDocClick);
          };
          document.addEventListener('click', resumeAudioOnDocClick);
        });
      }

      // Also route stream via Web Audio API context for guaranteed non-muted playback
      try {
        const ctx = window.audioManager.getAudioContext();
        if (ctx) {
          if (ctx.state === 'suspended') ctx.resume();
          const source = ctx.createMediaStreamSource(event.streams[0]);
          const gain = ctx.createGain();
          gain.gain.value = 1.0;
          source.connect(gain);
          gain.connect(ctx.destination);
          peerData.audioNode = source;
        }
      } catch (err) {
        console.warn('[WebRTC] Web Audio routing notice:', err);
      }
    };

    // Forward ICE candidates to signaling server
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('voice:signal', {
          toSocketId: peerSocketId,
          signal: { candidate: event.candidate }
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[WebRTC Connection with ${peerUser.name}]:`, pc.connectionState);
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC ICE State with ${peerUser.name}]:`, pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed') {
        if (typeof pc.restartIce === 'function') {
          pc.restartIce();
        }
      }
    };

    if (isInitiator) {
      try {
        const offer = await pc.createOffer({
          offerToReceiveAudio: true
        });
        await pc.setLocalDescription(offer);
        this.socket.emit('voice:signal', {
          toSocketId: peerSocketId,
          signal: pc.localDescription
        });
      } catch (err) {
        console.error('Error creating offer:', err);
      }
    }
  }

  closePeerConnection(socketId) {
    const peerData = this.peers.get(socketId);
    if (!peerData) return;

    try {
      peerData.pc.close();
      if (peerData.audioEl) {
        peerData.audioEl.srcObject = null;
        peerData.audioEl.remove();
      }
      if (peerData.audioNode) {
        peerData.audioNode.disconnect();
      }
    } catch (e) {}
    this.peers.delete(socketId);
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    this.applyMuteState();
    window.audioManager.playMute(this.isMuted);
    this.socket.emit('voice:state', { isMuted: this.isMuted, isDeafened: this.isDeafened });
    return this.isMuted;
  }

  toggleDeafen() {
    this.isDeafened = !this.isDeafened;
    if (this.isDeafened && !this.isMuted) {
      this.isMuted = true;
      this.applyMuteState();
    }
    for (const [_, peer] of this.peers.entries()) {
      if (peer.audioEl) {
        peer.audioEl.muted = this.isDeafened;
      }
    }
    window.audioManager.playDeafen ? window.audioManager.playDeafen(this.isDeafened) : window.audioManager.playMute(this.isDeafened);
    this.socket.emit('voice:state', { isMuted: this.isMuted, isDeafened: this.isDeafened });
    return { isMuted: this.isMuted, isDeafened: this.isDeafened };
  }

  applyMuteState() {
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(track => {
        track.enabled = !this.isMuted;
      });
    }
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
