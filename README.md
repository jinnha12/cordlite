# 🎮 CordLite — Lightweight Discord Clone

A fast, streamlined Discord alternative built for private hangouts with friends without censorship or sign-in walls. Just open the app or share an invite link, enter a nickname, and talk!

---

## ✨ Features

- **No Sign-In Required**: Zero accounts, phone numbers, or passwords. Join instantly with a nickname.
- **Discord-Accurate Dark UI**: 3-panel layout, authentic dark theme, Blurple branding, channel switching, and micro-interactions.
- **Real-Time Text Chat**: Instant messaging powered by WebSockets, message markdown (`**bold**`, `*italic*`, ```code```), and file/image uploads.
- **Live WebRTC Voice Channels**:
  - Peer-to-peer audio streaming with Google STUN servers.
  - **Voice Activity Detection (VAD)**: Real-time Web Audio API analyzer with Discord's green pulsing speaking indicator rings.
  - Mic Mute and Headphone Deafen controls with synthesized tactile blip sound effects.
  - Connect/disconnect chimes.
- **Server & Channel Management**:
  - Create multiple custom servers with custom emoji badges.
  - Add unlimited Text and Voice channels under categories.
  - Auto-seeds a default "Friends Hangout" server with `#general` and `🔊 Voice Lounge`.
- **Instant Invite Sharing**:
  - One-click copy invite links (`/?invite=server-id`).
  - Friends clicking your invite link land directly inside your server.

---

## 🚀 Quick Start (Local Run)

1. Make sure Node.js is installed.
2. Open terminal in the `cordlite` directory:
   ```powershell
   npm install
   npm start
   ```
3. Open your browser at:
   ```
   http://localhost:3000
   ```

---

## 🌐 How to Connect with Friends

### Option 1: Free Cloud Hosting (Recommended for Global Friends)
Deploy for free on [Render](https://render.com) or [Railway](https://railway.app):
1. Push this folder to a GitHub repository.
2. Create a **New Web Service** on Render or Railway, link your repo.
3. Build Command: `npm install`
4. Start Command: `npm start`
5. You'll receive a public HTTPS link (e.g. `https://cordlite.onrender.com`) that you can send to any friend worldwide.

### Option 2: Cloudflare Tunnel (Free & No Port Forwarding)
You can expose your local server directly using Cloudflare's free tunnel:
```powershell
# Using cloudflared (quick tunnel):
cloudflared tunnel --url http://localhost:3000
```
It gives you a free secure HTTPS URL to send to your friends!

### Option 3: Local Network (Same Wi-Fi or VPN)
If you and your friends are on the same Wi-Fi or connected via a virtual LAN like Tailscale / ZeroTier:
1. Find your local IP (`ipconfig` in PowerShell, look for IPv4 address e.g. `192.168.1.50`).
2. Friends can join by navigating to:
   ```
   http://192.168.1.50:3000
   ```
