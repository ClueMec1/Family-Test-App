// Web Audio engine for the Host app.
//
//  • ONE music channel — setMusic(spec) crossfades to whatever the current show step wants:
//      { kind: 'track', id }                    a looping track from the media library
//      { kind: 'countdown', endsAt, total }     built-in ticking-clock countdown (synthesized)
//      null                                     silence
//  • Sound effects — sfx('answer' | 'timeup' | 'reveal' | 'start' | 'tick'), uploaded file or built-in.
//  • Global mute (also applied to intro videos).
import { getMedia, getSetting, setSetting } from './db.js';

const BUILTIN_REVEAL_URL = './reveal.mp3';

class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();    // mediaId -> AudioBuffer
    this.sfxMap = {};            // slot -> mediaId
    this.musicVolume = 0.35;
    this.muted = false;
    this.listeners = new Set();
    this.music = null;           // { key, stop() }
    this.musicKey = '';
    this._lastAnswerFx = 0;
    getSetting('muted', false).then((m) => { this.muted = m; this._applyMute(); this._notify(); });
  }

  /** Needs a user gesture at least once (browser autoplay rules). Safe to call often. */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.musicGain = this.ctx.createGain();      // uploaded tracks (host-set volume)
      this.musicGain.gain.value = this.musicVolume;
      this.musicGain.connect(this.master);
      this.cdGain = this.ctx.createGain();         // built-in countdown
      this.cdGain.gain.value = 0.8;
      this.cdGain.connect(this.master);
      this.fxGain = this.ctx.createGain();
      this.fxGain.gain.value = 0.9;
      this.fxGain.connect(this.master);
      const n = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
      const d = n.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noise = n;
      this._applyMute();
      this.ctx.onstatechange = () => this._notify();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume().then(() => this._notify(), () => {});
    // re-apply music that was requested before sound was allowed
    if (this._pendingMusic !== undefined) { const p = this._pendingMusic; this._pendingMusic = undefined; this.musicKey = ''; this.setMusic(p); }
  }

  get ready() { return !!this.ctx && this.ctx.state === 'running'; }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _notify() { this.listeners.forEach((fn) => fn(this)); }

  _applyMute() {
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 1, this.ctx.currentTime, 0.04);
    document.querySelectorAll('video.st-video[data-audible]').forEach((v) => { v.muted = this.muted; });
  }
  setMuted(m) { this.muted = !!m; this._applyMute(); setSetting('muted', this.muted); this._notify(); }
  toggleMute() { this.setMuted(!this.muted); }

  async _buffer(id) {
    if (!id || !this.ctx) return null;
    if (this.buffers.has(id)) return this.buffers.get(id);
    let data;
    if (id === 'builtin:reveal') {
      try { data = await (await fetch(BUILTIN_REVEAL_URL)).arrayBuffer(); } catch (e) { return null; }
    } else {
      const item = await getMedia(id);
      if (!item) return null;
      data = await item.blob.arrayBuffer();
    }
    try {
      const buf = await this.ctx.decodeAudioData(data);
      this.buffers.set(id, buf);
      return buf;
    } catch (e) {
      console.warn('decode failed', id, e);
      return null;
    }
  }

  configure(project) {
    this.sfxMap = { ...(project.sfx || {}) };
    this.musicVolume = project.bgVolume ?? 0.35;
    if (this.musicGain) this.musicGain.gain.value = this.musicVolume;
    this._buffer('builtin:reveal');   // warm up
  }

  /* ------------------------------------------------------------ music --- */
  get musicPlaying() { return !!this.music; }

  static keyOf(spec) {
    if (!spec) return '';
    return spec.kind === 'track' ? 'track:' + spec.id : 'cd:' + (spec.endsAt || 'loop');
  }

  /** Crossfade to `spec` (or silence). Calling again with the same spec does nothing. */
  async setMusic(spec) {
    const key = AudioEngine.keyOf(spec);
    if (key === this.musicKey) return;
    if (!this.ready) { this._pendingMusic = spec; this.musicKey = key; return; }
    this.musicKey = key;
    const old = this.music;
    this.music = null;
    old?.stop();
    if (!spec) { this._notify(); return; }
    let m = null;
    if (spec.kind === 'track') m = await this._startTrack(spec.id);
    else if (spec.kind === 'countdown') m = new CountdownSynth(this, spec.endsAt, spec.total);
    if (this.musicKey !== key) { m?.stop(); return; }     // something else was requested meanwhile
    this.music = m;
    this._notify();
  }

  async _startTrack(id) {
    const buf = await this._buffer(id);
    if (!buf) return null;
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = c.createGain();
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.linearRampToValueAtTime(1, c.currentTime + 1.2);
    src.connect(g).connect(this.musicGain);
    src.start();
    return {
      stop: () => {
        const t = c.currentTime;
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(0, t + 0.9);
        try { src.stop(t + 1); } catch (e) { /* */ }
      },
    };
  }

  /* -------------------------------------------------------------- sfx --- */
  async sfx(slot) {
    if (!this.ctx || this.muted) return;
    if (slot === 'answer') {           // throttle — many answers can arrive at once
      const now = performance.now();
      if (now - this._lastAnswerFx < 70) return;
      this._lastAnswerFx = now;
    }
    const id = this.sfxMap[slot] || (slot === 'reveal' ? 'builtin:reveal' : null);
    const buf = await this._buffer(id);
    if (buf) {
      const s = this.ctx.createBufferSource();
      s.buffer = buf;
      s.connect(this.fxGain);
      s.start();
      return;
    }
    this._synth(slot);
  }

  /** Previews any media item (dashboard). */
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

  tone(freq, t0, dur, { type = 'sine', vol = 0.25, slide = 0, dest = this.fxGain, attack = 0.008 } = {}) {
    const c = this.ctx;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(dest);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  noiseHit(t0, dur, { vol = 0.2, type = 'highpass', freq = 6000, q = 0.7, dest = this.fxGain } = {}) {
    const c = this.ctx;
    const s = c.createBufferSource();
    s.buffer = this.noise;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(f).connect(g).connect(dest);
    s.start(t0, Math.random() * 0.5);
    s.stop(t0 + dur + 0.02);
  }

  _synth(slot) {
    const t = this.ctx.currentTime;
    switch (slot) {
      case 'tick': this.tone(1200, t, 0.06, { type: 'square', vol: 0.08 }); break;
      case 'answer': this.tone(520 + Math.random() * 420, t, 0.12, { type: 'triangle', vol: 0.09, slide: 1.6 }); break;
      case 'timeup': {
        // big impact + bright bell
        this.tone(90, t, 0.9, { vol: 0.7, slide: 0.45 });
        this.noiseHit(t, 0.5, { vol: 0.35, type: 'lowpass', freq: 900 });
        [1318.5, 1975.5, 2637].forEach((f, i) => this.tone(f, t + 0.02, 1.6 - i * 0.3, { vol: 0.12 / (i + 1) }));
        this.tone(659.25, t + 0.02, 1.4, { type: 'triangle', vol: 0.12 });
        break;
      }
      case 'reveal':
        [523, 659, 784, 1046].forEach((f, i) => this.tone(f, t + i * 0.09, 0.5, { type: 'triangle', vol: 0.16 }));
        break;
      case 'start':
        this.tone(660, t, 0.15, { vol: 0.14 });
        this.tone(990, t + 0.12, 0.2, { vol: 0.14 });
        break;
      default: break;
    }
  }
}

