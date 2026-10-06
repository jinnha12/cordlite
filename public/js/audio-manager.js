/**
 * AudioManager - Synthesized Discord Sound Effects & Voice Activity Detection (VAD)
 */
class AudioManager {
  constructor() {
    this.ctx = null;
    this.micAnalyser = null;
    this.micSource = null;
    this.vadInterval = null;
    this.isSpeaking = false;
    this.speakingSilenceTimeout = null;
  }

  getAudioContext() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    return this.ctx;
  }

  // Voice Connected Chime (Ascending two-tone like Discord)
  playJoin() {
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;
      const now = ctx.currentTime;

      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();

      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.15, now + 0.05);
      gain.gain.linearRampToValueAtTime(0.12, now + 0.18);
      gain.gain.linearRampToValueAtTime(0.15, now + 0.22);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);

      osc1.type = 'sine';
      osc2.type = 'triangle';

      osc1.frequency.setValueAtTime(330, now); // E4
      osc1.frequency.setValueAtTime(440, now + 0.2); // A4

      osc2.frequency.setValueAtTime(330, now);
      osc2.frequency.setValueAtTime(440, now + 0.2);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);

      osc1.start(now);
      osc2.start(now);
      osc1.stop(now + 0.6);
      osc2.stop(now + 0.6);
    } catch (e) {
      console.warn('Audio playJoin error:', e);
    }
  }

  // Voice Disconnect Chime (Descending two-tone like Discord)
  playLeave() {
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;
      const now = ctx.currentTime;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.15, now + 0.05);
      gain.gain.linearRampToValueAtTime(0.1, now + 0.16);
      gain.gain.linearRampToValueAtTime(0.14, now + 0.2);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, now); // A4
      osc.frequency.setValueAtTime(330, now + 0.18); // E4

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.55);
    } catch (e) {
      console.warn('Audio playLeave error:', e);
    }
  }

  // Mute / Unmute Blip
  playMute(isMuted) {
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;
      const now = ctx.currentTime;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.12, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

      osc.type = 'triangle';
      osc.frequency.setValueAtTime(isMuted ? 320 : 540, now);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.16);
    } catch (e) {
      console.warn('Audio playMute error:', e);
    }
  }

  // Incoming Message Ping
  playMessage() {
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;
      const now = ctx.currentTime;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.08, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);

      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, now); // D5
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.08); // A5

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + 0.25);
    } catch (e) {
      console.warn('Audio playMessage error:', e);
    }
  }

  // Voice Activity Detection (VAD) via microphone stream
  startVAD(stream, onSpeakingChange) {
    this.stopVAD();
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;

      this.micSource = ctx.createMediaStreamSource(stream);
      this.micAnalyser = ctx.createAnalyser();
      this.micAnalyser.fftSize = 512;
      this.micAnalyser.smoothingTimeConstant = 0.4;
      this.micSource.connect(this.micAnalyser);

      const bufferLength = this.micAnalyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      const THRESHOLD = 22; // RMS voice sensitivity threshold

      this.vadInterval = setInterval(() => {
        if (!this.micAnalyser) return;
        this.micAnalyser.getByteFrequencyData(dataArray);

        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const average = sum / bufferLength;

        if (average > THRESHOLD) {
          if (this.speakingSilenceTimeout) {
            clearTimeout(this.speakingSilenceTimeout);
            this.speakingSilenceTimeout = null;
          }
          if (!this.isSpeaking) {
            this.isSpeaking = true;
            onSpeakingChange(true);
          }
        } else if (this.isSpeaking && !this.speakingSilenceTimeout) {
          this.speakingSilenceTimeout = setTimeout(() => {
            this.isSpeaking = false;
            this.speakingSilenceTimeout = null;
            onSpeakingChange(false);
          }, 350);
        }
      }, 50);
    } catch (e) {
      console.warn('VAD initialization failed:', e);
    }
  }

  stopVAD() {
    if (this.vadInterval) {
      clearInterval(this.vadInterval);
      this.vadInterval = null;
    }
    if (this.speakingSilenceTimeout) {
      clearTimeout(this.speakingSilenceTimeout);
      this.speakingSilenceTimeout = null;
    }
    if (this.micSource) {
      try { this.micSource.disconnect(); } catch (e) {}
      this.micSource = null;
    }
    this.micAnalyser = null;
    this.isSpeaking = false;
  }

  // Feature 2: Push-to-Talk (PTT) Chimes
  playPttActivate() {
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.12, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now); // A5 chime

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.13);
    } catch (e) {
      console.warn('playPttActivate error:', e);
    }
  }

  playPttDeactivate() {
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(0.1, now + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

      osc.type = 'sine';
      osc.frequency.setValueAtTime(659.25, now); // E5 chime

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.13);
    } catch (e) {
      console.warn('playPttDeactivate error:', e);
    }
  }

  // Feature 4: Soundboard Synthesized Audio Clips
  playSoundboard(soundId) {
    switch (soundId) {
      case 'airhorn': this.playAirhorn(); break;
      case 'rimshot': this.playRimshot(); break;
      case 'laser': this.playLaser(); break;
      case 'quack': this.playQuack(); break;
      case 'fanfare': this.playFanfare(); break;
      case 'ding': this.playDing(); break;
      case 'gong': this.playGong(); break;
      case 'oof': this.playOof(); break;
      default: this.playDing(); break;
    }
  }

  playAirhorn() {
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const freqs = [466.16, 622.25, 698.46, 932.33]; // Bb minor brass chord
      freqs.forEach((freq) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, now);
        
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.06, now + 0.04);
        gain.gain.setValueAtTime(0.06, now + 0.35);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.65);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.68);
      });
    } catch (e) {
      console.warn('playAirhorn error:', e);
    }
  }

  playRimshot() {
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      // "Ba-dum"
      [0, 0.15].forEach((offset, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(idx === 0 ? 150 : 120, now + offset);
        gain.gain.setValueAtTime(0.18, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.1);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + offset);
        osc.stop(now + offset + 0.12);
      });
      // "Tss" crash cymbal
      const node = ctx.createBufferSource();
      const buffer = ctx.createBuffer(1, ctx.sampleRate * 0.4, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < buffer.length; i++) data[i] = Math.random() * 2 - 1;
      node.buffer = buffer;
      const cymbalGain = ctx.createGain();
      cymbalGain.gain.setValueAtTime(0.15, now + 0.32);
      cymbalGain.gain.exponentialRampToValueAtTime(0.001, now + 0.72);
      node.connect(cymbalGain);
      cymbalGain.connect(ctx.destination);
      node.start(now + 0.32);
    } catch (e) {
      console.warn('playRimshot error:', e);
    }
  }

  playLaser() {
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(1200, now);
      osc.frequency.exponentialRampToValueAtTime(80, now + 0.28);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.32);
    } catch (e) {
      console.warn('playLaser error:', e);
    }
  }

  playQuack() {
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.setValueAtTime(280, now);
      osc.frequency.linearRampToValueAtTime(380, now + 0.08);
      osc.frequency.linearRampToValueAtTime(240, now + 0.22);
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.26);
    } catch (e) {
      console.warn('playQuack error:', e);
    }
  }

  playFanfare() {
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const notes = [
        { f: 523.25, t: 0, d: 0.12 },     // C5
        { f: 659.25, t: 0.12, d: 0.12 },  // E5
        { f: 783.99, t: 0.24, d: 0.12 },  // G5
        { f: 1046.50, t: 0.36, d: 0.4 }   // C6
      ];
      notes.forEach(n => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(n.f, now + n.t);
        gain.gain.setValueAtTime(0.15, now + n.t);
        gain.gain.exponentialRampToValueAtTime(0.001, now + n.t + n.d);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + n.t);
        osc.stop(now + n.t + n.d + 0.05);
      });
    } catch (e) {
      console.warn('playFanfare error:', e);
    }
  }

  playDing() {
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1046.50, now); // C6
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.65);
    } catch (e) {
      console.warn('playDing error:', e);
    }
  }

  playGong() {
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      [110, 164.8, 220].forEach(f => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(f, now);
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 1.25);
      });
    } catch (e) {
      console.warn('playGong error:', e);
    }
  }

  playOof() {
    try {
      const ctx = this.getAudioContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(320, now);
      osc.frequency.exponentialRampToValueAtTime(90, now + 0.2);
      gain.gain.setValueAtTime(0.18, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.23);
    } catch (e) {
      console.warn('playOof error:', e);
    }
  }
}

window.audioManager = new AudioManager();
