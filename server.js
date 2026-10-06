const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  maxHttpBufferSize: 1e7 // 10MB
});

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const STORE_PATH = path.join(DATA_DIR, 'store.json');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Setup multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const safeName = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}${ext}`;
    cb(null, safeName);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 } // 25MB max
});

// Seed default data
const defaultState = {
  servers: {
    'friends-hangout': {
      id: 'friends-hangout',
      name: 'Friends Hangout',
      icon: 'FH',
      created: Date.now(),
      channels: [
        { id: 'c-general', name: 'general', type: 'text' },
        { id: 'c-media', name: 'memes-and-media', type: 'text' },
        { id: 'v-general', name: 'General Voice', type: 'voice' },
        { id: 'v-gaming', name: 'Gaming Room', type: 'voice' }
      ]
    }
  },
  messages: {
    'c-general': [
      {
        id: 'msg-welcome-1',
        channelId: 'c-general',
        user: { id: 'bot', name: 'CordLite Bot', avatarColor: '#5865F2' },
        text: '👋 Welcome to **Friends Hangout**! No sign-in or account needed.',
        timestamp: Date.now() - 3600000
      },
      {
        id: 'msg-welcome-2',
        channelId: 'c-general',
        user: { id: 'bot', name: 'CordLite Bot', avatarColor: '#5865F2' },
        text: 'Click the **Invite Friends** button at the top to copy a direct invite link and share it with your buddies. You can talk in voice channels or chat right here!',
        timestamp: Date.now() - 1800000
      }
    ]
  },
  users: {}
};

let db = defaultState;
try {
  if (fs.existsSync(STORE_PATH)) {
    const raw = fs.readFileSync(STORE_PATH, 'utf-8');
    db = JSON.parse(raw);
    if (!db.servers) db.servers = defaultState.servers;
    if (!db.messages) db.messages = defaultState.messages;
    if (!db.users) db.users = {};
  } else {
    fs.writeFileSync(STORE_PATH, JSON.stringify(defaultState, null, 2));
  }
} catch (e) {
  console.warn('Error reading store.json, using default state:', e);
  db = defaultState;
}

// Auto-heal any server icons that were incorrectly defaulted to 'C'
if (db.servers) {
  let needsSave = false;
  for (const srv of Object.values(db.servers)) {
    if (srv && srv.name && (srv.icon === 'C' && !srv.name.toUpperCase().startsWith('C'))) {
      const words = srv.name.trim().split(/\s+/).filter(Boolean);
      srv.icon = words.length > 1
        ? words.map(w => w[0]).join('').substring(0, 3).toUpperCase()
        : srv.name.trim().charAt(0).toUpperCase();
      needsSave = true;
    }
  }
  if (needsSave) {
    try {
      fs.writeFileSync(STORE_PATH, JSON.stringify(db, null, 2));
    } catch (e) {
      console.error('Error auto-saving store.json:', e);
    }
  }
}

function saveStore() {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(db, null, 2));
  } catch (e) {
    console.error('Error saving store.json:', e);
  }
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// File upload route
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  const isImage = req.file.mimetype.startsWith('image/');
  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({
    url: fileUrl,
    filename: req.file.originalname,
    size: req.file.size,
    isImage
  });
});

// Dynamic TURN configuration route
app.get('/api/turn-servers', async (req, res) => {
  const appName = process.env.METERED_APP_NAME;
  const apiKey = process.env.METERED_API_KEY;

  if (appName && apiKey) {
    try {
      const cleanDomain = appName.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const domain = cleanDomain.includes('.') ? cleanDomain : `${cleanDomain}.metered.live`;
      const response = await fetch(`https://${domain}/api/v1/turn/credentials?apiKey=${apiKey}`);
      if (response.ok) {
        const iceServers = await response.json();
        return res.json(iceServers);
      }
    } catch (e) {
      console.warn('Failed to fetch from Metered:', e);
    }
  }

  // Fallback Google & Cloudflare STUN servers
  res.json([
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ]);
});

// App info endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', name: 'CordLite', version: '1.0.0' });
});

// Fallback for HTML5 history or invite links
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// In-memory active presence & voice state tracking
// socketId -> { socketId, userId, name, avatarColor, serverId, channelId, voiceChannelId, isMuted, isDeafened, isSpeaking }
const activeUsers = new Map();
// voiceChannelId -> Set of socketIds
const voiceRooms = new Map();
// In-memory Telegram verification sessions: phone -> { code, requestId, expiresAt, isGateway }
const pendingTelegramAuth = new Map();