/* ---------------------------------------------------------------------------
 * Built-in countdown music: a ticking clock with a pulsing bass, a tense pad that slowly
 * opens up, hi-hats that get busier, a riser in the last seconds and beeps on 5-4-3-2-1.
 * Beats are aligned so the final beat lands exactly when time runs out.
 * With no timer (endsAt = null) it plays a steady, looping version.
 */
class CountdownSynth {
  constructor(engine, endsAt, totalMs) {
    this.e = engine;
    const c = (this.c = engine.ctx);
    this.out = c.createGain();
    this.out.gain.setValueAtTime(0, c.currentTime);
    this.out.gain.linearRampToValueAtTime(1, c.currentTime + 0.6);
    this.out.connect(engine.cdGain);
    this.beat = 0.5;                                       // 120 BPM
    this.t0 = c.currentTime;
    this.timed = !!endsAt;
    this.end = endsAt ? c.currentTime + Math.max(0, (endsAt - Date.now()) / 1000) : null;
    this.total = (totalMs || 0) / 1000;
    this.stopped = false;
    this.nodes = [];
    // first beat index: timed -> count backwards from the end so the last beat hits 0
    this.k = this.timed ? Math.floor((this.end - c.currentTime) / this.beat) : 0;
    this._pad();
    if (this.timed) this._riser();
    this._timer = setInterval(() => this._schedule(), 30);
    this._schedule();
  }

  _beatTime(k) { return this.timed ? this.end - k * this.beat : this.t0 + 0.05 + k * this.beat; }

  /** 0 at the start of the countdown → 1 when time is up. */
  _tension(t) {
    if (!this.timed) return 0.35 + 0.15 * Math.sin((t - this.t0) / 8);
    const span = Math.max(4, this.total || (this.end - this.t0));
    return Math.min(1, Math.max(0, 1 - (this.end - t) / span));
  }

  _schedule() {
    if (this.stopped) return;
    const c = this.c;
    const horizon = c.currentTime + 0.15;
    for (;;) {
      const t = this._beatTime(this.k);
      if (t > horizon) break;
      if (this.timed && this.k < 0) { this._finish(); return; }
      if (t >= c.currentTime - 0.01) this._beatAt(t, this.k);
      this.k += this.timed ? -1 : 1;
    }
  }

