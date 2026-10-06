/**
 * WebRTC Voice Engine - Mesh voice calling with public STUN servers
 */
class WebRTCVoiceManager {
  constructor(socket) {
    this.socket = socket;
    this.localStream = null;
    this.peers = new Map(); // socketId -> { pc, audioEl, isSpeaking, name, avatarColor }
    this.currentChannelId = null;
    this.isMuted = false;
    this.isDeafened = false;

    this.iceServers = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ];

    this.onPeersUpdateCallback = null;
    this.setupSocketEvents();
  }

  setPeersUpdateCallback(cb) {
    this.onPeersUpdateCallback = cb;
  }

  setupSocketEvents() {
    // When we join, the server tells us who is currently in the room
    this.socket.on('voice:current_peers', async ({ channelId, peers }) => {
      this.currentChannelId = channelId;
      for (const peer of peers) {
        await this.initiatePeerConnection(peer.socketId, peer, true);
      }
      this.notifyPeersUpdate();
    });

    // When a new user joins after us
    this.socket.on('voice:user_joined', async (peer) => {
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
          await pc.setRemoteDescription(new RTCSessionDescription(signal));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.socket.emit('voice:signal', {
            toSocketId: fromSocketId,
            signal: pc.localDescription
          });
        } else if (signal.type === 'answer') {
          await pc.setRemoteDescription(new RTCSessionDescription(signal));
        } else if (signal.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
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
      // Set initial mute status
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
      // Fallback empty audio stream so voice room connection still works
      const ctx = window.audioManager.getAudioContext();
      if (ctx) {
        const dest = ctx.createMediaStreamDestination();
        this.localStream = dest.stream;
      }
      return this.localStream;
    }
  }

  async joinVoice(serverId, channelId) {
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

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const audioEl = new Audio();
    audioEl.autoplay = true;

    const peerData = {
      socketId: peerSocketId,
      userId: peerUser.userId,
      name: peerUser.name || 'Friend',
      avatarColor: peerUser.avatarColor || '#5865F2',
      isSpeaking: false,
      isMuted: peerUser.isMuted || false,
      isDeafened: peerUser.isDeafened || false,
      pc,
      audioEl
    };
    this.peers.set(peerSocketId, peerData);

    // Add local tracks to peer connection
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

    // Handle incoming audio stream
    pc.ontrack = (event) => {
      audioEl.srcObject = event.streams[0];
      audioEl.muted = this.isDeafened;
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

    if (isInitiator) {
      try {
        const offer = await pc.createOffer();
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
      peerData.audioEl.srcObject = null;
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
    // Deafening automatically mutes you too, just like Discord
    if (this.isDeafened && !this.isMuted) {
      this.isMuted = true;
      this.applyMuteState();
    }
    // Mute or unmute all remote incoming audio
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
