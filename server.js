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
      icon: '🎮',
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
  }
};

let db = defaultState;
try {
  if (fs.existsSync(STORE_PATH)) {
    const raw = fs.readFileSync(STORE_PATH, 'utf-8');
    db = JSON.parse(raw);
    if (!db.servers) db.servers = defaultState.servers;
    if (!db.messages) db.messages = defaultState.messages;
  } else {
    fs.writeFileSync(STORE_PATH, JSON.stringify(defaultState, null, 2));
  }
} catch (e) {
  console.warn('Error reading store.json, using default state:', e);
  db = defaultState;
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

io.on('connection', (socket) => {
  // Register user profile
  socket.on('user:register', (userData) => {
    const targetServerId = userData.serverId || 'friends-hangout';
    activeUsers.set(socket.id, {
      socketId: socket.id,
      userId: userData.userId || socket.id,
      name: userData.name || 'Anonymous',
      avatarColor: userData.avatarColor || '#5865F2',
      serverId: targetServerId,
      channelId: null,
      voiceChannelId: null,
      isMuted: false,
      isDeafened: false,
      isSpeaking: false
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
    const serverId = 'srv-' + Math.random().toString(36).substring(2, 9);
    const newServer = {
      id: serverId,
      name: name || 'New Hangout',
      icon: icon || '💬',
      created: Date.now(),
      channels: [
        { id: `c-${serverId}-gen`, name: 'general', type: 'text' },
        { id: `v-${serverId}-gen`, name: 'Voice Lounge', type: 'voice' }
      ]
    };
    db.servers[serverId] = newServer;
    saveStore();

    io.emit('server:list', Object.values(db.servers));
    socket.emit('server:created', newServer);
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
        avatarColor: user.avatarColor
      },
      text: text || '',
      attachment: attachment || null,
      timestamp: Date.now()
    };

    db.messages[channelId].push(message);
    if (db.messages[channelId].length > 300) {
      db.messages[channelId] = db.messages[channelId].slice(-300);
    }
    saveStore();

    // Broadcast message to everyone in this server
    io.to(`server:${serverId}`).emit('chat:message', message);
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
            isMuted: otherUser.isMuted,
            isDeafened: otherUser.isDeafened,
            isSpeaking: otherUser.isSpeaking
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
      isMuted: user.isMuted,
      isDeafened: user.isDeafened,
      isSpeaking: user.isSpeaking
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
        avatarColor: user.avatarColor
      },
      audioData,
      sampleRate
    });
  });

  // WebRTC Signal forwarding (offer, answer, ICE candidate)
  socket.on('voice:signal', ({ toSocketId, signal }) => {
    const sender = activeUsers.get(socket.id);
    if (!sender) return;

    io.to(toSocketId).emit('voice:signal', {
      fromSocketId: socket.id,
      fromUser: {
        userId: sender.userId,
        name: sender.name,
        avatarColor: sender.avatarColor
      },
      signal
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

  // Update User Profile (Nickname / Avatar Color)
  socket.on('user:update', ({ name, avatarColor }) => {
    const user = activeUsers.get(socket.id);
    if (!user) return;
    if (name) user.name = name;
    if (avatarColor) user.avatarColor = avatarColor;

    broadcastServerPresence();
    if (user.voiceChannelId) {
      io.to(`voice:${user.voiceChannelId}`).emit('voice:user_updated', {
        socketId: socket.id,
        userId: user.userId,
        name: user.name,
        avatarColor: user.avatarColor
      });
    }
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
  // Broadcast active members grouped by server
  const serverUsersMap = {};
  for (const [_, user] of activeUsers.entries()) {
    if (!user.serverId) continue;
    if (!serverUsersMap[user.serverId]) serverUsersMap[user.serverId] = [];
    serverUsersMap[user.serverId].push({
      userId: user.userId,
      name: user.name,
      avatarColor: user.avatarColor,
      voiceChannelId: user.voiceChannelId
    });
  }

  for (const [serverId, members] of Object.entries(serverUsersMap)) {
    io.to(`server:${serverId}`).emit('server:members', { serverId, members });
  }
  // Global sync event
  io.emit('server:members_all', serverUsersMap);
}

function broadcastVoiceStatus() {
  const voiceState = {};
  for (const [channelId, socketSet] of voiceRooms.entries()) {
    voiceState[channelId] = Array.from(socketSet).map(sid => {
      const u = activeUsers.get(sid);
      return u ? { socketId: sid, userId: u.userId, name: u.name, avatarColor: u.avatarColor, isSpeaking: u.isSpeaking } : null;
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
