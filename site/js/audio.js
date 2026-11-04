'use strict';
// Synthetischer Sound mit WebAudio (keine Audiodateien nötig)
const Sound = {
  ctx: null, master: null, vol: 0.6, muted: false, noiseBuf: null, engine: null, last: {},
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.vol;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 1.5;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } catch (e) { this.ctx = null; }
  },
  setVolume(v) { this.vol = v; if (this.master) this.master.gain.value = this.muted ? 0 : v; },
  setMuted(m) { this.muted = m; if (this.master) this.master.gain.value = m ? 0 : this.vol; },
  _gain(v, t0, dur) {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(v, t0);
    g.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
    g.connect(this.master);
    return g;
  },
  noise(dur, freq, v, type = 'lowpass', q = 1) {
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource(); s.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    s.connect(f); f.connect(this._gain(v, t, dur));
    s.start(t, Math.random() * 0.5); s.stop(t + dur);
    return f;
  },
  tone(freq, dur, v, type = 'square', slide = 0, delay = 0) {
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * slide), t + dur);
    o.connect(this._gain(v, t, dur));
    o.start(t); o.stop(t + dur);
  },
  // vol 0..1 abhängig von Entfernung
  play(name, vol = 1) {
    if (!this.ctx || this.muted || this.quiet || vol < 0.03) return;
    const now = this.ctx.currentTime;
    const minGap = { mg: 0.04, mini: 0.035, hit: 0.03, shotgun: 0.05 }[name] || 0.015;
    if (this.last[name] && now - this.last[name] < minGap) return;
    this.last[name] = now;
    switch (name) {
      case 'mg': this.noise(0.07, 2400, 0.25 * vol, 'bandpass', 1.2); this.tone(180, 0.05, 0.06 * vol, 'square', 0.5); break;
      case 'mini': this.noise(0.045, 3200, 0.16 * vol, 'bandpass', 1.5); break;
      case 'shotgun': this.noise(0.22, 1400, 0.45 * vol); this.tone(90, 0.12, 0.15 * vol, 'sawtooth', 0.4); break;
      case 'cannon': this.noise(0.4, 600, 0.6 * vol); this.tone(70, 0.3, 0.3 * vol, 'sine', 0.3); break;
      case 'rocket': this.noise(0.5, 1800, 0.2 * vol, 'bandpass', 0.7); this.tone(300, 0.4, 0.05 * vol, 'sawtooth', 2.5); break;
      case 'boom': this.noise(0.9, 380, 0.8 * vol); this.tone(55, 0.6, 0.45 * vol, 'sine', 0.35); break;
      case 'bigboom': this.noise(1.4, 260, 1.0 * vol); this.tone(45, 1.0, 0.6 * vol, 'sine', 0.3); break;
      case 'hit': this.tone(900 + Math.random() * 300, 0.04, 0.07 * vol, 'square', 0.6); break;
      case 'clank': this.noise(0.15, 900, 0.3 * vol, 'bandpass', 3); break;
      case 'jump': this.tone(160, 0.25, 0.18 * vol, 'triangle', 2.2); break;
      case 'land': this.noise(0.18, 300, 0.35 * vol); break;
      case 'boost': this.noise(0.5, 900, 0.22 * vol, 'bandpass', 0.6); break;
      case 'pickup': this.tone(660, 0.1, 0.15, 'square'); this.tone(990, 0.15, 0.15, 'square', 1, 0.08); break;
      case 'coin': this.tone(1320, 0.08, 0.12, 'square'); this.tone(1760, 0.18, 0.12, 'square', 1, 0.07); break;
      case 'flag': this.tone(440, 0.12, 0.2, 'square'); this.tone(660, 0.12, 0.2, 'square', 1, 0.1); this.tone(880, 0.25, 0.2, 'square', 1, 0.2); break;
      case 'capture': [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.3, 0.2, 'square', 1, i * 0.12)); break;
      case 'lost': [440, 370, 311, 262].forEach((f, i) => this.tone(f, 0.3, 0.18, 'sawtooth', 1, i * 0.13)); break;
      case 'splash': this.noise(0.8, 1200, 0.4 * vol, 'lowpass'); break;
      case 'crate': this.noise(0.25, 700, 0.35 * vol, 'bandpass', 2); this.tone(120, 0.1, 0.1 * vol, 'square', 0.5); break;
      case 'mine': this.tone(1200, 0.06, 0.1, 'square'); break;
      case 'click': this.tone(700, 0.05, 0.08, 'square'); break;
      case 'buy': [784, 988, 1175].forEach((f, i) => this.tone(f, 0.15, 0.15, 'square', 1, i * 0.07)); break;
      case 'countdown': this.tone(600, 0.15, 0.2, 'square'); break;
      case 'go': this.tone(1200, 0.4, 0.2, 'square'); break;
    }
  },
  // Motorgeräusch des Spielers
  engineUpdate(speedFrac, boosting, on) {
    if (!this.ctx || this.quiet) return;
    if (!this.engine) {
      const o = this.ctx.createOscillator(); o.type = 'sawtooth';
      const o2 = this.ctx.createOscillator(); o2.type = 'square';
      const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 500;
      const g = this.ctx.createGain(); g.gain.value = 0;
      o.connect(f); o2.connect(f); f.connect(g); g.connect(this.master);
      o.start(); o2.start();
      this.engine = { o, o2, f, g };
    }
    const e = this.engine, t = this.ctx.currentTime;
    const base = 45 + speedFrac * 95 + (boosting ? 40 : 0);
    e.o.frequency.setTargetAtTime(base, t, 0.08);
    e.o2.frequency.setTargetAtTime(base * 0.502, t, 0.08);
    e.f.frequency.setTargetAtTime(350 + speedFrac * 900 + (boosting ? 600 : 0), t, 0.1);
    e.g.gain.setTargetAtTime(on ? 0.05 + speedFrac * 0.04 : 0, t, 0.1);
  },
  engineStop() { if (this.engine) this.engine.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05); },
};