  _beatAt(t, k) {
    const e = this.e;
    const out = this.out;
    const tension = this._tension(t);
    const remaining = this.timed ? this.end - t : 99;
    const idx = this.timed ? Math.round(remaining / this.beat) : k;   // beat number counting to 0
    const even = idx % 2 === 0;
    // clock: tick / tock
    e.tone(even ? 2100 : 1550, t, 0.035, { type: 'square', vol: 0.06 + tension * 0.05, dest: out, attack: 0.002 });
    e.noiseHit(t, 0.03, { vol: 0.12 + tension * 0.08, type: 'bandpass', freq: even ? 4200 : 3000, q: 4, dest: out });
    // bass pulse on every second beat (= every whole second)
    if (even) e.tone(110, t, 0.22, { vol: 0.42 + tension * 0.25, slide: 0.45, dest: out, attack: 0.004 });
    // off-beat hats once tension builds, 16ths near the end
    if (tension > 0.35) e.noiseHit(t + this.beat / 2, 0.025, { vol: 0.05 + tension * 0.05, freq: 8000, dest: out });
    if (tension > 0.8 || (this.timed && remaining <= 10)) {
      e.noiseHit(t + this.beat / 4, 0.02, { vol: 0.04, freq: 9000, dest: out });
      e.noiseHit(t + (3 * this.beat) / 4, 0.02, { vol: 0.04, freq: 9000, dest: out });
    }
    // 5-4-3-2-1 beeps on whole seconds
    if (this.timed && even && remaining > 0.2 && remaining <= 5.2) {
      const n = Math.round(remaining);
      e.tone(660 + (5 - n) * 110, t, 0.16, { type: 'triangle', vol: 0.2, dest: out });
    }
  }

  _pad() {
    const c = this.c;
    const filter = c.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 6;
    filter.frequency.setValueAtTime(380, c.currentTime);
    if (this.timed && this.end > c.currentTime + 1) filter.frequency.exponentialRampToValueAtTime(2400, this.end);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.05, c.currentTime + 1.5);
    filter.connect(g).connect(this.out);
    // A minor with a tense flat-6 colour (A, E, C, F)
    [55, 82.41, 130.81, 174.61].forEach((f, i) => {
      [-6, 6].forEach((det) => {
        const o = c.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = det + (i === 3 ? 0 : 0);
        o.connect(filter);
        o.start();
        this.nodes.push(o);
      });
    });
    // slow wobble on the filter for movement
    const lfo = c.createOscillator();
    const lg = c.createGain();
    lfo.frequency.value = 0.25;
    lg.gain.value = 120;
    lfo.connect(lg).connect(filter.frequency);
    lfo.start();
    this.nodes.push(lfo);
    this.padGain = g;
  }

  _riser() {
    const c = this.c;
    const len = Math.min(8, Math.max(0, this.end - c.currentTime));
    if (len < 2) return;
    const start = this.end - len;
    const s = c.createBufferSource();
    s.buffer = this.e.noise;
    s.loop = true;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 3;
    f.frequency.setValueAtTime(300, start);
    f.frequency.exponentialRampToValueAtTime(6000, this.end);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, c.currentTime);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(0.09, this.end - 0.05);
    g.gain.linearRampToValueAtTime(0, this.end);
    s.connect(f).connect(g).connect(this.out);
    s.start(c.currentTime);
    s.stop(this.end + 0.05);
    const o = c.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(220, start);
    o.frequency.exponentialRampToValueAtTime(1320, this.end);
    const og = c.createGain();
    og.gain.setValueAtTime(0.0001, c.currentTime);
    og.gain.setValueAtTime(0.0001, start);
    og.gain.exponentialRampToValueAtTime(0.035, this.end - 0.05);
    og.gain.linearRampToValueAtTime(0, this.end);
    o.connect(og).connect(this.out);
    o.start(c.currentTime);
    o.stop(this.end + 0.05);
    this.nodes.push(s, o);
  }

  _finish() {
    // time ran out: let the pad die quickly (the "time's up" hit is played by the show)
    clearInterval(this._timer);
    const t = this.c.currentTime;
    this.padGain.gain.cancelScheduledValues(t);
    this.padGain.gain.setValueAtTime(this.padGain.gain.value, t);
    this.padGain.gain.linearRampToValueAtTime(0, t + 0.25);
    this.nodes.forEach((n) => { try { n.stop(t + 0.3); } catch (e) { /* */ } });
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this._timer);
    const t = this.c.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setValueAtTime(this.out.gain.value, t);
    this.out.gain.linearRampToValueAtTime(0, t + 0.5);
    this.nodes.forEach((n) => { try { n.stop(t + 0.6); } catch (e) { /* */ } });
    setTimeout(() => { try { this.out.disconnect(); } catch (e) { /* */ } }, 800);
  }
}

export const audio = new AudioEngine();
