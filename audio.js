// Web Audio engine: looping background track + sound effects.
// Uploaded files come from the IndexedDB media library; any slot without a file uses a
// small synthesized fallback so the show always has sound.
import { getMedia, getSetting, setSetting } from './db.js';

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();   // mediaId -> AudioBuffer
    this.sfxMap = {};           // slot -> mediaId
    this.bgId = null;
    this.bgNode = null;
    this.bgVolume = 0.35;
    this.muted = false;
    this.listeners = new Set();
    this._lastAnswerFx = 0;
    getSetting('muted', false).then((m) => { this.muted = m; this._applyMute(); this._notify(); });
  }

  /** Must be called from a user gesture at least once (autoplay policy). */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.bgGain = this.ctx.createGain();
      this.bgGain.connect(this.master);
      this.fxGain = this.ctx.createGain();
      this.fxGain.gain.value = 0.9;
      this.fxGain.connect(this.master);
      this._applyMute();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _notify() { this.listeners.forEach((fn) => fn(this)); }

  _applyMute() {
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 1, this.ctx.currentTime, 0.04);
  }
  setMuted(m) { this.muted = !!m; this._applyMute(); setSetting('muted', this.muted); this._notify(); }
  toggleMute() { this.setMuted(!this.muted); }

  async _buffer(id) {
    if (!id || !this.ctx) return null;
    if (this.buffers.has(id)) return this.buffers.get(id);
    const item = await getMedia(id);
    if (!item) return null;
    try {
      const buf = await this.ctx.decodeAudioData(await item.blob.arrayBuffer());
      this.buffers.set(id, buf);
      return buf;
    } catch (e) {
      console.warn('decode failed', item.name, e);
      return null;
    }
  }

  async configure(project) {
    this.sfxMap = { ...(project.sfx || {}) };
    this.bgVolume = project.bgVolume ?? 0.35;
    if (this.bgGain) this.bgGain.gain.value = this.bgVolume;
    if (this.bgId !== project.bgTrackId) {
      const wasPlaying = !!this.bgNode;
      this.stopBg();
      this.bgId = project.bgTrackId;
      if (wasPlaying) this.playBg();
    }
  }

  get bgPlaying() { return !!this.bgNode; }

  async playBg() {
    this.unlock();
    if (!this.ctx || !this.bgId || this.bgNode) return;
    const buf = await this._buffer(this.bgId);
    if (!buf || this.bgNode) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(this.bgGain);
    this.bgGain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.bgGain.gain.setValueAtTime(0, this.ctx.currentTime);
    this.bgGain.gain.linearRampToValueAtTime(this.bgVolume, this.ctx.currentTime + 1.2);
    src.start();
    this.bgNode = src;
    this._notify();
  }

  stopBg() {
    if (!this.bgNode) return;
    const n = this.bgNode;
    this.bgNode = null;
    try {
      this.bgGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.25);
      n.stop(this.ctx.currentTime + 1);
    } catch (e) { /* */ }
    this._notify();
  }

  toggleBg() { this.bgPlaying ? this.stopBg() : this.playBg(); }

  /** Duck the background track (e.g. while the timer runs). */
  duck(on) {
    if (!this.bgGain || !this.ctx) return;
    this.bgGain.gain.setTargetAtTime(on ? this.bgVolume * 0.45 : this.bgVolume, this.ctx.currentTime, 0.3);
  }

  async sfx(slot) {
    if (!this.ctx || this.muted) return;
    if (slot === 'answer') {           // throttle — many answers can arrive at once
      const now = performance.now();
      if (now - this._lastAnswerFx < 70) return;
      this._lastAnswerFx = now;
    }
    const buf = await this._buffer(this.sfxMap[slot]);
    if (buf) {
      const s = this.ctx.createBufferSource();
      s.buffer = buf;
      s.connect(this.fxGain);
      s.start();
      return;
    }
    this._synth(slot);
  }

  /** Previews any media item regardless of project (dashboard). */
  async preview(id) {
    this.unlock();
    this.stopPreview();
    const buf = await this._buffer(id);
    if (!buf) return;
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.connect(this.master);
    s.start();
    this.previewNode = s;
    s.onended = () => { if (this.previewNode === s) { this.previewNode = null; this._notify(); } };
    this._notify();
  }
  stopPreview() { try { this.previewNode?.stop(); } catch (e) { /* */ } this.previewNode = null; this._notify(); }

  _tone(freq, t0, dur, { type = 'sine', vol = 0.25, slide = 0 } = {}) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.fxGain);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  _synth(slot) {
    const t = this.ctx.currentTime;
    switch (slot) {
      case 'tick': this._tone(1200, t, 0.06, { type: 'square', vol: 0.08 }); break;
      case 'answer': this._tone(520 + Math.random() * 420, t, 0.12, { type: 'triangle', vol: 0.09, slide: 1.6 }); break;
      case 'timeup':
        this._tone(440, t, 0.25, { type: 'sawtooth', vol: 0.12 });
        this._tone(330, t + 0.22, 0.45, { type: 'sawtooth', vol: 0.12 });
        break;
      case 'reveal':
        [523, 659, 784, 1046].forEach((f, i) => this._tone(f, t + i * 0.09, 0.5, { type: 'triangle', vol: 0.16 }));
        break;
      case 'start': this._tone(660, t, 0.15, { vol: 0.14 }); this._tone(990, t + 0.12, 0.2, { vol: 0.14 }); break;
      default: break;
    }
  }
}

export const audio = new AudioEngine();
