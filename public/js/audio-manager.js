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
}

window.audioManager = new AudioManager();
