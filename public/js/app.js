/**
 * CordLite Main Application Logic
 */
document.addEventListener('DOMContentLoaded', () => {
  // State
  let user = getOrInitUser();
  let socket = io();
  let voiceManager = new WebRTCVoiceManager(socket);

  let servers = [];
  let currentServer = null;
  let currentChannel = null;
  let activeVoiceChannel = null;
  let serverMembers = [];
  let isMuted = false;
  let isDeafened = false;
  let isLocalSpeaking = false;

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

  const membersSidebar = document.getElementById('members-sidebar');
  const toastNotification = document.getElementById('toast-notification');

  // Modals
  const modalCreateServer = document.getElementById('modal-create-server');
  const modalCreateChannel = document.getElementById('modal-create-channel');
  const modalInvite = document.getElementById('modal-invite');
  const modalProfile = document.getElementById('modal-profile');

  // 1. Initialize User Profile
  function getOrInitUser() {
    let saved = localStorage.getItem('cordlite_user');
    if (saved) {
      try { return JSON.parse(saved); } catch (e) {}
    }
    const colors = ['#5865F2', '#eb459e', '#57f287', '#fee75c', '#ed4245', '#00a8fc'];
    const randomColor = colors[Math.floor(Math.random() * colors.length)];
    const randomNum = Math.floor(1000 + Math.random() * 9000);
    const defaultUser = {
      userId: 'usr-' + Math.random().toString(36).substring(2, 9),
      name: `User${randomNum}`,
      avatarColor: randomColor
    };
    localStorage.setItem('cordlite_user', JSON.stringify(defaultUser));
    return defaultUser;
  }

  function updateUserProfile(name, avatarColor) {
    user.name = name || user.name;
    user.avatarColor = avatarColor || user.avatarColor;
    localStorage.setItem('cordlite_user', JSON.stringify(user));
    socket.emit('user:update', { name: user.name, avatarColor: user.avatarColor });
    renderUserBar();
  }

  function renderUserBar() {
    userAvatarBadge.style.backgroundColor = user.avatarColor;
    userAvatarBadge.textContent = user.name.charAt(0).toUpperCase();
    userDisplayName.textContent = user.name;
  }

  renderUserBar();

  // Voice local speaking callback
  voiceManager.onLocalSpeaking = (speaking) => {
    isLocalSpeaking = speaking;
    renderVoiceStage();
    renderVoiceChannelsOccupancy();
  };

  voiceManager.setPeersUpdateCallback(() => {
    renderVoiceStage();
    renderVoiceChannelsOccupancy();
  });

  // 2. Socket Event Listeners
  socket.on('connect', () => {
    console.log('Connected to CordLite server:', socket.id);
    const urlParams = new URLSearchParams(window.location.search);
    const inviteServerId = urlParams.get('invite') || urlParams.get('server');

    socket.emit('user:register', {
      userId: user.userId,
      name: user.name,
      avatarColor: user.avatarColor,
      serverId: inviteServerId || 'friends-hangout'
    });
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
      renderChatMessages(messages);
    }
  });

  socket.on('chat:message', (message) => {
    if (currentChannel && currentChannel.id === message.channelId) {
      appendChatMessage(message);
      if (message.user.id !== user.userId) {
        window.audioManager.playMessage();
      }
    }
  });

  socket.on('server:members', ({ serverId, members }) => {
    if (currentServer && currentServer.id === serverId) {
      serverMembers = members;
      renderMembers();
    }
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
      <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
        <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z"/>
      </svg>
    `;
    serverRail.appendChild(homeBtn);

    const divider = document.createElement('div');
    divider.className = 'server-divider';
    serverRail.appendChild(divider);

    // List of servers
    servers.forEach((srv) => {
      const item = document.createElement('div');
      item.className = `server-item ${currentServer && currentServer.id === srv.id ? 'active' : ''}`;
      item.title = srv.name;
      item.innerHTML = `
        <div class="server-pill"></div>
        <span>${srv.icon || srv.name.charAt(0).toUpperCase()}</span>
      `;
      item.onclick = () => selectServer(srv.id);
      serverRail.appendChild(item);
    });

    // Add Server Button (+)
    const addBtn = document.createElement('div');
    addBtn.className = 'server-item server-btn-add';
    addBtn.title = 'Add a Server';
    addBtn.innerHTML = `
      <div class="server-pill"></div>
      <span style="font-size: 24px;">+</span>
    `;
    addBtn.onclick = () => openModal(modalCreateServer);
    serverRail.appendChild(addBtn);
  }

  function selectServer(serverId) {
    if (currentServer && currentServer.id === serverId) return;
    socket.emit('server:select', { serverId });
    renderServerRail();
  }

  // 4. Channel Navigation
  function renderChannels() {
    if (!currentServer) return;
    textChannelsList.innerHTML = '';
    voiceChannelsList.innerHTML = '';

    const textChannels = currentServer.channels.filter(c => c.type === 'text');
    const voiceChannels = currentServer.channels.filter(c => c.type === 'voice');

    textChannels.forEach(c => {
      const el = document.createElement('div');
      el.className = `channel-item ${currentChannel && currentChannel.id === c.id ? 'active' : ''}`;
      el.innerHTML = `
        <span class="channel-icon">#</span>
        <span class="channel-name">${escapeHtml(c.name)}</span>
      `;
      el.onclick = () => selectChannel(c.id);
      textChannelsList.appendChild(el);
    });

    voiceChannels.forEach(c => {
      const wrapper = document.createElement('div');
      wrapper.className = 'voice-channel-wrapper';

      const el = document.createElement('div');
      const isCurrentActive = activeVoiceChannel && activeVoiceChannel.id === c.id;
      el.className = `channel-item ${isCurrentActive ? 'active' : ''}`;
      el.innerHTML = `
        <span class="channel-icon">🔊</span>
        <span class="channel-name">${escapeHtml(c.name)}</span>
      `;
      el.onclick = () => joinVoiceChannel(c);

      wrapper.appendChild(el);

      // Render connected voice occupants inside sidebar
      const usersInChannel = voiceOccupancy[c.id] || [];
      if (usersInChannel.length > 0) {
        const userList = document.createElement('div');
        userList.className = 'channel-voice-users';
        usersInChannel.forEach(u => {
          const userItem = document.createElement('div');
          userItem.className = 'voice-user-item';
          const isSpeaking = (u.socketId === socket.id && isLocalSpeaking) || u.isSpeaking;
          userItem.innerHTML = `
            <div class="voice-user-avatar ${isSpeaking ? 'speaking' : ''}" style="background-color: ${u.avatarColor}">
              ${u.name.charAt(0).toUpperCase()}
            </div>
            <span>${escapeHtml(u.name)}</span>
          `;
          userList.appendChild(userItem);
        });
        wrapper.appendChild(userList);
      }

      voiceChannelsList.appendChild(wrapper);
    });
  }

  function renderVoiceChannelsOccupancy() {
    renderChannels();
  }

  function selectChannel(channelId) {
    if (!currentServer) return;
    const ch = currentServer.channels.find(c => c.id === channelId);
    if (!ch) return;

    currentChannel = ch;
    renderChannels();

    topChannelHash.textContent = ch.type === 'text' ? '#' : '🔊';
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
    
    // Switch to first text channel
    if (currentServer) {
      const firstText = currentServer.channels.find(c => c.type === 'text');
      if (firstText) selectChannel(firstText.id);
    }
    renderChannels();
  }

  function renderVoiceStage() {
    if (!activeVoiceChannel) return;
    voiceGrid.innerHTML = '';

    // 1. My Tile
    const myTile = document.createElement('div');
    myTile.className = `voice-tile ${isLocalSpeaking && !isMuted ? 'speaking' : ''}`;
    myTile.innerHTML = `
      <div class="voice-tile-avatar" style="background-color: ${user.avatarColor}">
        ${user.name.charAt(0).toUpperCase()}
      </div>
      <div class="voice-tile-name-tag">
        <span>${escapeHtml(user.name)} (You)</span>
        ${isMuted ? '<span class="tile-icon-muted">🔇</span>' : ''}
        ${isDeafened ? '<span class="tile-icon-muted">🎧</span>' : ''}
      </div>
    `;
    voiceGrid.appendChild(myTile);

    // 2. Peer Tiles
    for (const [_, peer] of voiceManager.peers.entries()) {
      const tile = document.createElement('div');
      tile.className = `voice-tile ${peer.isSpeaking && !peer.isMuted ? 'speaking' : ''}`;
      tile.innerHTML = `
        <div class="voice-tile-avatar" style="background-color: ${peer.avatarColor}">
          ${peer.name.charAt(0).toUpperCase()}
        </div>
        <div class="voice-tile-name-tag">
          <span>${escapeHtml(peer.name)}</span>
          ${peer.isMuted ? '<span class="tile-icon-muted">🔇</span>' : ''}
          ${peer.isDeafened ? '<span class="tile-icon-muted">🎧</span>' : ''}
        </div>
      `;
      voiceGrid.appendChild(tile);
    }
  }

  // 6. Chat Messaging Logic
  function renderChatMessages(messages) {
    messagesFeed.innerHTML = `
      <div class="chat-welcome-banner">
        <div class="chat-welcome-title">Welcome to #${escapeHtml(currentChannel ? currentChannel.name : 'channel')}!</div>
        <div class="chat-welcome-desc">This is the start of the #${escapeHtml(currentChannel ? currentChannel.name : 'channel')} channel. Say hi to your friends!</div>
      </div>
    `;
    messages.forEach(msg => appendChatMessage(msg));
    scrollToBottom();
  }

  function appendChatMessage(msg) {
    const card = document.createElement('div');
    card.className = 'message-card';

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
              <span>📁</span>
              <div>
                <div style="font-weight: 600;">${escapeHtml(msg.attachment.filename)}</div>
                <div style="font-size: 11px; color: var(--text-muted);">${formatFileSize(msg.attachment.size)}</div>
              </div>
            </a>
          </div>
        `;
      }
    }

    card.innerHTML = `
      <div class="message-avatar" style="background-color: ${msg.user.avatarColor}">
        ${msg.user.name.charAt(0).toUpperCase()}
      </div>
      <div class="message-content-wrapper">
        <div class="message-header">
          <span class="message-author">${escapeHtml(msg.user.name)}</span>
          <span class="message-timestamp">${timeStr}</span>
        </div>
        <div class="message-text">${parseMarkdown(msg.text)}</div>
        ${attachmentHtml}
      </div>
    `;

    messagesFeed.appendChild(card);
    scrollToBottom();
  }

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

  // 7. Members List
  function renderMembers() {
    membersSidebar.innerHTML = `
      <div class="members-section-title">Online — ${serverMembers.length}</div>
    `;

    serverMembers.forEach(m => {
      const item = document.createElement('div');
      item.className = 'member-item';
      item.innerHTML = `
        <div class="member-avatar" style="background-color: ${m.avatarColor}">
          ${m.name.charAt(0).toUpperCase()}
          <div class="status-dot"></div>
        </div>
        <div class="member-info">
          <span class="member-name">${escapeHtml(m.name)}</span>
          ${m.voiceChannelId ? '<span class="member-status">🔊 In Voice</span>' : ''}
        </div>
      `;
      membersSidebar.appendChild(item);
    });
  }

  // 8. Mute / Deafen Toggles
  function updateMuteButtons(muted) {
    isMuted = muted;
    btnToggleMute.classList.toggle('active-danger', isMuted);
    btnToggleMute.innerHTML = isMuted ? '🔇' : '🎙️';
    btnStageMute.classList.toggle('active-muted', isMuted);
    btnStageMute.innerHTML = isMuted ? '🔇' : '🎙️';
    renderVoiceStage();
  }

  function updateDeafenButtons(deafened) {
    isDeafened = deafened;
    btnToggleDeafen.classList.toggle('active-danger', isDeafened);
    btnToggleDeafen.innerHTML = isDeafened ? '🔕' : '🎧';
    btnStageDeafen.classList.toggle('active-muted', isDeafened);
    btnStageDeafen.innerHTML = isDeafened ? '🔕' : '🎧';
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

  // 9. Modals & Actions
  // Create Server
  document.getElementById('btn-submit-create-server').onclick = () => {
    const nameInput = document.getElementById('input-server-name');
    const iconInput = document.getElementById('input-server-icon');
    const name = nameInput.value.trim();
    const icon = iconInput.value.trim() || '💬';

    if (!name) return;
    socket.emit('server:create', { name, icon });
    nameInput.value = '';
    closeModal(modalCreateServer);
  };

  // Create Channel Modal
  let selectedChannelType = 'text';
  document.querySelectorAll('.radio-card').forEach(card => {
    card.onclick = () => {
      document.querySelectorAll('.radio-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedChannelType = card.dataset.type;
    };
  });

  document.getElementById('btn-open-create-text').onclick = () => {
    selectedChannelType = 'text';
    document.querySelectorAll('.radio-card').forEach(c => c.classList.toggle('selected', c.dataset.type === 'text'));
    openModal(modalCreateChannel);
  };

  document.getElementById('btn-open-create-voice').onclick = () => {
    selectedChannelType = 'voice';
    document.querySelectorAll('.radio-card').forEach(c => c.classList.toggle('selected', c.dataset.type === 'voice'));
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

  // User Profile Settings Modal
  btnUserSettings.onclick = () => {
    document.getElementById('input-profile-name').value = user.name;
    document.querySelectorAll('.color-dot').forEach(dot => {
      dot.classList.toggle('selected', dot.dataset.color === user.avatarColor);
    });
    openModal(modalProfile);
  };

  let selectedProfileColor = user.avatarColor;
  document.querySelectorAll('.color-dot').forEach(dot => {
    dot.onclick = () => {
      document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('selected'));
      dot.classList.add('selected');
      selectedProfileColor = dot.dataset.color;
    };
  });

  document.getElementById('btn-save-profile').onclick = () => {
    const newName = document.getElementById('input-profile-name').value.trim();
    if (newName) {
      updateUserProfile(newName, selectedProfileColor);
      showToast('Profile updated!');
      closeModal(modalProfile);
    }
  };

  // Generic Modal Close
  document.querySelectorAll('.btn-close-modal').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('open'));
    };
  });

  window.onclick = (e) => {
    if (e.target.classList.contains('modal-overlay')) {
      e.target.classList.remove('open');
    }
  };

  function openModal(modal) {
    modal.classList.add('open');
  }

  function closeModal(modal) {
    modal.classList.remove('open');
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