io.on('connection', (socket) => {
  // Register user profile
  socket.on('user:register', (userData) => {
    const targetServerId = userData.serverId || 'friends-hangout';
    const isTg = !!userData.isTelegramVerified;
    const tgPhone = userData.telegramPhone || null;
    activeUsers.set(socket.id, {
      socketId: socket.id,
      userId: userData.userId || socket.id,
      name: userData.name || 'Anonymous',
      avatarColor: userData.avatarColor || '#5865F2',
      avatarUrl: userData.avatarUrl || null,
      isTelegramVerified: isTg,
      telegramPhone: tgPhone,
      serverId: targetServerId,
      channelId: null,
      voiceChannelId: null,
      isMuted: false,
      isDeafened: false,
      isSpeaking: false,
      isCameraOn: false,
      isScreenSharing: false
    });

    // Make socket immediately join target server room!
    socket.join(`server:${targetServerId}`);

    // Send available servers list
    socket.emit('server:list', Object.values(db.servers));
    
    // Send details of initial server
    const serverData = db.servers[targetServerId] || Object.values(db.servers)[0];
    if (serverData) {
      socket.emit('server:details', serverData);
    }

    broadcastServerPresence();
  });

  // Server creation
  socket.on('server:create', ({ name, icon }) => {
    const user = activeUsers.get(socket.id);
    const serverId = 'srv-' + Math.random().toString(36).substring(2, 9);
    const cleanName = (name && typeof name === 'string' && name.trim()) ? name.trim() : 'New Hangout';
    
    let finalIcon = (icon && typeof icon === 'string' && icon.trim()) ? icon.trim().toUpperCase() : '';
    if (!finalIcon) {
      const words = cleanName.split(/\s+/).filter(Boolean);
      if (words.length > 1) {
        finalIcon = words.map(w => w[0]).join('').substring(0, 3).toUpperCase();
      } else {
        finalIcon = cleanName.charAt(0).toUpperCase();
      }
    }

    const newServer = {
      id: serverId,
      name: cleanName,
      icon: finalIcon || 'NH',
      ownerId: user ? user.userId : null,
      created: Date.now(),
      channels: [
        { id: `c-${serverId}-gen`, name: 'general', type: 'text' },
        { id: `v-${serverId}-gen`, name: 'Voice Lounge', type: 'voice' }
      ]
    };
    if (!db.roles) db.roles = {};
    if (!db.roles[serverId]) db.roles[serverId] = {};
    if (user) db.roles[serverId][user.userId] = 'owner';
    db.servers[serverId] = newServer;
    saveStore();

    io.emit('server:list', Object.values(db.servers));
    socket.emit('server:created', newServer);
  });

  // Feature 5: Server Nicknames & Roles
  socket.on('server:update_nickname', ({ serverId, nickname }) => {
    const user = activeUsers.get(socket.id);
    if (!user || !serverId) return;
    if (!db.nicknames) db.nicknames = {};
    if (!db.nicknames[serverId]) db.nicknames[serverId] = {};
    if (nickname && nickname.trim()) {
      db.nicknames[serverId][user.userId] = nickname.trim().substring(0, 32);
    } else {
      delete db.nicknames[serverId][user.userId];
    }
    saveStore();
    broadcastServerPresence();
  });

  socket.on('server:update_role', ({ serverId, targetUserId, role }) => {
    const user = activeUsers.get(socket.id);
    if (!user || !serverId || !targetUserId) return;
    if (!db.roles) db.roles = {};
    if (!db.roles[serverId]) db.roles[serverId] = {};
    const validRoles = ['owner', 'admin', 'vip', 'member'];
    if (validRoles.includes(role)) {
      db.roles[serverId][targetUserId] = role;
      saveStore();
      broadcastServerPresence();
    }
  });

  // Channel creation
  socket.on('channel:create', ({ serverId, name, type }) => {
    if (!db.servers[serverId]) return;
    const cleanName = type === 'text' ? name.toLowerCase().replace(/\s+/g, '-') : name;
    const channelId = (type === 'voice' ? 'v-' : 'c-') + Math.random().toString(36).substring(2, 9);
    const newChannel = { id: channelId, name: cleanName, type: type || 'text' };
    db.servers[serverId].channels.push(newChannel);
    saveStore();

    io.to(`server:${serverId}`).emit('channel:created', { serverId, channel: newChannel });
    socket.emit('channel:created', { serverId, channel: newChannel });
  });

  // Channel deletion
  socket.on('channel:delete', ({ serverId, channelId }) => {
    if (!db.servers[serverId]) return;
    db.servers[serverId].channels = db.servers[serverId].channels.filter(c => c.id !== channelId);
    saveStore();

    io.to(`server:${serverId}`).emit('channel:deleted', { serverId, channelId });
    socket.emit('channel:deleted', { serverId, channelId });
  });

  // User selects/joins a server
  socket.on('server:select', ({ serverId }) => {
    const user = activeUsers.get(socket.id);
    if (!user) return;
    
    // Leave previous server room
    if (user.serverId) {
      socket.leave(`server:${user.serverId}`);
    }
    user.serverId = serverId;
    socket.join(`server:${serverId}`);
    
    const serverData = db.servers[serverId];
    if (serverData) {
      socket.emit('server:details', serverData);
    }
    broadcastServerPresence();
  });

  // Fetch chat history for text channel
  socket.on('chat:get_history', ({ channelId }) => {
    const history = db.messages[channelId] || [];
    socket.emit('chat:history', { channelId, messages: history });
  });

  // Send a text message
  socket.on('chat:send', ({ serverId, channelId, text, attachment }) => {
    const user = activeUsers.get(socket.id);
    if (!user || (!text && !attachment)) return;

    if (!db.messages[channelId]) db.messages[channelId] = [];

    const message = {
      id: 'msg-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
      channelId,
      user: {
        id: user.userId,
        name: user.name,
        nickname: (serverId && db.nicknames?.[serverId]?.[user.userId]) || null,
        role: (serverId && db.roles?.[serverId]?.[user.userId]) || (serverId && db.servers[serverId]?.ownerId === user.userId ? 'owner' : 'member'),
        avatarColor: user.avatarColor,
        avatarUrl: user.avatarUrl || null,
        isTelegramVerified: user.isTelegramVerified || false,
        telegramPhone: user.telegramPhone || null
      },
      text: text || '',
      attachment: attachment || null,
      reactions: {},
      timestamp: Date.now()
    };

    db.messages[channelId].push(message);
    if (db.messages[channelId].length > 300) {
      db.messages[channelId] = db.messages[channelId].slice(-300);
    }
    saveStore();

    // Broadcast message to everyone in this server (or global for DMs)
    if (channelId.startsWith('dm-')) {
      io.emit('chat:message', message);
    } else {
      io.to(`server:${serverId}`).emit('chat:message', message);
    }
  });

  // Feature 5: Toggle Message Reaction
  socket.on('chat:reaction', ({ serverId, channelId, messageId, reactionType }) => {
    const user = activeUsers.get(socket.id);
    if (!user || !channelId || !messageId || !reactionType) return;
    if (!db.messages[channelId]) return;

    const msg = db.messages[channelId].find(m => m.id === messageId);
    if (!msg) return;

    if (!msg.reactions) msg.reactions = {};
    if (!msg.reactions[reactionType]) msg.reactions[reactionType] = [];

    const existingIndex = msg.reactions[reactionType].indexOf(user.userId);
    if (existingIndex > -1) {
      // Toggle off
      msg.reactions[reactionType].splice(existingIndex, 1);
      if (msg.reactions[reactionType].length === 0) {
        delete msg.reactions[reactionType];
      }
    } else {
      // Toggle on
      msg.reactions[reactionType].push(user.userId);
    }

    saveStore();
    if (channelId.startsWith('dm-')) {
      io.emit('chat:reaction_updated', {
        channelId,
        messageId,
        reactions: msg.reactions
      });
    } else {
      io.to(`server:${serverId}`).emit('chat:reaction_updated', {
        channelId,
        messageId,
        reactions: msg.reactions
      });
    }
  });

  // --- WebRTC Voice Channels Signaling ---

  // Join a voice channel
  socket.on('voice:join', ({ serverId, channelId }) => {
    const user = activeUsers.get(socket.id);
    if (!user) return;

    // Leave any current voice channel first
    if (user.voiceChannelId) {
      leaveVoiceChannel(socket, user);
    }

    user.voiceChannelId = channelId;
    socket.join(`voice:${channelId}`);

    if (!voiceRooms.has(channelId)) {
      voiceRooms.set(channelId, new Set());
    }
    voiceRooms.get(channelId).add(socket.id);

    // Get all existing peers in this voice channel
    const peers = [];
    voiceRooms.get(channelId).forEach((otherSocketId) => {
      if (otherSocketId !== socket.id) {
        const otherUser = activeUsers.get(otherSocketId);
        if (otherUser) {
          peers.push({
            socketId: otherSocketId,
            userId: otherUser.userId,
            name: otherUser.name,
            avatarColor: otherUser.avatarColor,
            avatarUrl: otherUser.avatarUrl || null,
            isMuted: otherUser.isMuted,
            isDeafened: otherUser.isDeafened,
            isSpeaking: otherUser.isSpeaking,
            isCameraOn: otherUser.isCameraOn || false,
            isScreenSharing: otherUser.isScreenSharing || false
          });
        }
      }
    });

    // Notify joining user of current voice peers
    socket.emit('voice:current_peers', {
      channelId,
      peers
    });

    // Broadcast to room
    io.to(`voice:${channelId}`).emit('voice:user_joined', {
      socketId: socket.id,
      userId: user.userId,
      name: user.name,
      avatarColor: user.avatarColor,
      avatarUrl: user.avatarUrl || null,
      isMuted: user.isMuted,
      isDeafened: user.isDeafened,
      isSpeaking: user.isSpeaking,
      isCameraOn: user.isCameraOn || false,
      isScreenSharing: user.isScreenSharing || false
    });

    broadcastVoiceStatus();
  });

  // Direct Server Audio Relay (WebSocket Audio Stream)
  socket.on('voice:audio_stream', ({ channelId, audioData, sampleRate }) => {
    const user = activeUsers.get(socket.id);
    if (!user || user.voiceChannelId !== channelId || user.isMuted) return;

    // Relay audio chunk to all other users in this voice channel
    socket.to(`voice:${channelId}`).emit('voice:audio_stream', {
      fromSocketId: socket.id,
      fromUser: {
        userId: user.userId,
        name: user.name,
        avatarColor: user.avatarColor,
        avatarUrl: user.avatarUrl || null
      },
      audioData,
      sampleRate
    });
  });

  // WebRTC Signal forwarding (offer, answer, ICE candidate for voice & video)
  socket.on('voice:signal', ({ toSocketId, signal }) => {
    const sender = activeUsers.get(socket.id);
    if (!sender) return;

    io.to(toSocketId).emit('voice:signal', {
      fromSocketId: socket.id,
      fromUser: {
        userId: sender.userId,
        name: sender.name,
        avatarColor: sender.avatarColor,
        avatarUrl: sender.avatarUrl || null
      },
      signal
    });
  });

  // Feature 1: WebRTC Video / Screen Sharing Signaling
  socket.on('voice:video_signal', ({ toSocketId, signal, streamType }) => {
    const sender = activeUsers.get(socket.id);
    if (!sender) return;

    io.to(toSocketId).emit('voice:video_signal', {
      fromSocketId: socket.id,
      fromUser: {
        userId: sender.userId,
        name: sender.name,
        avatarColor: sender.avatarColor,
        avatarUrl: sender.avatarUrl || null
      },
      signal,
      streamType // 'camera' or 'screen'
    });
  });

  // Feature 1: Video & Screen Share state notification
  socket.on('voice:video_state', ({ channelId, isCameraOn, isScreenSharing }) => {
    const user = activeUsers.get(socket.id);
    if (!user || !channelId) return;

    user.isCameraOn = !!isCameraOn;
    user.isScreenSharing = !!isScreenSharing;

    io.to(`voice:${channelId}`).emit('voice:video_state', {
      socketId: socket.id,
      userId: user.userId,
      isCameraOn: user.isCameraOn,
      isScreenSharing: user.isScreenSharing
    });
  });

  // Feature 1: Request live stream from peer (when user clicks 'Watch Stream')
  socket.on('voice:request_stream', ({ toSocketId }) => {
    const sender = activeUsers.get(socket.id);
    if (!sender) return;
    io.to(toSocketId).emit('voice:request_stream', {
      fromSocketId: socket.id,
      fromUserId: sender.userId,
      fromName: sender.name
    });
  });

  // Feature 1: Dual-Engine Live Screen Frame Relay (Zero-Config Firewall-Piercing fallback)
  socket.on('voice:screen_frame', ({ channelId, frameData }) => {
    const user = activeUsers.get(socket.id);
    if (!user || user.voiceChannelId !== channelId) return;

    socket.to(`voice:${channelId}`).emit('voice:screen_frame', {
      fromSocketId: socket.id,
      fromUserId: user.userId,
      frameData
    });
  });

  // Feature 4: Voice Soundboard Playback
  socket.on('voice:soundboard', ({ channelId, soundId }) => {
    const user = activeUsers.get(socket.id);
    if (!user || !channelId) return;

    io.to(`voice:${channelId}`).emit('voice:soundboard', {
      fromSocketId: socket.id,
      fromName: user.name,
      soundId
    });
  });

  // Voice Speaking indicator
  socket.on('voice:speaking', ({ isSpeaking }) => {
    const user = activeUsers.get(socket.id);
    if (!user || !user.voiceChannelId) return;

    user.isSpeaking = isSpeaking;
    io.to(`voice:${user.voiceChannelId}`).emit('voice:user_speaking', {
      socketId: socket.id,
      userId: user.userId,
      isSpeaking
    });
  });

  // Voice Mute / Deafen state change
  socket.on('voice:state', ({ isMuted, isDeafened }) => {
    const user = activeUsers.get(socket.id);
    if (!user) return;

    user.isMuted = !!isMuted;
    user.isDeafened = !!isDeafened;

    if (user.voiceChannelId) {
      io.to(`voice:${user.voiceChannelId}`).emit('voice:user_state', {
        socketId: socket.id,
        userId: user.userId,
        isMuted: user.isMuted,
        isDeafened: user.isDeafened
      });
    }
  });

  // Leave Voice Channel
  socket.on('voice:leave', () => {
    const user = activeUsers.get(socket.id);
    if (!user || !user.voiceChannelId) return;
    leaveVoiceChannel(socket, user);
    broadcastVoiceStatus();
  });

  // Update User Profile (Nickname / Avatar Color / Avatar Picture / Telegram)
  socket.on('user:update', ({ name, avatarColor, avatarUrl, isTelegramVerified, telegramPhone }) => {
    const user = activeUsers.get(socket.id);
    if (!user) return;
    if (name) user.name = name;
    if (avatarColor) user.avatarColor = avatarColor;
    if (avatarUrl !== undefined) user.avatarUrl = avatarUrl;
    if (isTelegramVerified !== undefined) user.isTelegramVerified = !!isTelegramVerified;
    if (telegramPhone !== undefined) user.telegramPhone = telegramPhone;

    broadcastServerPresence();
    if (user.voiceChannelId) {
      io.to(`voice:${user.voiceChannelId}`).emit('voice:user_updated', {
        socketId: socket.id,
        userId: user.userId,
        name: user.name,
        avatarColor: user.avatarColor,
        avatarUrl: user.avatarUrl || null
      });
    }
  });

  // Telegram Authentication: Send Verification Code
  socket.on('auth:telegram:send_code', async ({ phone }) => {
    try {
      if (!phone || typeof phone !== 'string') {
        return socket.emit('auth:telegram:send_code_error', { message: 'Phone number is required.' });
      }

      let cleanPhone = phone.trim().replace(/[\s\-\(\)]/g, '');
      if (!cleanPhone.startsWith('+')) {
        cleanPhone = '+' + cleanPhone;
      }

      if (!/^\+[1-9]\d{6,14}$/.test(cleanPhone)) {
        return socket.emit('auth:telegram:send_code_error', {
          message: 'Invalid phone format. Please include country code, e.g. +12345678900'
        });
      }

      const gatewayToken = process.env.TELEGRAM_GATEWAY_TOKEN;
      if (gatewayToken) {
        // Official Telegram Gateway API integration
        const tgRes = await fetch('https://gatewayapi.telegram.org/sendVerificationMessage', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${gatewayToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            phone_number: cleanPhone,
            ttl: 300
          })
        });

        const tgData = await tgRes.json();
        if (tgData.ok && tgData.result) {
          pendingTelegramAuth.set(cleanPhone, {
            requestId: tgData.result.request_id,
            expiresAt: Date.now() + 300000,
            isGateway: true
          });
          return socket.emit('auth:telegram:code_sent', {
            success: true,
            phone: cleanPhone,
            devMode: false
          });
        } else {
          return socket.emit('auth:telegram:send_code_error', {
            message: tgData.description || 'Telegram Gateway could not deliver message to this phone number.'
          });
        }
      } else {
        // Zero-Config Dev Mode for local development & testing
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        pendingTelegramAuth.set(cleanPhone, {
          code,
          expiresAt: Date.now() + 300000,
          isGateway: false
        });

        console.log(`\n=================================================`);
        console.log(`[Telegram Auth Dev Mode] Code for ${cleanPhone}: ${code}`);
        console.log(`=================================================\n`);

        return socket.emit('auth:telegram:code_sent', {
          success: true,
          phone: cleanPhone,
          devMode: true,
          devCode: code
        });
      }
    } catch (err) {
      console.error('Error in auth:telegram:send_code:', err);
      socket.emit('auth:telegram:send_code_error', { message: 'Failed to send verification code. Try again.' });
    }
  });

  // Telegram Authentication: Verify Code
  socket.on('auth:telegram:verify_code', async ({ phone, code }) => {
    try {
      if (!phone || !code) {
        return socket.emit('auth:telegram:verify_error', { message: 'Phone and code are required.' });
      }

      let cleanPhone = phone.trim().replace(/[\s\-\(\)]/g, '');
      if (!cleanPhone.startsWith('+')) cleanPhone = '+' + cleanPhone;
      const cleanCode = code.toString().trim();

      const session = pendingTelegramAuth.get(cleanPhone);
      if (!session) {
        return socket.emit('auth:telegram:verify_error', { message: 'No verification pending for this phone number. Please request a new code.' });
      }

      if (Date.now() > session.expiresAt) {
        pendingTelegramAuth.delete(cleanPhone);
        return socket.emit('auth:telegram:verify_error', { message: 'Verification code has expired. Please request a new code.' });
      }

      let verified = false;
      const gatewayToken = process.env.TELEGRAM_GATEWAY_TOKEN;

      if (session.isGateway && gatewayToken) {
        const checkRes = await fetch('https://gatewayapi.telegram.org/checkVerificationStatus', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${gatewayToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            request_id: session.requestId,
            code: cleanCode
          })
        });
        const checkData = await checkRes.json();
        if (checkData.ok && checkData.result && checkData.result.status === 'verified') {
          verified = true;
        } else {
          return socket.emit('auth:telegram:verify_error', { message: checkData.description || 'Incorrect code. Please check your Telegram app.' });
        }
      } else {
        // Dev Mode match
        if (session.code === cleanCode) {
          verified = true;
        } else {
          return socket.emit('auth:telegram:verify_error', { message: 'Incorrect verification code. Please try again.' });
        }
      }

      if (verified) {
        pendingTelegramAuth.delete(cleanPhone);

        if (!db.users) db.users = {};
        let userRecord = Object.values(db.users).find(u => u.telegramPhone === cleanPhone);

        const currentActiveUser = activeUsers.get(socket.id);
        const currentUserId = currentActiveUser ? currentActiveUser.userId : ('usr-' + Math.random().toString(36).substring(2, 9));

        if (!userRecord) {
          userRecord = {
            userId: currentUserId,
            name: currentActiveUser?.name?.startsWith('User') ? `TelegramUser_${cleanPhone.slice(-4)}` : (currentActiveUser?.name || `TelegramUser_${cleanPhone.slice(-4)}`),
            avatarColor: currentActiveUser?.avatarColor || '#24A1DE',
            avatarUrl: currentActiveUser?.avatarUrl || null,
            telegramPhone: cleanPhone,
            isTelegramVerified: true,
            createdAt: Date.now()
          };
          db.users[userRecord.userId] = userRecord;
        } else {
          userRecord.isTelegramVerified = true;
          userRecord.lastLogin = Date.now();
        }
        saveStore();

        if (currentActiveUser) {
          currentActiveUser.userId = userRecord.userId;
          currentActiveUser.name = userRecord.name;
          currentActiveUser.avatarColor = userRecord.avatarColor;
          currentActiveUser.avatarUrl = userRecord.avatarUrl;
          currentActiveUser.isTelegramVerified = true;
          currentActiveUser.telegramPhone = cleanPhone;
        }

        socket.emit('auth:telegram:success', { user: userRecord });
        broadcastServerPresence();
      }
    } catch (err) {
      console.error('Error in auth:telegram:verify_code:', err);
      socket.emit('auth:telegram:verify_error', { message: 'Verification failed. Try again.' });
    }
  });

  // Telegram Authentication: Unlink / Logout
  socket.on('auth:telegram:unlink', () => {
    const user = activeUsers.get(socket.id);
    if (!user) return;
    user.isTelegramVerified = false;
    user.telegramPhone = null;
    if (db.users && db.users[user.userId]) {
      db.users[user.userId].isTelegramVerified = false;
      delete db.users[user.userId].telegramPhone;
      saveStore();
    }
    socket.emit('auth:telegram:unlinked');
    broadcastServerPresence();
  });

  // Disconnect
  socket.on('disconnect', () => {
    const user = activeUsers.get(socket.id);
    if (user) {
      if (user.voiceChannelId) {
        leaveVoiceChannel(socket, user);
      }
      activeUsers.delete(socket.id);
      broadcastServerPresence();
      broadcastVoiceStatus();
    }
  });
});

