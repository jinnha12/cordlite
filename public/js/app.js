/**
 * CordLite Main Application Logic
 * Pure Discord aesthetics with zero emojis - 100% SVG icons
 */
document.addEventListener('DOMContentLoaded', () => {
  // State
  let user = getOrInitUser();
  let socket = io();
  let voiceManager = new WebRTCVoiceManager(socket, user);

  let servers = [];
  let currentServer = null;
  let currentChannel = null;
  let activeVoiceChannel = null;
  let serverMembers = [];
  let isMuted = false;
  let isDeafened = false;
  let isLocalSpeaking = false;
  let cachedMessages = [];

  // PTT State
  let currentInputMode = localStorage.getItem('cordlite_input_mode') || 'vad';
  let currentPttKey = localStorage.getItem('cordlite_ptt_key') || 'Space';
  let isRecordingPttKey = false;
  let tempAvatarUrl = user.avatarUrl || null;
  let activeReactionMessageId = null;

  // DOM Elements
  const serverRail = document.getElementById('server-rail');
  const serverHeaderTitle = document.getElementById('server-header-title');
  const textChannelsList = document.getElementById('text-channels-list');
  const voiceChannelsList = document.getElementById('voice-channels-list');
  const voiceDock = document.getElementById('voice-dock');
  const voiceDockChannelName = document.getElementById('voice-dock-channel-name');
  const btnVoiceDisconnect = document.getElementById('btn-voice-disconnect');

  const userAvatarBadge = document.getElementById('user-avatar-badge');
  const userDisplayName = document.getElementById('user-display-name');
  const btnToggleMute = document.getElementById('btn-toggle-mute');
  const btnToggleDeafen = document.getElementById('btn-toggle-deafen');
  const btnUserSettings = document.getElementById('btn-user-settings');

  const topChannelName = document.getElementById('top-channel-name');
  const topChannelHash = document.getElementById('top-channel-hash');
  const btnInvite = document.getElementById('btn-invite');

  const chatView = document.getElementById('chat-view');
  const messagesFeed = document.getElementById('messages-feed');
  const chatTextInput = document.getElementById('chat-text-input');
  const btnSendMessage = document.getElementById('btn-send-message');
  const fileUploadInput = document.getElementById('file-upload-input');
  const btnAttach = document.getElementById('btn-attach');

  const voiceStage = document.getElementById('voice-stage');
  const voiceGrid = document.getElementById('voice-grid');
  const btnStageMute = document.getElementById('btn-stage-mute');
  const btnStageDeafen = document.getElementById('btn-stage-deafen');
  const btnStageDisconnect = document.getElementById('btn-stage-disconnect');
  const btnStageCamera = document.getElementById('btn-stage-camera');
  const btnStageScreenshare = document.getElementById('btn-stage-screenshare');
  const btnStageSoundboard = document.getElementById('btn-stage-soundboard');

  const membersSidebar = document.getElementById('members-sidebar');
  const toastNotification = document.getElementById('toast-notification');

  // Modals & Popovers
  const modalCreateServer = document.getElementById('modal-create-server');
  const modalCreateChannel = document.getElementById('modal-create-channel');
  const modalInvite = document.getElementById('modal-invite');
  const modalProfile = document.getElementById('modal-profile');
  const soundboardModal = document.getElementById('soundboard-modal');
  const reactionPickerPopover = document.getElementById('reaction-picker-popover');

  // 1. Initialize User Profile
  function getOrInitUser() {
    let saved = localStorage.getItem('cordlite_user');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed && parsed.userId) return parsed;
      } catch (e) {}
    }
    const colors = ['#5865F2', '#eb459e', '#57f287', '#fee75c', '#ed4245', '#00a8fc'];
    const randomColor = colors[Math.floor(Math.random() * colors.length)];
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    const defaultUser = {
      userId: 'usr-' + Math.random().toString(36).substring(2, 9),
      name: `User${randomNum}`,
      avatarColor: randomColor,
      avatarUrl: null
    };
    localStorage.setItem('cordlite_user', JSON.stringify(defaultUser));
    return defaultUser;
  }

  function updateUserProfile(name, avatarColor, avatarUrl) {
    user.name = name || user.name;
    user.avatarColor = avatarColor || user.avatarColor;
    if (avatarUrl !== undefined) {
      user.avatarUrl = avatarUrl;
    }
    voiceManager.user = user;
    localStorage.setItem('cordlite_user', JSON.stringify(user));
    socket.emit('user:update', {
      name: user.name,
      avatarColor: user.avatarColor,
      avatarUrl: user.avatarUrl
    });
    renderUserBar();
    renderMembers();
    renderVoiceStage();
  }

  function renderUserBar() {
    if (user.avatarUrl) {
      userAvatarBadge.innerHTML = `<img src="${user.avatarUrl}" alt="${escapeHtml(user.name)}"><div class="status-dot"></div>`;
      userAvatarBadge.style.backgroundColor = 'transparent';
    } else {
      userAvatarBadge.style.backgroundColor = user.avatarColor;
      userAvatarBadge.innerHTML = `${escapeHtml(user.name.charAt(0).toUpperCase())}<div class="status-dot"></div>`;
    }
    userDisplayName.textContent = user.name;
    const userBar = document.querySelector('.user-bar');
    if (userBar) {
      userBar.oncontextmenu = (e) => showUserContextMenu(e, user);
    }
  }

  // Discord Context Menu Logic
  const contextMenu = document.getElementById('discord-context-menu');

  function closeContextMenu() {
    if (contextMenu) {
      contextMenu.style.display = 'none';
      contextMenu.innerHTML = '';
    }
  }

  function showUserContextMenu(e, targetUser) {
    if (!targetUser || !contextMenu) return;
    e.preventDefault();
    e.stopPropagation();

    const isMe = targetUser.userId === user.userId;
    const isLocallyMuted = !isMe && voiceManager.isPeerLocallyMuted(targetUser.socketId, targetUser.userId);
    const peerVol = !isMe ? Math.round(voiceManager.getPeerVolume(targetUser.socketId, targetUser.userId) * 100) : 100;

    let itemsHtml = '';

    if (isMe) {
      itemsHtml = `
        <div class="ctx-item" id="ctx-action-edit-profile">
          <div class="ctx-item-left"><span>${window.ICONS.edit}</span><span>Edit Profile & Avatar</span></div>
        </div>
        <div class="ctx-item" id="ctx-action-toggle-mute">
          <div class="ctx-item-left"><span>${isMuted ? window.ICONS.micMuted : window.ICONS.mic}</span><span>${isMuted ? 'Unmute Microphone' : 'Mute Microphone'}</span></div>
        </div>
        <div class="ctx-item" id="ctx-action-toggle-deafen">
          <div class="ctx-item-left"><span>${isDeafened ? window.ICONS.deafen : window.ICONS.headphones}</span><span>${isDeafened ? 'Undeafen Audio' : 'Deafen Audio'}</span></div>
        </div>
        <div class="ctx-divider"></div>
        <div class="ctx-item" id="ctx-action-copy-id">
          <div class="ctx-item-left"><span>${window.ICONS.copy}</span><span>Copy User ID</span></div>
        </div>
      `;
    } else {
      itemsHtml = `
        ${targetUser.isScreenSharing ? `
          <div class="ctx-item live-stream-ctx-item" id="ctx-action-watch-stream">
            <div class="ctx-item-left">
              <span style="color: var(--red);">${window.ICONS.screenShare}</span>
              <span><strong>Watch Live Stream</strong></span>
            </div>
            <span class="occupant-live-badge">LIVE</span>
          </div>
          <div class="ctx-divider"></div>
        ` : ''}
        <div class="ctx-item" id="ctx-action-mention">
          <div class="ctx-item-left"><span>${window.ICONS.chat}</span><span>Mention (@${escapeHtml(targetUser.name)})</span></div>
        </div>
        <div class="ctx-item" id="ctx-action-mute-peer">
          <div class="ctx-item-left">
            <span>${isLocallyMuted ? window.ICONS.speakerMuted : window.ICONS.speaker}</span>
            <span>Mute User</span>
          </div>
          <div class="ctx-checkbox ${isLocallyMuted ? 'checked' : ''}">
            ${isLocallyMuted ? window.ICONS.check : ''}
          </div>
        </div>

        <div class="ctx-slider-container">
          <div class="ctx-slider-header">
            <span>USER VOLUME</span>
            <span class="ctx-slider-val" id="ctx-vol-val">${isLocallyMuted ? '0%' : peerVol + '%'}</span>
          </div>
          <input type="range" class="ctx-slider-input" id="ctx-vol-slider" min="0" max="150" value="${isLocallyMuted ? 0 : peerVol}" />
        </div>

        <div class="ctx-divider"></div>
        <div class="ctx-item" id="ctx-action-copy-id">
          <div class="ctx-item-left"><span>${window.ICONS.copy}</span><span>Copy User ID</span></div>
        </div>
      `;
    }

    contextMenu.innerHTML = itemsHtml;
    contextMenu.style.display = 'block';

    const menuWidth = 220;
    const menuHeight = contextMenu.offsetHeight || 200;
    const winWidth = window.innerWidth;
    const winHeight = window.innerHeight;

    let posX = e.clientX;
    let posY = e.clientY;

    if (posX + menuWidth > winWidth) posX = winWidth - menuWidth - 10;
    if (posY + menuHeight > winHeight) posY = winHeight - menuHeight - 10;

    contextMenu.style.left = `${Math.max(10, posX)}px`;
    contextMenu.style.top = `${Math.max(10, posY)}px`;

    // Wire Context Menu Click Actions
    const watchStreamBtn = document.getElementById('ctx-action-watch-stream');
    if (watchStreamBtn) {
      watchStreamBtn.onclick = async () => {
        closeContextMenu();
        if (targetUser.voiceChannelId && (!activeVoiceChannel || activeVoiceChannel.id !== targetUser.voiceChannelId)) {
          if (currentServer) {
            const ch = currentServer.channels.find(c => c.id === targetUser.voiceChannelId);
            if (ch) await selectChannel(ch.id);
          }
        }
        if (targetUser.socketId) {
          voiceManager.requestStreamFromPeer(targetUser.socketId);
        }
        showToast(`Watching ${targetUser.name}'s stream`);
        renderVoiceStage();
      };
    }

    const editProfileBtn = document.getElementById('ctx-action-edit-profile');
    if (editProfileBtn) {
      editProfileBtn.onclick = () => {
        closeContextMenu();
        btnUserSettings.click();
      };
    }

    const toggleMuteBtn = document.getElementById('ctx-action-toggle-mute');
    if (toggleMuteBtn) {
      toggleMuteBtn.onclick = () => {
        closeContextMenu();
        btnToggleMute.click();
      };
    }

    const toggleDeafenBtn = document.getElementById('ctx-action-toggle-deafen');
    if (toggleDeafenBtn) {
      toggleDeafenBtn.onclick = () => {
        closeContextMenu();
        btnToggleDeafen.click();
      };
    }

    const copyIdBtn = document.getElementById('ctx-action-copy-id');
    if (copyIdBtn) {
      copyIdBtn.onclick = () => {
        navigator.clipboard.writeText(targetUser.userId);
        showToast('User ID copied to clipboard');
        closeContextMenu();
      };
    }

    const mentionBtn = document.getElementById('ctx-action-mention');
    if (mentionBtn) {
      mentionBtn.onclick = () => {
        chatTextInput.value = `@${targetUser.name} ` + chatTextInput.value;
        chatTextInput.focus();
        closeContextMenu();
      };
    }

    const mutePeerBtn = document.getElementById('ctx-action-mute-peer');
    if (mutePeerBtn) {
      mutePeerBtn.onclick = () => {
        const nowMuted = voiceManager.toggleMutePeer(targetUser.socketId, targetUser.userId);
        showToast(nowMuted ? `Muted ${targetUser.name} for you` : `Unmuted ${targetUser.name}`);
        closeContextMenu();
        renderVoiceStage();
        renderMembers();
      };
    }

    const volSlider = document.getElementById('ctx-vol-slider');
    const volVal = document.getElementById('ctx-vol-val');
    if (volSlider && volVal) {
      volSlider.oninput = (ev) => {
        const val = parseInt(ev.target.value, 10);
        voiceManager.setPeerVolume(targetUser.socketId, targetUser.userId, val / 100);
        volVal.textContent = val + '%';
        renderVoiceStage();
      };
    }
  }

  window.addEventListener('click', (e) => {
    if (!e.target.closest('#discord-context-menu')) {
      closeContextMenu();
    }
    if (!e.target.closest('#reaction-picker-popover') && !e.target.closest('.btn-msg-react')) {
      closeReactionPicker();
    }
  });

  window.addEventListener('resize', () => {
    closeContextMenu();
    closeReactionPicker();
  });

  renderUserBar();

  // Helper to update sidebar speaking indicator without rebuilding DOM
  function updateSidebarOccupantSpeaking(userId, isSpeaking) {
    const occEl = document.querySelector(`.voice-occupant-item[data-user-id="${userId}"] .occupant-avatar`);
    if (occEl) {
      occEl.classList.toggle('speaking', !!isSpeaking);
    }
  }

  // Voice local speaking callback - ONLY toggle CSS class (never re-render stage!)
  voiceManager.onLocalSpeaking = (speaking) => {
    isLocalSpeaking = speaking;
    const myTile = document.getElementById('my-voice-tile');
    if (myTile) {
      myTile.classList.toggle('speaking', speaking && !isMuted);
    }
    updateSidebarOccupantSpeaking(user.userId, speaking);
  };

  // Peer speaking callback - ONLY toggle CSS class on specific tile & sidebar
  voiceManager.onPeerSpeakingCallback = (socketId, isSpeaking) => {
    const tile = document.querySelector(`.voice-tile[data-socket-id="${socketId}"]`);
    if (tile) {
      const isLocallyMuted = voiceManager.isPeerLocallyMuted(socketId, null);
      tile.classList.toggle('speaking', isSpeaking && !isLocallyMuted);
    }
    const peer = voiceManager.peers.get(socketId);
    if (peer) {
      updateSidebarOccupantSpeaking(peer.userId, isSpeaking);
    }
  };

  // Full peer list change (joins, leaves, mute/video status toggles)
  voiceManager.setPeersUpdateCallback(() => {
    renderVoiceStage();
    renderVoiceChannelsOccupancy();
  });

  // Feature 1: Video stream attach callback (High-FPS WebRTC P2P)
  voiceManager.onPeerVideoUpdate = (socketId, stream) => {
    const tile = document.querySelector(`.voice-tile[data-socket-id="${socketId}"]`);
    if (tile) {
      const vid = tile.querySelector('.peer-stream-video');
      const canvas = tile.querySelector('.peer-stream-canvas');
      const overlay = tile.querySelector('.stream-standby-overlay');
      if (vid) {
        if (vid.srcObject !== stream) {
          vid.srcObject = stream;
        }
        vid.style.display = 'block';
        vid.play().catch(() => {});
        if (canvas) canvas.style.display = 'none';
        if (overlay) overlay.style.display = 'none';
        return;
      }
    }
    renderVoiceStage();
  };

  // Feature 1: Dual-Engine WebSocket Frame Relay (Firewall-Piercing Fallback)
  voiceManager.onPeerScreenFrame = (socketId, frameData) => {
    const tile = document.querySelector(`.voice-tile[data-socket-id="${socketId}"]`);
    if (!tile) return;
    const canvas = tile.querySelector('.peer-stream-canvas');
    const vid = tile.querySelector('.peer-stream-video');
    const overlay = tile.querySelector('.stream-standby-overlay');

    // If WebRTC video is actively decoding and playing, prefer smooth WebRTC
    const isWebRtcPlaying = vid && vid.srcObject && vid.readyState >= 2;
    if (isWebRtcPlaying) return;

    if (canvas) {
      const img = new Image();
      img.onload = () => {
        // ONLY resize canvas if dimensions actually changed to avoid clearing pixel buffer
        if (canvas.width !== img.width || canvas.height !== img.height) {
          canvas.width = img.width;
          canvas.height = img.height;
        }
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        canvas.style.display = 'block';
        if (vid) vid.style.display = 'none';
        if (overlay) overlay.style.display = 'none';
      };
      img.src = frameData;
    }
  };

  // Feature 4: Soundboard playback announcement
  voiceManager.onSoundboardPlayed = ({ fromName, soundId }) => {
    showToast(`${fromName || 'Someone'} played: ${soundId}`);
  };

  // 2. Socket Event Listeners
  socket.on('connect', () => {
    console.log('Connected to CordLite server:', socket.id);
    const connBadge = document.getElementById('conn-status-badge');
    if (connBadge) {
      connBadge.innerHTML = '<span style="width: 8px; height: 8px; border-radius: 50%; background-color: var(--green);"></span> Connected';
      connBadge.style.color = 'var(--green)';
      connBadge.style.background = 'rgba(35, 165, 90, 0.2)';
    }

    const urlParams = new URLSearchParams(window.location.search);
    const inviteServerId = urlParams.get('invite') || urlParams.get('server');

    socket.emit('user:register', {
      userId: user.userId,
      name: user.name,
      avatarColor: user.avatarColor,
      avatarUrl: user.avatarUrl,
      serverId: inviteServerId || 'friends-hangout'
    });
  });

  socket.on('disconnect', () => {
    console.warn('Disconnected from CordLite server');
    const connBadge = document.getElementById('conn-status-badge');
    if (connBadge) {
      connBadge.innerHTML = '<span style="width: 8px; height: 8px; border-radius: 50%; background-color: var(--red);"></span> Disconnected';
      connBadge.style.color = 'var(--red)';
      connBadge.style.background = 'rgba(242, 63, 67, 0.2)';
    }
  });

  socket.on('server:list', (serverList) => {
    servers = serverList;
    renderServerRail();

    const urlParams = new URLSearchParams(window.location.search);
    const inviteServerId = urlParams.get('invite') || urlParams.get('server');

    if (inviteServerId && servers.find(s => s.id === inviteServerId)) {
      selectServer(inviteServerId);
    } else if (!currentServer && servers.length > 0) {
      selectServer(servers[0].id);
    }
  });

  socket.on('server:details', (serverData) => {
    currentServer = serverData;
    serverHeaderTitle.textContent = serverData.name;
    renderChannels();
    
    // Select first text channel if none selected
    if (!currentChannel && serverData.channels && serverData.channels.length > 0) {
      const firstText = serverData.channels.find(c => c.type === 'text');
      if (firstText) {
        selectChannel(firstText.id);
      }
    }
  });

  socket.on('server:created', (newServer) => {
    servers.push(newServer);
    renderServerRail();
    selectServer(newServer.id);
    showToast(`Server "${newServer.name}" created!`);
  });

  socket.on('channel:created', ({ serverId, channel }) => {
    if (currentServer && currentServer.id === serverId) {
      if (!currentServer.channels.find(c => c.id === channel.id)) {
        currentServer.channels.push(channel);
        renderChannels();
      }
    }
  });

  socket.on('channel:deleted', ({ serverId, channelId }) => {
    if (currentServer && currentServer.id === serverId) {
      currentServer.channels = currentServer.channels.filter(c => c.id !== channelId);
      renderChannels();
      if (currentChannel && currentChannel.id === channelId) {
        const fallback = currentServer.channels.find(c => c.type === 'text');
        if (fallback) selectChannel(fallback.id);
      }
    }
  });

  socket.on('chat:history', ({ channelId, messages }) => {
    if (currentChannel && currentChannel.id === channelId) {
      cachedMessages = messages || [];
      renderChatMessages(cachedMessages);
    }
  });

  socket.on('chat:message', (message) => {
    if (currentChannel && currentChannel.id === message.channelId) {
      cachedMessages.push(message);
      appendChatMessage(message);
      if (message.user.id !== user.userId) {
        window.audioManager.playMessage();
      }
    }
  });

  // Feature 5: Real-time Message Reaction Update
  socket.on('chat:reaction_updated', ({ channelId, messageId, reactions }) => {
    if (currentChannel && currentChannel.id === channelId) {
      const msg = cachedMessages.find(m => m.id === messageId);
      if (msg) {
        msg.reactions = reactions;
      }
      updateMessageReactionsDom(messageId, reactions);
    }
  });

  let globalAllUsers = [];
  let globalUsersMap = {};

  socket.on('server:members', ({ serverId, members }) => {
    if (currentServer && currentServer.id === serverId) {
      serverMembers = members;
      renderMembers();
    }
  });

  socket.on('server:members_all', (data) => {
    if (data.serverUsersMap) globalUsersMap = data.serverUsersMap;
    if (data.allUsersList) globalAllUsers = data.allUsersList;
    if (currentServer && globalUsersMap[currentServer.id]) {
      serverMembers = globalUsersMap[currentServer.id];
    }
    renderMembers();
    renderServerRail();
  });

  let voiceOccupancy = {};
  socket.on('voice:room_occupancy', (occupancy) => {
    voiceOccupancy = occupancy;
    renderVoiceChannelsOccupancy();
  });

  // 3. UI Actions & Server Rail
  function renderServerRail() {
    serverRail.innerHTML = '';

    // Direct Messages / Home icon
    const homeBtn = document.createElement('div');
    homeBtn.className = 'server-item';
    homeBtn.title = 'CordLite Home';
    homeBtn.innerHTML = `
      <div class="server-pill"></div>
      <div class="server-badge" style="background-color: var(--blurple)">
        ${window.ICONS.compass}
      </div>
    `;
    homeBtn.onclick = () => {
      if (servers.length > 0) selectServer(servers[0].id);
    };
    serverRail.appendChild(homeBtn);

    const divider = document.createElement('div');
    divider.className = 'server-separator';
    serverRail.appendChild(divider);

    // List Servers
    servers.forEach(srv => {
      const isSelected = currentServer && currentServer.id === srv.id;
      const srvEl = document.createElement('div');
      srvEl.className = `server-item ${isSelected ? 'active' : ''}`;
      srvEl.title = srv.name;
      srvEl.innerHTML = `
        <div class="server-pill"></div>
        <div class="server-badge">
          ${escapeHtml(srv.icon || srv.name.substring(0, 2).toUpperCase())}
        </div>
      `;
      srvEl.onclick = () => selectServer(srv.id);
      serverRail.appendChild(srvEl);
    });

    // Add Server Button (+)
    const addServerBtn = document.createElement('div');
    addServerBtn.className = 'server-item';
    addServerBtn.title = 'Add a Server';
    addServerBtn.innerHTML = `
      <div class="server-pill"></div>
      <div class="server-badge add-btn">
        ${window.ICONS.plus}
      </div>
    `;
    addServerBtn.onclick = () => openModal(modalCreateServer);
    serverRail.appendChild(addServerBtn);
  }

  function selectServer(serverId) {
    if (currentServer && currentServer.id === serverId) return;
    socket.emit('server:select', { serverId });
    currentChannel = null;
    renderServerRail();
  }

  // 4. Channels Listing & Management
  function renderChannels() {
    if (!currentServer || !currentServer.channels) return;
    textChannelsList.innerHTML = '';
    voiceChannelsList.innerHTML = '';

    currentServer.channels.forEach(ch => {
      const isSelected = currentChannel && currentChannel.id === ch.id;
      const chEl = document.createElement('div');
      chEl.className = `channel-item ${isSelected ? 'active' : ''}`;
      chEl.dataset.id = ch.id;

      const iconSvg = ch.type === 'text' ? window.ICONS.hash : window.ICONS.speaker;
      chEl.innerHTML = `
        <span class="channel-icon">${iconSvg}</span>
        <span class="channel-name">${escapeHtml(ch.name)}</span>
        <span class="channel-delete-btn" title="Delete Channel">&times;</span>
      `;

      chEl.onclick = (e) => {
        if (e.target.classList.contains('channel-delete-btn')) {
          e.stopPropagation();
          deleteChannel(ch.id);
          return;
        }
        selectChannel(ch.id);
      };

      if (ch.type === 'text') {
        textChannelsList.appendChild(chEl);
      } else {
        voiceChannelsList.appendChild(chEl);
      }
    });

    renderVoiceChannelsOccupancy();
  }

  function deleteChannel(channelId) {
    if (!currentServer) return;
    socket.emit('channel:delete', { serverId: currentServer.id, channelId });
  }

  function selectChannel(channelId) {
    if (!currentServer) return;
    const ch = currentServer.channels.find(c => c.id === channelId);
    if (!ch) return;

    currentChannel = ch;
    renderChannels();

    topChannelHash.innerHTML = ch.type === 'text' ? window.ICONS.hash : window.ICONS.speaker;
    topChannelName.textContent = ch.name;

    if (ch.type === 'text') {
      chatView.style.display = 'flex';
      voiceStage.classList.remove('active');
      socket.emit('chat:get_history', { channelId: ch.id });
    } else {
      chatView.style.display = 'none';
      voiceStage.classList.add('active');
      if (!activeVoiceChannel || activeVoiceChannel.id !== ch.id) {
        joinVoiceChannel(ch);
      } else {
        renderVoiceStage();
      }
    }
  }

  // 5. Voice Channel Calling & Stage
  async function joinVoiceChannel(channel) {
    if (activeVoiceChannel && activeVoiceChannel.id === channel.id) {
      selectChannel(channel.id);
      return;
    }

    activeVoiceChannel = channel;
    voiceDockChannelName.textContent = channel.name;
    voiceDock.classList.add('connected');

    await voiceManager.joinVoice(currentServer.id, channel.id);
    selectChannel(channel.id);
    renderVoiceStage();
  }

  function disconnectVoiceChannel() {
    if (!activeVoiceChannel) return;
    voiceManager.leaveVoice();
    activeVoiceChannel = null;
    voiceDock.classList.remove('connected');

    // Reset media buttons
    btnStageCamera.classList.remove('active');
    btnStageScreenshare.classList.remove('active-screen');
    
    // Switch to first text channel
    if (currentServer) {
      const firstText = currentServer.channels.find(c => c.type === 'text');
      if (firstText) selectChannel(firstText.id);
    }
    renderChannels();
  }

  // Persistent tracking of requested peer streams to avoid renegotiation loops
  const requestedStreamPeers = new Set();

  // Feature 1: Render Voice Stage (Audio + Live Video / Screen Sharing) with Persistent DOM
  function renderVoiceStage() {
    if (!activeVoiceChannel) return;

    // 1. My Tile (Persistent Reconciliation)
    const isMyScreenSharing = voiceManager.isScreenSharing && voiceManager.localScreenStream;
    const isMyCameraOn = voiceManager.isCameraOn && voiceManager.localCameraStream;
    const myMode = isMyScreenSharing ? 'screen' : (isMyCameraOn ? 'camera' : 'avatar');

    let myTile = document.getElementById('my-voice-tile');
    if (!myTile) {
      myTile = document.createElement('div');
      myTile.id = 'my-voice-tile';
      myTile.dataset.mediaMode = '';
      myTile.oncontextmenu = (e) => showUserContextMenu(e, user);
      voiceGrid.appendChild(myTile);
    }

    myTile.className = `voice-tile ${isLocalSpeaking && !isMuted ? 'speaking' : ''} ${isMyScreenSharing ? 'screen-sharing' : ''}`;

    // Only rebuild inner HTML if media mode changed (avatar -> screen -> camera)
    if (myTile.dataset.mediaMode !== myMode) {
      myTile.dataset.mediaMode = myMode;
      let myMediaHtml = '';
      if (isMyScreenSharing) {
        myMediaHtml = `
          <div class="stream-tile-container">
            <div class="stream-top-bar">
              <div class="stream-top-left">
                <span class="occupant-live-badge">${window.ICONS.screenShare} LIVE</span>
                <span class="stream-owner-name">Your Live Screen</span>
              </div>
              <div class="stream-top-actions">
                <button class="btn-fullscreen-stream" id="btn-fullscreen-my-stream" title="Toggle Fullscreen">
                  ${window.ICONS.fullscreen}
                </button>
              </div>
            </div>
            <div class="stream-media-wrap">
              <video id="my-screen-video" autoplay muted playsinline></video>
            </div>
          </div>
        `;
      } else if (isMyCameraOn) {
        myMediaHtml = `
          <div class="voice-tile-video-wrap">
            <video id="my-camera-video" autoplay muted playsinline></video>
          </div>
          <span class="live-stream-badge">${window.ICONS.camera} Camera</span>
        `;
      } else {
        if (user.avatarUrl) {
          myMediaHtml = `
            <div class="voice-tile-avatar">
              <img src="${user.avatarUrl}" alt="${escapeHtml(user.name)}" />
            </div>
          `;
        } else {
          myMediaHtml = `
            <div class="voice-tile-avatar" style="background-color: ${user.avatarColor}">
              ${escapeHtml(user.name.charAt(0).toUpperCase())}
            </div>
          `;
        }
      }

      myTile.innerHTML = `
        ${myMediaHtml}
        <div class="voice-tile-name-tag">
          <span>${escapeHtml(user.name)} (You)</span>
          ${isMuted ? `<span class="tile-icon-muted">${window.ICONS.micMuted}</span>` : ''}
          ${isDeafened ? `<span class="tile-icon-muted">${window.ICONS.deafen}</span>` : ''}
        </div>
      `;

      if (isMyScreenSharing) {
        const vid = myTile.querySelector('#my-screen-video');
        if (vid) vid.srcObject = voiceManager.localScreenStream;
        const fsBtn = myTile.querySelector('#btn-fullscreen-my-stream');
        if (fsBtn) {
          fsBtn.onclick = (e) => {
            e.stopPropagation();
            if (!document.fullscreenElement) {
              myTile.requestFullscreen().catch(() => {});
            } else {
              document.exitFullscreen().catch(() => {});
            }
          };
        }
      } else if (isMyCameraOn) {
        const vid = myTile.querySelector('#my-camera-video');
        if (vid) vid.srcObject = voiceManager.localCameraStream;
      }
    } else {
      // Mode unchanged: ensure stream is still linked and update status badges
      if (isMyScreenSharing) {
        const vid = myTile.querySelector('#my-screen-video');
        if (vid && vid.srcObject !== voiceManager.localScreenStream) {
          vid.srcObject = voiceManager.localScreenStream;
        }
      } else if (isMyCameraOn) {
        const vid = myTile.querySelector('#my-camera-video');
        if (vid && vid.srcObject !== voiceManager.localCameraStream) {
          vid.srcObject = voiceManager.localCameraStream;
        }
      }
      const nameTag = myTile.querySelector('.voice-tile-name-tag');
      if (nameTag) {
        nameTag.innerHTML = `
          <span>${escapeHtml(user.name)} (You)</span>
          ${isMuted ? `<span class="tile-icon-muted">${window.ICONS.micMuted}</span>` : ''}
          ${isDeafened ? `<span class="tile-icon-muted">${window.ICONS.deafen}</span>` : ''}
        `;
      }
    }

    // 2. Peer Tiles (Persistent Reconciliation)
    const activeSocketIds = new Set();

    for (const [_, peer] of voiceManager.peers.entries()) {
      activeSocketIds.add(peer.socketId);

      const isLocallyMuted = voiceManager.isPeerLocallyMuted(peer.socketId, peer.userId);
      const peerVol = Math.round(voiceManager.getPeerVolume(peer.socketId, peer.userId) * 100);
      const isPeerScreenSharing = !!peer.isScreenSharing;
      const isPeerCameraOn = !!peer.isCameraOn;
      const peerStream = peer.videoStream || voiceManager.peerVideoStreams.get(peer.socketId);
      const cachedFrame = voiceManager.peerScreenFrames.get(peer.socketId);
      const hasActiveStream = !!(peerStream || cachedFrame);

      const peerMode = isPeerScreenSharing ? 'screen' : (isPeerCameraOn ? 'camera' : 'avatar');

      let tile = voiceGrid.querySelector(`.voice-tile[data-socket-id="${peer.socketId}"]`);
      if (!tile) {
        tile = document.createElement('div');
        tile.dataset.socketId = peer.socketId;
        tile.dataset.mediaMode = '';
        tile.oncontextmenu = (e) => showUserContextMenu(e, peer);
        voiceGrid.appendChild(tile);
      }

      tile.className = `voice-tile ${peer.isSpeaking && !peer.isMuted && !isLocallyMuted ? 'speaking' : ''} ${isLocallyMuted ? 'locally-muted' : ''} ${isPeerScreenSharing ? 'screen-sharing' : ''}`;

      // Only rebuild inner HTML if media mode changed
      if (tile.dataset.mediaMode !== peerMode) {
        tile.dataset.mediaMode = peerMode;

        let peerMediaHtml = '';
        if (isPeerScreenSharing) {
          peerMediaHtml = `
            <div class="stream-tile-container">
              <div class="stream-top-bar">
                <div class="stream-top-left">
                  <span class="occupant-live-badge">${window.ICONS.screenShare} LIVE</span>
                  <span class="stream-owner-name">${escapeHtml(peer.name)}'s Stream</span>
                </div>
                <div class="stream-top-actions">
                  <button class="btn-fullscreen-stream" title="Toggle Fullscreen">
                    ${window.ICONS.fullscreen}
                  </button>
                </div>
              </div>

              <div class="stream-media-wrap">
                <video class="peer-stream-video" autoplay playsinline muted style="${peerStream ? 'display: block;' : 'display: none;'}"></video>
                <canvas class="peer-stream-canvas" style="${!peerStream && cachedFrame ? 'display: block;' : 'display: none;'}"></canvas>

                <div class="stream-standby-overlay" style="${hasActiveStream ? 'display: none;' : 'display: flex;'}">
                  <div class="standby-avatar" style="background-color: ${peer.avatarColor}">
                    ${peer.avatarUrl ? `<img src="${peer.avatarUrl}" alt="${escapeHtml(peer.name)}" />` : escapeHtml(peer.name.charAt(0).toUpperCase())}
                  </div>
                  <div class="standby-title">${escapeHtml(peer.name)} is streaming</div>
                  <button class="btn-watch-stream" data-socket-id="${peer.socketId}">
                    ${window.ICONS.screenShare} Watch Stream
                  </button>
                </div>
              </div>
            </div>
          `;
        } else if (isPeerCameraOn) {
          peerMediaHtml = `
            <div class="voice-tile-video-wrap">
              <video class="peer-stream-video" autoplay playsinline muted></video>
            </div>
            <span class="live-stream-badge">${window.ICONS.camera} Camera</span>
          `;
        } else {
          if (peer.avatarUrl) {
            peerMediaHtml = `
              <div class="voice-tile-avatar">
                <img src="${peer.avatarUrl}" alt="${escapeHtml(peer.name)}" />
                ${isLocallyMuted ? `<span class="avatar-mute-badge" title="Muted for you">${window.ICONS.speakerMuted}</span>` : ''}
              </div>
            `;
          } else {
            peerMediaHtml = `
              <div class="voice-tile-avatar" style="background-color: ${peer.avatarColor}">
                ${escapeHtml(peer.name.charAt(0).toUpperCase())}
                ${isLocallyMuted ? `<span class="avatar-mute-badge" title="Muted for you">${window.ICONS.speakerMuted}</span>` : ''}
              </div>
            `;
          }
        }

        tile.innerHTML = `
          ${peerMediaHtml}

          <!-- Quick Mute & Volume Control -->
          <div class="voice-tile-actions">
            <button class="btn-peer-mute ${isLocallyMuted ? 'active-muted' : ''}" title="${isLocallyMuted ? 'Unmute this user' : 'Mute this user for you'}">
              ${isLocallyMuted ? window.ICONS.speakerMuted + ' Unmute' : window.ICONS.speaker + ' Mute'}
            </button>
            <div class="peer-vol-wrap">
              <span class="vol-label">${isLocallyMuted ? '0%' : peerVol + '%'}</span>
              <input type="range" class="peer-vol-slider" min="0" max="150" value="${isLocallyMuted ? 0 : peerVol}" title="Adjust user volume">
            </div>
          </div>

          <div class="voice-tile-name-tag">
            <span>${escapeHtml(peer.name)}</span>
            ${isLocallyMuted ? `<span class="tile-icon-local-muted" title="You muted this user">${window.ICONS.speakerMuted} Muted</span>` : ''}
            ${peer.isMuted ? `<span class="tile-icon-muted" title="Mic muted">${window.ICONS.micMuted}</span>` : ''}
            ${peer.isDeafened ? `<span class="tile-icon-muted" title="Deafened">${window.ICONS.deafen}</span>` : ''}
          </div>
        `;

        // Live stream controls
        if (isPeerScreenSharing) {
          const btnWatch = tile.querySelector('.btn-watch-stream');
          if (btnWatch) {
            btnWatch.onclick = (e) => {
              e.stopPropagation();
              voiceManager.requestStreamFromPeer(peer.socketId);
              btnWatch.innerHTML = `${window.ICONS.screenShare} Connecting...`;
              showToast(`Connecting to ${peer.name}'s stream...`);
            };
          }

          const btnFs = tile.querySelector('.btn-fullscreen-stream');
          if (btnFs) {
            btnFs.onclick = (e) => {
              e.stopPropagation();
              if (!document.fullscreenElement) {
                tile.requestFullscreen().catch(() => {});
              } else {
                document.exitFullscreen().catch(() => {});
              }
            };
          }

          // Request stream once upon stream discovery
          if (!requestedStreamPeers.has(peer.socketId)) {
            requestedStreamPeers.add(peer.socketId);
            voiceManager.requestStreamFromPeer(peer.socketId);
          }
        }

        // Attach video / canvas if stream ready
        if (peerStream) {
          const vid = tile.querySelector('.peer-stream-video');
          if (vid) {
            vid.srcObject = peerStream;
            vid.play().catch(() => {});
          }
        } else if (!peerStream && cachedFrame) {
          const canvas = tile.querySelector('.peer-stream-canvas');
          if (canvas) {
            const img = new Image();
            img.onload = () => {
              if (canvas.width !== img.width || canvas.height !== img.height) {
                canvas.width = img.width;
                canvas.height = img.height;
              }
              const ctx = canvas.getContext('2d');
              ctx.drawImage(img, 0, 0);
            };
            img.src = cachedFrame;
          }
        }

        // Controls
        const btnMute = tile.querySelector('.btn-peer-mute');
        const volSlider = tile.querySelector('.peer-vol-slider');
        const volLabel = tile.querySelector('.vol-label');

        btnMute.onclick = (e) => {
          e.stopPropagation();
          const nowMuted = voiceManager.toggleMutePeer(peer.socketId, peer.userId);
          showToast(nowMuted ? `Muted ${peer.name} for you` : `Unmuted ${peer.name}`);
          renderVoiceStage();
          renderMembers();
        };

        volSlider.oninput = (e) => {
          const val = parseInt(e.target.value, 10);
          voiceManager.setPeerVolume(peer.socketId, peer.userId, val / 100);
          volLabel.textContent = val + '%';
          if (val === 0) {
            btnMute.classList.add('active-muted');
            btnMute.innerHTML = window.ICONS.speakerMuted + ' Unmute';
          } else {
            btnMute.classList.remove('active-muted');
            btnMute.innerHTML = window.ICONS.speaker + ' Mute';
          }
        };
      } else {
        // Mode unchanged: update active stream srcObject if new and update name tag
        if (isPeerScreenSharing || isPeerCameraOn) {
          if (peerStream) {
            const vid = tile.querySelector('.peer-stream-video');
            if (vid) {
              if (vid.srcObject !== peerStream) {
                vid.srcObject = peerStream;
                vid.play().catch(() => {});
              }
              vid.style.display = 'block';
              const overlay = tile.querySelector('.stream-standby-overlay');
              if (overlay) overlay.style.display = 'none';
              const canvas = tile.querySelector('.peer-stream-canvas');
              if (canvas) canvas.style.display = 'none';
            }
          }
        }

        const nameTag = tile.querySelector('.voice-tile-name-tag');
        if (nameTag) {
          nameTag.innerHTML = `
            <span>${escapeHtml(peer.name)}</span>
            ${isLocallyMuted ? `<span class="tile-icon-local-muted" title="You muted this user">${window.ICONS.speakerMuted} Muted</span>` : ''}
            ${peer.isMuted ? `<span class="tile-icon-muted">${window.ICONS.micMuted}</span>` : ''}
            ${peer.isDeafened ? `<span class="tile-icon-muted">${window.ICONS.deafen}</span>` : ''}
          `;
        }
      }
    }

    // Clean up tiles of peers who left
    voiceGrid.querySelectorAll('.voice-tile[data-socket-id]').forEach(tileEl => {
      const sid = tileEl.dataset.socketId;
      if (!activeSocketIds.has(sid)) {
        requestedStreamPeers.delete(sid);
        tileEl.remove();
      }
    });
  }

  function renderVoiceChannelsOccupancy() {
    document.querySelectorAll('.voice-occupant-list').forEach(el => el.remove());

    for (const [channelId, occupants] of Object.entries(voiceOccupancy)) {
      const chEl = document.querySelector(`.channel-item[data-id="${channelId}"]`);
      if (!chEl || !occupants || occupants.length === 0) continue;

      let listEl = chEl.nextElementSibling;
      if (!listEl || !listEl.classList.contains('voice-occupant-list')) {
        listEl = document.createElement('div');
        listEl.className = 'voice-occupant-list';
        chEl.parentNode.insertBefore(listEl, chEl.nextSibling);
      }

      listEl.innerHTML = occupants.map(occ => {
        const isSpeaking = occ.isSpeaking;
        const avatarInner = occ.avatarUrl ? `<img src="${occ.avatarUrl}" alt="${escapeHtml(occ.name)}">` : escapeHtml(occ.name.charAt(0).toUpperCase());
        return `
          <div class="voice-occupant-item" data-user-id="${occ.userId}">
            <div class="occupant-avatar ${isSpeaking ? 'speaking' : ''}" style="background-color: ${occ.avatarUrl ? 'transparent' : occ.avatarColor}">
              ${avatarInner}
            </div>
            <span class="occupant-name">${escapeHtml(occ.name)}</span>
            ${occ.isScreenSharing ? `<span class="occupant-live-badge" title="${escapeHtml(occ.name)} is Live">${window.ICONS.screenShare} LIVE</span>` : ''}
          </div>
        `;
      }).join('');

      listEl.querySelectorAll('.voice-occupant-item').forEach(item => {
        const userId = item.dataset.userId;
        const occ = occupants.find(o => o.userId === userId);
        if (occ) {
          item.oncontextmenu = (e) => showUserContextMenu(e, occ);
          item.onclick = async (e) => {
            if (occ.isScreenSharing) {
              if (!activeVoiceChannel || activeVoiceChannel.id !== channelId) {
                if (currentServer) {
                  const ch = currentServer.channels.find(c => c.id === channelId);
                  if (ch) await selectChannel(ch.id);
                }
              }
              if (occ.socketId) {
                voiceManager.requestStreamFromPeer(occ.socketId);
              }
              showToast(`Watching ${occ.name}'s stream`);
              renderVoiceStage();
            } else {
              showUserContextMenu(e, occ);
            }
          };
        }
      });
    }
  }

  // 6. Chat Messaging Logic (with Feature 5: Reactions)
  function renderChatMessages(messages) {
    const srvName = currentServer ? currentServer.name : 'Hangout';
    const srvId = currentServer ? currentServer.id : 'friends-hangout';
    messagesFeed.innerHTML = `
      <div class="chat-welcome-banner">
        <div class="chat-welcome-title">Welcome to #${escapeHtml(currentChannel ? currentChannel.name : 'channel')}!</div>
        <div class="chat-welcome-desc">
          Server: <strong>${escapeHtml(srvName)}</strong> (ID: <code>${escapeHtml(srvId)}</code>) • 
          <a href="#" id="link-welcome-invite" style="color: var(--blurple); text-decoration: underline; font-weight: 600; display: inline-flex; align-items: center; gap: 4px;">${window.ICONS.link} Copy Friend Invite Link</a>
        </div>
      </div>
    `;
    const linkInvite = document.getElementById('link-welcome-invite');
    if (linkInvite) {
      linkInvite.onclick = (e) => {
        e.preventDefault();
        const inviteUrl = `${window.location.origin}/?invite=${srvId}`;
        navigator.clipboard.writeText(inviteUrl);
        showToast('Invite link copied to clipboard!');
      };
    }
    messages.forEach(msg => appendChatMessage(msg));
    scrollToBottom();
  }

  function appendChatMessage(msg) {
    const card = document.createElement('div');
    card.className = 'message-card';
    card.dataset.msgId = msg.id;

    const timeStr = formatTimestamp(msg.timestamp);

    let attachmentHtml = '';
    if (msg.attachment) {
      if (msg.attachment.isImage) {
        attachmentHtml = `
          <div class="message-attachment">
            <a href="${msg.attachment.url}" target="_blank">
              <img src="${msg.attachment.url}" alt="${escapeHtml(msg.attachment.filename)}" loading="lazy" />
            </a>
          </div>
        `;
      } else {
        attachmentHtml = `
          <div class="message-attachment">
            <a href="${msg.attachment.url}" target="_blank" class="file-box">
              <span>${window.ICONS.file}</span>
              <div>
                <div style="font-weight: 600;">${escapeHtml(msg.attachment.filename)}</div>
                <div style="font-size: 11px; color: var(--text-muted);">${formatFileSize(msg.attachment.size)}</div>
              </div>
            </a>
          </div>
        `;
      }
    }

    const avatarHtml = msg.user.avatarUrl ?
      `<img src="${msg.user.avatarUrl}" alt="${escapeHtml(msg.user.name)}" />` :
      escapeHtml(msg.user.name.charAt(0).toUpperCase());

    const avatarBg = msg.user.avatarUrl ? 'transparent' : (msg.user.avatarColor || '#5865F2');

    // Reactions HTML
    const reactionsHtml = buildReactionsHtml(msg.id, msg.reactions);

    card.innerHTML = `
      <div class="message-actions-bar">
        <button class="btn-msg-react" data-msg-id="${msg.id}" title="Add Reaction">
          ${window.ICONS.reactionAdd}
        </button>
      </div>

      <div class="message-avatar" style="background-color: ${avatarBg}">
        ${avatarHtml}
      </div>
      <div class="message-content-wrapper">
        <div class="message-header">
          <span class="message-author">${escapeHtml(msg.user.name)}</span>
          <span class="message-timestamp">${timeStr}</span>
        </div>
        <div class="message-text">${parseMarkdown(msg.text)}</div>
        ${attachmentHtml}
        <div class="message-reactions-row" id="reactions-${msg.id}">
          ${reactionsHtml}
        </div>
      </div>
    `;

    // Reaction click handling
    const reactBtn = card.querySelector('.btn-msg-react');
    if (reactBtn) {
      reactBtn.onclick = (e) => {
        e.stopPropagation();
        openReactionPicker(reactBtn, msg.id);
      };
    }

    wireReactionPills(card, msg.id);

    const authorEl = card.querySelector('.message-author');
    const avatarEl = card.querySelector('.message-avatar');
    if (authorEl) {
      authorEl.oncontextmenu = (e) => showUserContextMenu(e, msg.user);
      authorEl.onclick = (e) => showUserContextMenu(e, msg.user);
    }
    if (avatarEl) {
      avatarEl.oncontextmenu = (e) => showUserContextMenu(e, msg.user);
      avatarEl.onclick = (e) => showUserContextMenu(e, msg.user);
    }

    messagesFeed.appendChild(card);
    scrollToBottom();
  }

  function buildReactionsHtml(msgId, reactions) {
    if (!reactions) return '';
    let html = '';
    for (const [reactionType, userIds] of Object.entries(reactions)) {
      if (!userIds || userIds.length === 0) continue;
      const hasReacted = userIds.includes(user.userId);
      const iconSvg = window.ICONS[reactionType] || '';
      html += `
        <button class="reaction-pill ${hasReacted ? 'reacted' : ''}" data-msg-id="${msgId}" data-reaction="${reactionType}">
          <span class="reaction-pill-icon">${iconSvg}</span>
          <span class="reaction-pill-count">${userIds.length}</span>
        </button>
      `;
    }
    return html;
  }

  function wireReactionPills(container, msgId) {
    container.querySelectorAll('.reaction-pill').forEach(pill => {
      pill.onclick = (e) => {
        e.stopPropagation();
        const reactionType = pill.dataset.reaction;
        toggleMessageReaction(msgId, reactionType);
      };
    });
  }

  function updateMessageReactionsDom(messageId, reactions) {
    const row = document.getElementById(`reactions-${messageId}`);
    if (row) {
      row.innerHTML = buildReactionsHtml(messageId, reactions);
      wireReactionPills(row, messageId);
    }
  }

  function toggleMessageReaction(messageId, reactionType) {
    if (!currentServer || !currentChannel) return;
    socket.emit('chat:reaction', {
      serverId: currentServer.id,
      channelId: currentChannel.id,
      messageId,
      reactionType
    });
  }

  // Feature 5: Reaction Picker Floating Popover
  function openReactionPicker(anchorBtn, messageId) {
    activeReactionMessageId = messageId;
    const rect = anchorBtn.getBoundingClientRect();
    reactionPickerPopover.style.display = 'block';

    const popoverWidth = reactionPickerPopover.offsetWidth || 280;
    let posX = rect.left - popoverWidth + 30;
    let posY = rect.top - 46;

    if (posX < 10) posX = 10;
    if (posY < 10) posY = rect.bottom + 8;

    reactionPickerPopover.style.left = `${posX}px`;
    reactionPickerPopover.style.top = `${posY}px`;
  }

  function closeReactionPicker() {
    reactionPickerPopover.style.display = 'none';
    activeReactionMessageId = null;
  }

  document.querySelectorAll('.reaction-picker-btn').forEach(btn => {
    btn.onclick = () => {
      if (activeReactionMessageId) {
        const reactionType = btn.dataset.reaction;
        toggleMessageReaction(activeReactionMessageId, reactionType);
        closeReactionPicker();
      }
    };
  });

  function sendMessage() {
    const text = chatTextInput.value.trim();
    if (!text || !currentServer || !currentChannel) return;

    socket.emit('chat:send', {
      serverId: currentServer.id,
      channelId: currentChannel.id,
      text
    });

    chatTextInput.value = '';
    chatTextInput.focus();
  }

  btnSendMessage.onclick = sendMessage;
  chatTextInput.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  // File Upload handling
  btnAttach.onclick = () => fileUploadInput.click();
  fileUploadInput.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    try {
      showToast('Uploading attachment...');
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (data.url) {
        socket.emit('chat:send', {
          serverId: currentServer.id,
          channelId: currentChannel.id,
          text: '',
          attachment: data
        });
        showToast('File sent!');
      }
    } catch (err) {
      console.error('File upload failed:', err);
      showToast('Upload failed.');
    } finally {
      fileUploadInput.value = '';
    }
  };

  // 7. Members Sidebar
  function renderMembers() {
    membersSidebar.innerHTML = '';
    const onlineBadge = document.getElementById('online-count-badge');
    if (onlineBadge) onlineBadge.textContent = serverMembers.length;

    const categoryTitle = document.createElement('div');
    categoryTitle.className = 'members-category-title';
    categoryTitle.textContent = `ONLINE — ${serverMembers.length}`;
    membersSidebar.appendChild(categoryTitle);

    serverMembers.forEach(m => {
      const isMutedLocally = voiceManager.isPeerLocallyMuted(m.socketId, m.userId);
      const isMe = m.userId === user.userId;
      const memEl = document.createElement('div');
      memEl.className = 'member-card';

      const avatarHtml = m.avatarUrl ?
        `<img src="${m.avatarUrl}" alt="${escapeHtml(m.name)}" />` :
        escapeHtml(m.name.charAt(0).toUpperCase());

      const avatarBg = m.avatarUrl ? 'transparent' : (m.avatarColor || '#5865F2');

      memEl.innerHTML = `
        <div class="member-avatar" style="background-color: ${avatarBg}">
          ${avatarHtml}
          <div class="status-dot"></div>
        </div>
        <div class="member-info">
          <div class="member-name">
            ${escapeHtml(m.name)}
            ${isMe ? '<span style="font-size: 11px; opacity: 0.6; margin-left: 4px;">(You)</span>' : ''}
          </div>
          <div class="member-role">${m.voiceChannelId ? 'In Voice' : 'Online'}</div>
        </div>
        ${isMutedLocally ? `<span style="color: var(--red); display: flex;" title="Locally Muted">${window.ICONS.speakerMuted}</span>` : ''}
      `;

      memEl.oncontextmenu = (e) => showUserContextMenu(e, m);
      memEl.onclick = (e) => showUserContextMenu(e, m);
      membersSidebar.appendChild(memEl);
    });
  }

  // 8. Voice Controls & Buttons
  function updateMuteButtons(muted) {
    isMuted = muted;
    btnToggleMute.classList.toggle('active-danger', isMuted);
    btnToggleMute.innerHTML = isMuted ? window.ICONS.micMuted : window.ICONS.mic;
    btnStageMute.classList.toggle('active-muted', isMuted);
    btnStageMute.innerHTML = isMuted ? window.ICONS.micMuted : window.ICONS.mic;
    renderVoiceStage();
  }

  function updateDeafenButtons(deafened) {
    isDeafened = deafened;
    btnToggleDeafen.classList.toggle('active-danger', isDeafened);
    btnToggleDeafen.innerHTML = isDeafened ? window.ICONS.deafen : window.ICONS.headphones;
    btnStageDeafen.classList.toggle('active-muted', isDeafened);
    btnStageDeafen.innerHTML = isDeafened ? window.ICONS.deafen : window.ICONS.headphones;
    renderVoiceStage();
  }

  btnToggleMute.onclick = () => {
    const muted = voiceManager.toggleMute();
    updateMuteButtons(muted);
  };
  btnStageMute.onclick = () => {
    const muted = voiceManager.toggleMute();
    updateMuteButtons(muted);
  };

  btnToggleDeafen.onclick = () => {
    const state = voiceManager.toggleDeafen();
    updateMuteButtons(state.isMuted);
    updateDeafenButtons(state.isDeafened);
  };
  btnStageDeafen.onclick = () => {
    const state = voiceManager.toggleDeafen();
    updateMuteButtons(state.isMuted);
    updateDeafenButtons(state.isDeafened);
  };

  btnVoiceDisconnect.onclick = disconnectVoiceChannel;
  btnStageDisconnect.onclick = disconnectVoiceChannel;

  // Feature 1: Camera & Screen Sharing Buttons
  btnStageCamera.onclick = async () => {
    if (!activeVoiceChannel) return;
    const active = await voiceManager.toggleCamera();
    btnStageCamera.classList.toggle('active', active);
    btnStageCamera.innerHTML = active ? window.ICONS.cameraOff : window.ICONS.camera;
    showToast(active ? 'Camera turned on' : 'Camera turned off');
    renderVoiceStage();
  };

  btnStageScreenshare.onclick = async () => {
    if (!activeVoiceChannel) return;
    const active = await voiceManager.toggleScreenShare();
    btnStageScreenshare.classList.toggle('active-screen', active);
    btnStageScreenshare.innerHTML = active ? window.ICONS.screenShareStop : window.ICONS.screenShare;
    showToast(active ? 'Screen sharing started' : 'Screen sharing stopped');
    renderVoiceStage();
  };

  // Feature 4: Soundboard Modal & Buttons
  btnStageSoundboard.onclick = () => {
    if (!activeVoiceChannel) {
      showToast('Join a voice channel to use the soundboard');
      return;
    }
    soundboardModal.style.display = 'flex';
    soundboardModal.classList.add('open');
  };

  document.querySelectorAll('.soundboard-card').forEach(card => {
    card.onclick = () => {
      const soundId = card.dataset.sound;
      voiceManager.playSoundboard(soundId);
      soundboardModal.style.display = 'none';
      soundboardModal.classList.remove('open');
      showToast(`Played ${card.querySelector('.soundboard-card-title').textContent}`);
    };
  });

  // Feature 2: Push-to-Talk (PTT) Global Key Event Listeners
  window.addEventListener('keydown', (e) => {
    // Avoid triggering when typing in text inputs or recording keybind
    if (isRecordingPttKey) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    if (voiceManager.inputMode !== 'ptt' || !activeVoiceChannel) return;

    const pressedKey = e.code === 'Space' ? 'Space' : e.key;
    if (pressedKey.toLowerCase() === currentPttKey.toLowerCase()) {
      if (!e.repeat) {
        voiceManager.setPttActive(true);
      }
    }
  });

  window.addEventListener('keyup', (e) => {
    if (isRecordingPttKey) return;
    if (voiceManager.inputMode !== 'ptt' || !activeVoiceChannel) return;

    const pressedKey = e.code === 'Space' ? 'Space' : e.key;
    if (pressedKey.toLowerCase() === currentPttKey.toLowerCase()) {
      voiceManager.setPttActive(false);
    }
  });

  // 9. Modals & Actions
  // Create Server
  document.getElementById('btn-submit-create-server').onclick = () => {
    const nameInput = document.getElementById('input-server-name');
    const iconInput = document.getElementById('input-server-icon');
    const name = nameInput.value.trim();
    const icon = iconInput.value.trim() || 'C';

    if (!name) return;
    socket.emit('server:create', { name, icon });
    nameInput.value = '';
    closeModal(modalCreateServer);
  };

  // Create Channel Modal
  let selectedChannelType = 'text';
  document.querySelectorAll('.radio-card').forEach(card => {
    card.onclick = () => {
      if (card.dataset.type) {
        document.querySelectorAll('.radio-card[data-type]').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        selectedChannelType = card.dataset.type;
      }
    };
  });

  document.getElementById('btn-open-create-text').onclick = () => {
    selectedChannelType = 'text';
    document.querySelectorAll('.radio-card[data-type]').forEach(c => c.classList.toggle('selected', c.dataset.type === 'text'));
    openModal(modalCreateChannel);
  };

  document.getElementById('btn-open-create-voice').onclick = () => {
    selectedChannelType = 'voice';
    document.querySelectorAll('.radio-card[data-type]').forEach(c => c.classList.toggle('selected', c.dataset.type === 'voice'));
    openModal(modalCreateChannel);
  };

  document.getElementById('btn-submit-create-channel').onclick = () => {
    const nameInput = document.getElementById('input-channel-name');
    const name = nameInput.value.trim();
    if (!name || !currentServer) return;

    socket.emit('channel:create', {
      serverId: currentServer.id,
      name,
      type: selectedChannelType
    });
    nameInput.value = '';
    closeModal(modalCreateChannel);
  };

  // Invite Friends Modal
  btnInvite.onclick = () => {
    if (!currentServer) return;
    const inviteUrl = `${window.location.origin}/?invite=${currentServer.id}`;
    document.getElementById('input-invite-link').value = inviteUrl;
    openModal(modalInvite);
  };

  document.getElementById('btn-copy-invite').onclick = () => {
    const input = document.getElementById('input-invite-link');
    input.select();
    navigator.clipboard.writeText(input.value);
    showToast('Invite link copied to clipboard!');
  };

  // User Profile Settings Modal (Features 2 & 3)
  const inputAvatarFile = document.getElementById('input-avatar-file');
  const btnBrowseAvatar = document.getElementById('btn-browse-avatar');
  const btnRemoveAvatar = document.getElementById('btn-remove-avatar');
  const avatarPreviewText = document.getElementById('avatar-preview-text');
  const avatarPreviewImg = document.getElementById('avatar-preview-img');
  const avatarPreviewBox = document.getElementById('avatar-preview-box');

  const optModeVad = document.getElementById('opt-mode-vad');
  const optModePtt = document.getElementById('opt-mode-ptt');
  const pttKeybindGroup = document.getElementById('ptt-keybind-group');
  const btnPttKeybind = document.getElementById('btn-ptt-keybind');
  const pttKeybindText = document.getElementById('ptt-keybind-text');

  let selectedProfileColor = user.avatarColor;

  function updateAvatarPreview(imgUrl, color, name) {
    if (imgUrl) {
      avatarPreviewImg.src = imgUrl;
      avatarPreviewImg.style.display = 'block';
      avatarPreviewText.style.display = 'none';
      avatarPreviewBox.style.backgroundColor = 'transparent';
      btnRemoveAvatar.style.display = 'inline-block';
    } else {
      avatarPreviewImg.style.display = 'none';
      avatarPreviewText.style.display = 'block';
      avatarPreviewText.textContent = (name || user.name).charAt(0).toUpperCase();
      avatarPreviewBox.style.backgroundColor = color || selectedProfileColor;
      btnRemoveAvatar.style.display = 'none';
    }
  }

  btnUserSettings.onclick = () => {
    document.getElementById('input-profile-name').value = user.name;
    tempAvatarUrl = user.avatarUrl || null;
    selectedProfileColor = user.avatarColor;

    updateAvatarPreview(tempAvatarUrl, selectedProfileColor, user.name);

    document.querySelectorAll('.color-dot').forEach(dot => {
      dot.classList.toggle('selected', dot.dataset.color === user.avatarColor);
    });

    // Input mode setup
    currentInputMode = voiceManager.inputMode || 'vad';
    currentPttKey = voiceManager.pttKey || 'Space';
    optModeVad.classList.toggle('selected', currentInputMode === 'vad');
    optModePtt.classList.toggle('selected', currentInputMode === 'ptt');
    pttKeybindGroup.style.display = currentInputMode === 'ptt' ? 'block' : 'none';
    pttKeybindText.textContent = currentPttKey;

    openModal(modalProfile);
  };

  btnBrowseAvatar.onclick = () => inputAvatarFile.click();

  inputAvatarFile.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);
    try {
      showToast('Uploading profile image...');
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();
      if (data.url) {
        tempAvatarUrl = data.url;
        updateAvatarPreview(tempAvatarUrl, selectedProfileColor, document.getElementById('input-profile-name').value);
        showToast('Image uploaded successfully!');
      }
    } catch (err) {
      console.error('Avatar upload failed:', err);
      showToast('Avatar upload failed');
    } finally {
      inputAvatarFile.value = '';
    }
  };

  btnRemoveAvatar.onclick = () => {
    tempAvatarUrl = null;
    updateAvatarPreview(null, selectedProfileColor, document.getElementById('input-profile-name').value);
  };

  optModeVad.onclick = () => {
    currentInputMode = 'vad';
    optModeVad.classList.add('selected');
    optModePtt.classList.remove('selected');
    pttKeybindGroup.style.display = 'none';
  };

  optModePtt.onclick = () => {
    currentInputMode = 'ptt';
    optModePtt.classList.add('selected');
    optModeVad.classList.remove('selected');
    pttKeybindGroup.style.display = 'block';
  };

  btnPttKeybind.onclick = () => {
    isRecordingPttKey = true;
    btnPttKeybind.classList.add('recording');
    pttKeybindText.textContent = 'Press any key...';

    const onKeyRecord = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const recorded = e.code === 'Space' ? 'Space' : e.key;
      currentPttKey = recorded;
      pttKeybindText.textContent = currentPttKey;
      btnPttKeybind.classList.remove('recording');
      isRecordingPttKey = false;
      window.removeEventListener('keydown', onKeyRecord, true);
    };

    window.addEventListener('keydown', onKeyRecord, true);
  };

  document.querySelectorAll('.color-dot').forEach(dot => {
    dot.onclick = () => {
      document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('selected'));
      dot.classList.add('selected');
      selectedProfileColor = dot.dataset.color;
      updateAvatarPreview(tempAvatarUrl, selectedProfileColor, document.getElementById('input-profile-name').value);
    };
  });

  document.getElementById('btn-save-profile').onclick = () => {
    const newName = document.getElementById('input-profile-name').value.trim();
    if (newName) {
      updateUserProfile(newName, selectedProfileColor, tempAvatarUrl);
      voiceManager.setInputMode(currentInputMode);
      voiceManager.pttKey = currentPttKey;
      localStorage.setItem('cordlite_ptt_key', currentPttKey);
      showToast('Settings saved successfully!');
      closeModal(modalProfile);
    }
  };

  // Generic Modal Close
  document.querySelectorAll('.btn-close-modal').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.modal-overlay').forEach(m => {
        m.classList.remove('open');
        m.style.display = 'none';
      });
    };
  });

  window.onclick = (e) => {
    if (e.target.classList.contains('modal-overlay')) {
      e.target.classList.remove('open');
      e.target.style.display = 'none';
    }
  };

  function openModal(modal) {
    modal.style.display = 'flex';
    modal.classList.add('open');
  }

  function closeModal(modal) {
    modal.classList.remove('open');
    modal.style.display = 'none';
  }

  function showToast(message) {
    toastNotification.textContent = message;
    toastNotification.classList.add('show');
    setTimeout(() => {
      toastNotification.classList.remove('show');
    }, 2800);
  }

  function scrollToBottom() {
    messagesFeed.scrollTop = messagesFeed.scrollHeight;
  }

  function formatTimestamp(ts) {
    const d = new Date(ts);
    const hours = d.getHours().toString().padStart(2, '0');
    const mins = d.getMinutes().toString().padStart(2, '0');
    return `Today at ${hours}:${mins}`;
  }

  function formatFileSize(bytes) {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function parseMarkdown(text) {
    if (!text) return '';
    let escaped = escapeHtml(text);
    // Bold: **text**
    escaped = escaped.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    // Italic: *text*
    escaped = escaped.replace(/\*(.*?)\*/g, '<em>$1</em>');
    // Code block: ```code```
    escaped = escaped.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
    // Inline code: `code`
    escaped = escaped.replace(/`([^`]+)`/g, '<code style="background: rgba(0,0,0,0.3); padding: 2px 4px; border-radius: 3px;">$1</code>');
    // Auto-link URLs
    escaped = escaped.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color: var(--text-link); text-decoration: underline;">$1</a>');
    return escaped;
  }
});
