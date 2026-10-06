const http = require('http');
const ioClient = require('socket.io-client');
const fs = require('fs');

async function runTests() {
  console.log('--- Starting CordLite Features E2E Test Suite ---');
  let failures = 0;

  // 1. Verify Static Assets
  const assets = [
    'http://localhost:3000/',
    'http://localhost:3000/css/style.css',
    'http://localhost:3000/js/icons.js?v=10',
    'http://localhost:3000/js/audio-manager.js?v=10',
    'http://localhost:3000/js/webrtc-voice.js?v=10',
    'http://localhost:3000/js/app.js?v=10'
  ];

  for (const asset of assets) {
    await new Promise((resolve) => {
      http.get(asset, (res) => {
        if (res.statusCode === 200) {
          console.log(`[PASS] Asset GET ${asset} -> 200 OK`);
        } else {
          console.error(`[FAIL] Asset GET ${asset} -> ${res.statusCode}`);
          failures++;
        }
        resolve();
      }).on('error', (e) => {
        console.error(`[FAIL] Asset GET ${asset} error:`, e.message);
        failures++;
        resolve();
      });
    });
  }

  // 2. Connect 2 Sockets for Collaboration
  const client1 = ioClient('http://localhost:3000', { reconnection: false });
  const client2 = ioClient('http://localhost:3000', { reconnection: false });

  await new Promise((resolve) => {
    let connected = 0;
    const check = () => { if (++connected === 2) resolve(); };
    client1.on('connect', check);
    client2.on('connect', check);
  });
  console.log('[PASS] Socket clients 1 & 2 connected');

  // Register users
  client1.emit('user:register', {
    userId: 'test-user-1',
    name: 'Alice',
    avatarColor: '#5865F2',
    avatarUrl: '/uploads/alice.png',
    serverId: 'friends-hangout'
  });

  client2.emit('user:register', {
    userId: 'test-user-2',
    name: 'Bob',
    avatarColor: '#eb459e',
    avatarUrl: null,
    serverId: 'friends-hangout'
  });

  await new Promise(r => setTimeout(r, 200));

  // Test Join Voice Channel
  client1.emit('voice:join', { serverId: 'friends-hangout', channelId: 'v-general' });
  client2.emit('voice:join', { serverId: 'friends-hangout', channelId: 'v-general' });

  await new Promise(r => setTimeout(r, 200));

  // Test Feature 1: Video State Broadcast
  await new Promise((resolve) => {
    client2.on('voice:video_state', (data) => {
      if (data.userId === 'test-user-1' && data.isScreenSharing === true) {
        console.log('[PASS] Feature 1: Screen sharing state successfully broadcast to peer!');
        resolve();
      }
    });
    client1.emit('voice:video_state', {
      channelId: 'v-general',
      isCameraOn: false,
      isScreenSharing: true
    });
  });

  // Test Feature 1: Stream Request Negotiation
  await new Promise((resolve) => {
    client1.on('voice:request_stream', (data) => {
      if (data.fromUserId === 'test-user-2') {
        console.log(`[PASS] Feature 1: Peer stream request received from ${data.fromName}!`);
        resolve();
      }
    });
    client2.emit('voice:request_stream', {
      toSocketId: client1.id
    });
  });

  // Test Feature 1: Live Screen WebSocket Frame Relay (Dual-Engine Fallback)
  await new Promise((resolve) => {
    client2.on('voice:screen_frame', (data) => {
      if (data.fromUserId === 'test-user-1' && data.frameData === 'data:image/jpeg;base64,testframe') {
        console.log('[PASS] Feature 1: Live screen frame relay successfully received by peer!');
        resolve();
      }
    });
    client1.emit('voice:screen_frame', {
      channelId: 'v-general',
      frameData: 'data:image/jpeg;base64,testframe'
    });
  });

  // Test Feature 4: Soundboard Playback Broadcast
  await new Promise((resolve) => {
    client2.on('voice:soundboard', (data) => {
      if (data.soundId === 'airhorn') {
        console.log(`[PASS] Feature 4: Soundboard sound "${data.soundId}" received from ${data.fromName}!`);
        resolve();
      }
    });
    client1.emit('voice:soundboard', {
      channelId: 'v-general',
      soundId: 'airhorn'
    });
  });

  // Test Feature 5: Message Sending & Reaction Toggle
  let testMsgId = null;
  await new Promise((resolve) => {
    client2.on('chat:message', (msg) => {
      testMsgId = msg.id;
      console.log(`[PASS] Chat message sent and received: "${msg.text}" (ID: ${msg.id})`);
      resolve();
    });
    client1.emit('chat:send', {
      serverId: 'friends-hangout',
      channelId: 'c-general',
      text: 'CordLite testing new features!'
    });
  });

  // Bob reacts to Alice's message with 'heart'
  await new Promise((resolve) => {
    client1.on('chat:reaction_updated', ({ channelId, messageId, reactions }) => {
      if (messageId === testMsgId && reactions.heart && reactions.heart.includes('test-user-2')) {
        console.log('[PASS] Feature 5: Message reaction "heart" successfully toggled and synced!');
        resolve();
      }
    });
    client2.emit('chat:reaction', {
      serverId: 'friends-hangout',
      channelId: 'c-general',
      messageId: testMsgId,
      reactionType: 'heart'
    });
  });

  client1.disconnect();
  client2.disconnect();

  if (failures === 0) {
    console.log('\n*** ALL LIVE STREAMING & SOCIAL FEATURES VERIFIED SUCCESSFULLY! ***\n');
    process.exit(0);
  } else {
    console.error(`\nTest suite finished with ${failures} failures.\n`);
    process.exit(1);
  }
}

runTests();