function leaveVoiceChannel(socket, user) {
  const channelId = user.voiceChannelId;
  if (!channelId) return;

  socket.leave(`voice:${channelId}`);
  if (voiceRooms.has(channelId)) {
    voiceRooms.get(channelId).delete(socket.id);
    if (voiceRooms.get(channelId).size === 0) {
      voiceRooms.delete(channelId);
    }
  }

  socket.to(`voice:${channelId}`).emit('voice:user_left', {
    socketId: socket.id,
    userId: user.userId
  });

  user.voiceChannelId = null;
  user.isSpeaking = false;
}

function broadcastServerPresence() {
  const allUsersList = [];
  const serverUsersMap = {};

  for (const [_, user] of activeUsers.entries()) {
    if (!user.serverId) continue;
    const serverObj = db.servers[user.serverId];
    const srvName = serverObj ? serverObj.name : 'Hangout';
    const nickname = (db.nicknames && db.nicknames[user.serverId] && db.nicknames[user.serverId][user.userId]) || null;
    let role = (db.roles && db.roles[user.serverId] && db.roles[user.serverId][user.userId]) || null;
    if (!role) {
      if (serverObj && serverObj.ownerId === user.userId) {
        role = 'owner';
      } else {
        role = 'member';
      }
    }
    const memberObj = {
      socketId: user.socketId,
      userId: user.userId,
      name: user.name,
      nickname: nickname,
      role: role,
      avatarColor: user.avatarColor,
      avatarUrl: user.avatarUrl || null,
      isTelegramVerified: user.isTelegramVerified || false,
      telegramPhone: user.telegramPhone || null,
      serverId: user.serverId,
      serverName: srvName,
      voiceChannelId: user.voiceChannelId,
      isCameraOn: user.isCameraOn || false,
      isScreenSharing: user.isScreenSharing || false
    };

    allUsersList.push(memberObj);

    if (!serverUsersMap[user.serverId]) serverUsersMap[user.serverId] = [];
    serverUsersMap[user.serverId].push(memberObj);
  }

  for (const [serverId, members] of Object.entries(serverUsersMap)) {
    io.to(`server:${serverId}`).emit('server:members', { serverId, members });
  }
  // Global sync event with all active users
  io.emit('server:members_all', { serverUsersMap, allUsersList });
}

function broadcastVoiceStatus() {
  const voiceState = {};
  for (const [channelId, socketSet] of voiceRooms.entries()) {
    voiceState[channelId] = Array.from(socketSet).map(sid => {
      const u = activeUsers.get(sid);
      return u ? {
        socketId: sid,
        userId: u.userId,
        name: u.name,
        avatarColor: u.avatarColor,
        avatarUrl: u.avatarUrl || null,
        isSpeaking: u.isSpeaking,
        isCameraOn: u.isCameraOn || false,
        isScreenSharing: u.isScreenSharing || false
      } : null;
    }).filter(Boolean);
  }
  io.emit('voice:room_occupancy', voiceState);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`===============================================`);
  console.log(`  CordLite Discord Clone Server Running!`);
  console.log(`  Local URL:        http://localhost:${PORT}`);
  console.log(`  Network (Share):  http://<your-local-ip>:${PORT}`);
  console.log(`===============================================`);
});
