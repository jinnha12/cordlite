const { io } = require('socket.io-client');

const client1 = io('http://localhost:3000');
const client2 = io('http://localhost:3000');

let client1Members = [];
let client2Members = [];
let msgReceived = false;
let audioReceived = false;

client1.on('connect', () => {
  console.log('[Client 1] Connected:', client1.id);
  client1.emit('user:register', {
    userId: 'user-1',
    name: 'Jin',
    avatarColor: '#5865F2',
    serverId: 'friends-hangout'
  });
});

client2.on('connect', () => {
  console.log('[Client 2] Connected:', client2.id);
  client2.emit('user:register', {
    userId: 'user-2',
    name: 'Friend',
    avatarColor: '#57F287',
    serverId: 'friends-hangout'
  });
});

client1.on('server:members', ({ serverId, members }) => {
  console.log('[Client 1] Received members for', serverId, ':', members.map(m => m.name));
  client1Members = members;
});

client2.on('server:members', ({ serverId, members }) => {
  console.log('[Client 2] Received members for', serverId, ':', members.map(m => m.name));
  client2Members = members;
});

client2.on('chat:message', (msg) => {
  console.log('[Client 2] Received chat message:', msg.user.name, '->', msg.text);
  msgReceived = true;
});

client2.on('voice:audio_stream', ({ fromUser, audioData }) => {
  console.log('[Client 2] Received voice audio stream from', fromUser.name, 'bytes:', audioData.byteLength || audioData.length);
  audioReceived = true;
});

setTimeout(() => {
  console.log('\n--- Testing Chat Message Broadcast ---');
  client1.emit('chat:send', {
    serverId: 'friends-hangout',
    channelId: 'c-general',
    text: 'Hello from Jin!'
  });
}, 1000);

setTimeout(() => {
  console.log('\n--- Testing Voice Channel Join & Audio Stream ---');
  client1.emit('voice:join', { serverId: 'friends-hangout', channelId: 'v-general' });
  client2.emit('voice:join', { serverId: 'friends-hangout', channelId: 'v-general' });
}, 1500);

setTimeout(() => {
  const dummyPcm = new Int16Array(2048);
  for (let i = 0; i < dummyPcm.length; i++) dummyPcm[i] = 1000;
  client1.emit('voice:audio_stream', {
    channelId: 'v-general',
    audioData: dummyPcm.buffer,
    sampleRate: 48000
  });
}, 2000);

setTimeout(() => {
  console.log('\n--- Final Verification Summary ---');
  console.log('Client 1 saw members count:', client1Members.length);
  console.log('Client 2 saw members count:', client2Members.length);
  console.log('Chat message received by Client 2:', msgReceived);
  console.log('Voice audio stream received by Client 2:', audioReceived);

  client1.disconnect();
  client2.disconnect();
  process.exit(0);
}, 3000);
