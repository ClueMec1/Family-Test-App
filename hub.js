// ShowHub: the authoritative live-show state machine. Lives in the Host console tab.
// Owns participants, answers, phases, timers and the network hub.
import { T, PHASE, STALE_MS, OVERLAYS, RESULT_PHASES, teamsFromNames, cleanName, uid, randomPin } from './protocol.js';
import { openHub } from './transport.js';
import { typingDuration } from './typewriter.js';
import { audio } from './audio.js';

export class ShowHub {
  constructor(project, session, { backend = 'peer', joinBase = '' } = {}) {
    this.project = project;
    this.joinBase = joinBase;   // address of the separately-hosted Join PWA
    this.slides = project.slides;
    this.teams = teamsFromNames(project.teams);
    this.backend = backend;
    this.listeners = {};
    this.netStatus = 'connecting';

    this.pin = session?.pin || randomPin();
    this.remoteKey = session?.remoteKey || uid(12);
    this.idx = clampIdx(session?.idx ?? 0, this.slides.length);
    this.phase = session?.phase && session.phase !== PHASE.TYPING ? session.phase : PHASE.LOBBY;
    if (this.phase === PHASE.OPEN || this.phase === PHASE.READY || this.phase === PHASE.PAUSED) this.phase = PHASE.CLOSED;   // don't resume mid-vote blindly
    if (this.phase === PHASE.INTRO && !this.hasIntro) this.phase = PHASE.LOBBY;
    this.introStart = Date.now();
    this.lateJoin = false;          // host can let latecomers in after the join screen
    this.overlays = { count: true, percent: false, teams: false, leaderboard: false, ...(session?.overlays || {}) };
    this.answers = session?.answers || {};       // slideId -> { pid: {c, ms, at} }
    this.participants = new Map();               // pid -> {pid,name,team,joinedAt,lastSeen,conns:Set}
    (session?.participants || []).forEach((p) => this.participants.set(p.pid, { ...p, lastSeen: 0, conns: new Set() }));
    this.typingStart = Date.now() - 1e7;         // typed (when resuming a slide)
    this.timerEnd = null;
    this.timerRemaining = null;
    this.openedAt = null;
    this.pausedTotal = 0;
    this.pausedAt = null;
    this.remotes = new Set();
    this.unbound = new Set();
    this._lastTickSec = null;

    this._tick = setInterval(() => this._onTick(), 100);
  }

  /* ---------------- events ---------------- */
  on(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  emit(ev, data) { (this.listeners[ev] || []).forEach((fn) => fn(data)); }
  changed() {
    if (this._pending || this.destroyed) return;
    this._pending = true;
    queueMicrotask(() => { this._pending = false; this.emit('change', this); });
  }

  get slide() { return this.slides[this.idx] || null; }
  get intro() { return this.project.intro || { type: 'none' }; }
  get hasIntro() { const i = this.intro; return i.type === 'text' || (i.type === 'video' && !!i.videoId); }
  /** New players may join only on the join screen (or when the host lets latecomers in). */
  get joinOpen() { return this.phase === PHASE.LOBBY || this.lateJoin; }
  get timerTotal() { return (this.slide?.timer || 0) * 1000; }

  /* ---------------- network ---------------- */
  async start() {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        this.net = await openHub({
          pin: this.pin,
          backend: this.backend,
          onConnection: (c) => this._onConnection(c),
          onStatus: (s) => { this.netStatus = s; this.changed(); },
        });
        if (this.destroyed) { this.net.close(); return; }
        this.netStatus = 'online';
        this.changed();
        return;
      } catch (e) {
        if (e.code === 'unavailable-id') { this.pin = randomPin(); continue; }   // PIN taken on the broker
        this.netStatus = 'offline';
        this.netError = e.message;
        this.changed();
        throw e;
      }
    }
  }

  destroy() {
    this.destroyed = true;
    clearInterval(this._tick);
    this.net?.close();
  }

  _onConnection(conn) {
    const meta = conn.meta || {};
    if (meta.role === 'remote') {
      if (meta.key !== this.remoteKey) { conn.send({ t: T.DENIED }); setTimeout(() => conn.close(), 300); return; }
      this.remotes.add(conn);
      conn.on('data', (m) => this._onRemoteMsg(conn, m));
      conn.on('close', () => { this.remotes.delete(conn); this.changed(); });
      conn.send(this.remoteState());
      this.changed();
      return;
    }
    // participant
    const pid = String(meta.pid || '').slice(0, 40);
    conn.pid = pid;
    const p = this.participants.get(pid);
    if (p) { p.conns.add(conn); p.lastSeen = Date.now(); } else this.unbound.add(conn);
    conn.on('data', (m) => this._onParticipantMsg(conn, m));
    conn.on('close', () => {
      this.unbound.delete(conn);
      const pp = this.participants.get(conn.pid);
      if (pp) pp.conns.delete(conn);
      this.changed();
    });
    conn.send(this._info(pid));
    if (p) conn.send(this.participantState(pid));
    this.changed();
  }

  _info(pid) {
    const p = this.participants.get(pid);
    return {
      t: T.INFO,
      projectName: this.project.name,
      teams: this.teams,
      joined: !!p,
      locked: !p && !this.joinOpen,
      me: p ? { name: p.name, team: p.team } : null,
    };
  }

  _onParticipantMsg(conn, m) {
    if (!m || typeof m !== 'object') return;
    const pid = conn.pid;
    const p = this.participants.get(pid);
    if (p) p.lastSeen = Date.now();
    switch (m.t) {
      case T.PING: conn.send({ t: T.PONG }); break;
      case T.JOIN: {
        const name = cleanName(m.name);
        if (!name) return;
        const team = this.teams.length ? (this.teams.find((t) => t.id === m.team)?.id || this.teams[0].id) : null;
        let rec = this.participants.get(pid);
        const isNew = !rec;
        if (!rec && !this.joinOpen) { conn.send(this._info(pid)); return; }   // joining is closed
        if (!rec) {
          rec = { pid, name, team, joinedAt: Date.now(), lastSeen: Date.now(), conns: new Set() };
          this.participants.set(pid, rec);
        } else Object.assign(rec, { name, team });
        rec.conns.add(conn);
        this.unbound.delete(conn);
        conn.send(this._info(pid));
        conn.send(this.participantState(pid));
        if (isNew) this.emit('fx', { kind: 'join', name, color: this._teamColor(team) });
        this.changed();
        break;
      }
      case T.ANSWER: this._answer(conn, p, m); break;
      default: break;
    }
  }

  _answer(conn, p, m) {
    const s = this.slide;
    const reply = (ok, reason) => conn.send({ t: T.ACK, slideId: m.slideId, choice: this.answers[s?.id]?.[p?.pid]?.c ?? null, ok, reason });
    if (!p) return reply(false, 'not-joined');
    if (!s || m.slideId !== s.id) return reply(false, 'stale');
    if (this.phase !== PHASE.OPEN) return reply(false, 'closed');
    const c = Number(m.choice);
    if (!Number.isInteger(c) || c < 0 || c >= s.options.length) return reply(false, 'bad');
    const bucket = (this.answers[s.id] ||= {});
    if (bucket[p.pid]) return reply(false, 'already');
    const ms = Math.max(0, Date.now() - this.openedAt - this.pausedTotal);
    bucket[p.pid] = { c, ms, at: Date.now() };
    reply(true);
    audio.sfx('answer');
    // the flying badge must not give away the team or the choice
    this.emit('fx', { kind: 'answer', name: p.name, color: '#ffd166' });
    this.changed();
  }

  _onRemoteMsg(conn, m) {
    if (!m) return;
    if (m.t === T.PING) { conn.send({ t: T.PONG }); return; }
    if (m.t === T.CMD) this.command(m.cmd, m.value);
  }

  /** Commands shared by console buttons, keyboard and the phone remote. */
  command(cmd, value) {
    switch (cmd) {
      case 'next': return this.next();
      case 'prev': return this.prev();
      case 'goto': return this.goto(Number(value));
      case 'lobby': return this.toLobby();
      case 'skip': return this.skipTyping();
      case 'start': return this.openVoting();
      case 'toggleTimer': return this.toggleTimer();
      case 'pause': return this.pause();
      case 'resume': return this.resume();
      case 'lock': return this.lock();
      case 'reveal': return this.reveal();
      case 'overlay': return this.toggleOverlay(value);
      case 'mute': audio.toggleMute(); return this.changed();
      case 'bg': case 'music': this.emit('musicToggle'); return this.changed();
      case 'joinLock': return this.toggleLateJoin();
      case 'intro': return this.toIntro();
      case 'resetSlide': return this.resetSlide();
      case 'end': return this.endShow();
      default: return undefined;
    }
  }

  /* ---------------- show flow ----------------
   * The host only needs NEXT. Each press moves one step:
   *   Join screen → (joining closes) → Intro → Question: typing → voting → closed
   *   → Reveal answer + % → Team results → Fastest players → next question … → Final results
   */
  _setPhase(ph) {
    const wasJoinOpen = this.joinOpen;
    this.phase = ph;
    if (ph === PHASE.LOBBY) this.lateJoin = false;
    if (wasJoinOpen !== this.joinOpen) this._broadcastInfo();
    this._broadcastParticipants();
    this.changed();
  }

  toLobby() { this._clearTimer(); this._setPhase(PHASE.LOBBY); }
  toIntro() {
    if (!this.hasIntro) return this.goto(0);
    this._clearTimer();
    this.introStart = Date.now();
    this._setPhase(PHASE.INTRO);
  }
  endShow() { this._clearTimer(); this._setPhase(PHASE.END); }

  toggleLateJoin() {
    if (this.phase === PHASE.LOBBY) return;
    this.lateJoin = !this.lateJoin;
    this._broadcastInfo();
    this.changed();
  }

  _answered(s = this.slide) { return Object.keys((s && this.answers[s.id]) || {}).length; }
  _hasTeamStep(s = this.slide) { return !!s && s.teamStep !== false && this.teams.length > 1 && this._answered(s) > 0; }
  _hasBoardStep(s = this.slide) {
    if (!s || s.type !== 'quiz' || s.correct == null || s.boardStep === false) return false;
    return Object.values(this.answers[s.id] || {}).some((a) => a.c === s.correct);
  }
  /** The last results step of a slide (where "previous" lands when coming back to it). */
  _lastStep(s) {
    if (!this._answered(s)) return PHASE.CLOSED;
    return this._hasBoardStep(s) ? PHASE.BOARD : this._hasTeamStep(s) ? PHASE.TEAMS : PHASE.REVEAL;
  }

  next() {
    if (!this.slides.length && ![PHASE.LOBBY, PHASE.INTRO].includes(this.phase)) return this.endShow();
    switch (this.phase) {
      case PHASE.LOBBY: return this.hasIntro ? this.toIntro() : this.slides.length ? this.goto(0) : this.endShow();
      case PHASE.INTRO: return this.slides.length ? this.goto(0) : this.endShow();
      case PHASE.TYPING: case PHASE.READY: return this.openVoting();
      case PHASE.OPEN: case PHASE.PAUSED: return this.lock();
      case PHASE.CLOSED: return this.reveal();
      case PHASE.REVEAL:
        if (this._hasTeamStep()) return this.showTeams();
        if (this._hasBoardStep()) return this.showBoard();
        return this._advance();
      case PHASE.TEAMS: return this._hasBoardStep() ? this.showBoard() : this._advance();
      case PHASE.BOARD: return this._advance();
      default: return undefined;
    }
  }

  _advance() { return this.idx < this.slides.length - 1 ? this.goto(this.idx + 1) : this.endShow(); }

  prev() {
    switch (this.phase) {
      case PHASE.LOBBY: return undefined;
      case PHASE.INTRO: return this.toLobby();
      case PHASE.END:
        if (!this.slides.length) return this.hasIntro ? this.toIntro() : this.toLobby();
        return this._showStep(this.slides.length - 1, this._lastStep(this.slides[this.slides.length - 1]));
      case PHASE.BOARD: return this._hasTeamStep() ? this.showTeams() : this.reveal(true);
      case PHASE.TEAMS: return this.reveal(true);
      case PHASE.REVEAL: return this._showStep(this.idx, PHASE.CLOSED);
      default:   // typing / ready / open / paused / closed
        if (this.idx > 0) return this._showStep(this.idx - 1, this._lastStep(this.slides[this.idx - 1]));
        return this.hasIntro ? this.toIntro() : this.toLobby();
    }
  }

  /** Jump to a slide in a given (already-run) step, fully typed. */
  _showStep(i, phase) {
    this.idx = clampIdx(i, this.slides.length);
    this._clearTimer();
    this._resetOverlays();
    this.typingStart = Date.now() - typingDuration(this.slide) - 1;
    this._setPhase(phase);
  }

  _resetOverlays() { this.overlays.percent = false; this.overlays.teams = false; this.overlays.leaderboard = false; }

  goto(i) {
    if (!this.slides.length) return this.toLobby();
    this.idx = clampIdx(i, this.slides.length);
    const s = this.slide;
    this._clearTimer();
    this._resetOverlays();
    if (this._answered(s) > 0) {
      // revisiting a slide that already ran: typed and closed, results still hidden until Next
      this.typingStart = Date.now() - typingDuration(s) - 1;
      this._setPhase(PHASE.CLOSED);
    } else {
      this.typingStart = Date.now();
      this._setPhase(PHASE.TYPING);
    }
  }

  skipTyping() {
    if (this.phase !== PHASE.TYPING) return;
    this.typingStart = Date.now() - typingDuration(this.slide) - 1;
    this._typingDone();
  }

  _typingDone() {
    if (this.project.autoStart !== false) this.openVoting();
    else this._setPhase(PHASE.READY);
  }

  openVoting() {
    const s = this.slide;
    if (!s || ![PHASE.TYPING, PHASE.READY, PHASE.CLOSED, PHASE.PAUSED].includes(this.phase)) return;
    if (this.phase === PHASE.PAUSED) return this.resume();
    if (this.phase === PHASE.TYPING) this.typingStart = Date.now() - typingDuration(s) - 1;
    this.openedAt = Date.now();
    this.pausedTotal = 0;
    this.timerEnd = s.timer ? Date.now() + s.timer * 1000 : null;
    this.timerRemaining = null;
    this._lastTickSec = null;
    this._resetOverlays();
    audio.sfx('start');
    this._setPhase(PHASE.OPEN);
  }

  pause() {
    if (this.phase !== PHASE.OPEN) return;
    this.pausedAt = Date.now();
    if (this.timerEnd) { this.timerRemaining = Math.max(0, this.timerEnd - Date.now()); this.timerEnd = null; }
    this._setPhase(PHASE.PAUSED);
  }

  resume() {
    if (this.phase !== PHASE.PAUSED) return;
    this.pausedTotal += Date.now() - (this.pausedAt || Date.now());
    if (this.timerRemaining != null) { this.timerEnd = Date.now() + this.timerRemaining; this.timerRemaining = null; }
    this._setPhase(PHASE.OPEN);
  }

  toggleTimer() {
    if (this.phase === PHASE.OPEN) return this.pause();
    if (this.phase === PHASE.PAUSED) return this.resume();
    return this.openVoting();
  }

  lock() {
    if (![PHASE.OPEN, PHASE.PAUSED, PHASE.READY, PHASE.TYPING].includes(this.phase)) return;
    if (this.phase === PHASE.TYPING) this.typingStart = Date.now() - typingDuration(this.slide) - 1;
    this._close();
  }

  _close() {
    this.timedOut = false;
    this.timerEnd = null;
    this.timerRemaining = null;
    this._setPhase(PHASE.CLOSED);
  }

  /** Reveal the correct answer (quiz) / the results (survey), with percentages. */
  reveal(quiet = false) {
    if (!this.slide || [PHASE.LOBBY, PHASE.INTRO, PHASE.END].includes(this.phase)) return;
    if (this.phase === PHASE.TYPING) this.typingStart = Date.now() - typingDuration(this.slide) - 1;
    this._clearTimer();
    this._resetOverlays();
    if (!quiet) {
      audio.sfx('reveal');
      this.emit('fx', { kind: 'reveal' });
    }
    this._setPhase(PHASE.REVEAL);
  }

  showTeams() {
    if (!this.slide) return;
    this._resetOverlays();
    this._setPhase(PHASE.TEAMS);
  }

  showBoard() {
    if (!this.slide) return;
    this._resetOverlays();
    this._setPhase(PHASE.BOARD);
  }

  resetSlide() {
    if (!this.slide) return;
    delete this.answers[this.slide.id];
    this.goto(this.idx);   // re-types the question and re-opens voting from scratch
  }

  toggleOverlay(name) {
    if (!OVERLAYS.includes(name)) return;
    this.overlays[name] = !this.overlays[name];
    this.changed();
  }

  _clearTimer() { this.timerEnd = null; this.timerRemaining = null; this.openedAt = null; }

  /** Plain-English description of what NEXT will do right now (shown to the host). */
  nextLabel() {
    const s = this.slide;
    const nextQ = () => (this.idx < this.slides.length - 1 ? `Go to question ${this.idx + 2}` : 'Show the final results');
    switch (this.phase) {
      case PHASE.LOBBY:
        if (this.hasIntro) return 'Close joining & play the intro';
        return this.slides.length ? 'Close joining & start question 1' : 'Close joining & end';
      case PHASE.INTRO: return this.slides.length ? 'Start question 1' : 'End the show';
      case PHASE.TYPING: return 'Open voting now';
      case PHASE.READY: return 'Open voting';
      case PHASE.OPEN: return this.timerEnd ? 'Stop the countdown & close voting' : 'Close voting';
      case PHASE.PAUSED: return 'Close voting';
      case PHASE.CLOSED: return s?.type === 'quiz' && s.correct != null ? 'Reveal the correct answer' : 'Reveal the results';
      case PHASE.REVEAL:
        if (this._hasTeamStep()) return 'Show the team results';
        if (this._hasBoardStep()) return 'Show the fastest players';
        return nextQ();
      case PHASE.TEAMS: return this._hasBoardStep() ? 'Show the fastest players' : nextQ();
      case PHASE.BOARD: return nextQ();
      case PHASE.END: return 'The show is over';
      default: return '';
    }
  }

  _onTick() {
    const now = Date.now();
    if (this.phase === PHASE.TYPING && this.slide && now - this.typingStart >= typingDuration(this.slide)) this._typingDone();
    if (this.phase === PHASE.OPEN && this.timerEnd) {
      const left = this.timerEnd - now;
      const sec = Math.ceil(left / 1000);
      // beeps for the last seconds only when the question is silent (the built-in countdown has its own)
      if ((this.slide.music ?? 'countdown') === 'none' && sec <= 5 && sec > 0 && sec !== this._lastTickSec) { this._lastTickSec = sec; audio.sfx('tick'); }
      if (left <= 0) {
        audio.sfx('timeup');
        this._close();
        this.timedOut = true;
        if (this.project.autoReveal) {
          const slideId = this.slide.id;
          setTimeout(() => { if (this.phase === PHASE.CLOSED && this.slide?.id === slideId) this.reveal(); }, 1800);
        }
      }
    }
    // presence: mark silent participants offline
    if (!this._lastPresence || now - this._lastPresence > 2000) {
      this._lastPresence = now;
      let changed = false;
      for (const p of this.participants.values()) {
        const online = p.conns.size > 0 && now - p.lastSeen < STALE_MS;
        if (online !== p._online) { p._online = online; changed = true; }
      }
      if (changed) this.changed();
    }
  }

  /* ---------------- derived state ---------------- */
  _teamColor(teamId) { return this.teams.find((t) => t.id === teamId)?.color || '#ffcc33'; }

  onlineCount() { let n = 0; for (const p of this.participants.values()) if (p._online) n++; return n; }

  stats(slide = this.slide) {
    const n = slide?.options.length || 0;
    const bucket = (slide && this.answers[slide.id]) || {};
    const counts = Array(n).fill(0);
    const byTeam = {};
    const teamTotals = {};
    this.teams.forEach((t) => { byTeam[t.id] = Array(n).fill(0); teamTotals[t.id] = 0; });
    const entries = [];
    for (const [pid, a] of Object.entries(bucket)) {
      if (a.c < n) counts[a.c]++;
      const p = this.participants.get(pid);
      if (p && byTeam[p.team]) { byTeam[p.team][a.c]++; teamTotals[p.team]++; }
      entries.push({ pid, name: p?.name || '?', team: p?.team, color: this._teamColor(p?.team), c: a.c, ms: a.ms });
    }
    const answered = entries.length;
    const isQuiz = slide?.type === 'quiz' && slide.correct != null;
    const lb = entries
      .filter((e) => (isQuiz ? e.c === slide.correct : true))
      .sort((a, b) => a.ms - b.ms)
      .slice(0, 10)
      .map(({ name, color, ms, team }) => ({ name, color, ms, team }));
    return {
      counts,
      percents: counts.map((c) => (answered ? Math.round((c / answered) * 100) : 0)),
      byTeam,
      teamTotals,
      answered,
      online: this.onlineCount(),
      joined: this.participants.size,
      leaderboard: lb,
      leaderboardKind: isQuiz ? 'correct' : 'fastest',
    };
  }

  remaining() {
    if (this.timerEnd) return Math.max(0, this.timerEnd - Date.now());
    if (this.timerRemaining != null) return this.timerRemaining;
    return null;
  }

  /** Full state for the HDMI stage (same machine — absolute timestamps are fine). */
  displayState() {
    return {
      pin: this.pin,
      joinUrl: this.joinUrl(),
      projectName: this.project.name,
      teams: this.teams,
      phase: this.phase,
      idx: this.idx,
      total: this.slides.length,
      slide: this.slide,
      typingStart: this.typingStart,
      timerEnd: this.timerEnd,
      timerRemaining: this.timerRemaining,
      timerTotal: this.timerTotal,
      overlays: { ...this.overlays },
      stats: this.stats(),
      netStatus: this.netStatus,
      final: this.phase === PHASE.END ? this.finalBoard() : null,
      intro: this.intro,
      introStart: this.introStart,
      joinOpen: this.joinOpen,
      timedOut: !!this.timedOut && this.phase === PHASE.CLOSED,
      recentNames: this.phase === PHASE.LOBBY
        ? [...this.participants.values()].sort((a, b) => a.joinedAt - b.joinedAt).slice(-30).map((p) => ({ name: p.name, color: this._teamColor(p.team) }))
        : [],
    };
  }

  /** End-of-show standings: most correct quiz answers, ties broken by total response time. */
  finalBoard() {
    const score = new Map();
    for (const s of this.slides) {
      if (s.type !== 'quiz' || s.correct == null) continue;
      for (const [pid, a] of Object.entries(this.answers[s.id] || {})) {
        const r = score.get(pid) || { pts: 0, ms: 0 };
        if (a.c === s.correct) { r.pts++; r.ms += a.ms; }
        score.set(pid, r);
      }
    }
    const teamPts = {};
    this.teams.forEach((t) => { teamPts[t.id] = 0; });
    const rows = [...score.entries()].map(([pid, r]) => {
      const p = this.participants.get(pid);
      if (p && p.team in teamPts) teamPts[p.team] += r.pts;
      return { name: p?.name || '?', color: this._teamColor(p?.team), pts: r.pts, ms: r.ms };
    }).filter((r) => r.pts > 0).sort((a, b) => b.pts - a.pts || a.ms - b.ms).slice(0, 10);
    return { rows, teams: this.teams.map((t) => ({ ...t, pts: teamPts[t.id] })) };
  }

  /** Per-participant state. Times are relative (ms) so device clock skew doesn't matter. */
  participantState(pid) {
    const s = this.slide;
    const active = s && ![PHASE.LOBBY, PHASE.INTRO, PHASE.END].includes(this.phase);
    const mine = active ? this.answers[s.id]?.[pid] : null;
    return {
      t: T.STATE,
      phase: this.phase,
      slide: active ? { id: s.id, n: this.idx + 1, total: this.slides.length, type: s.type, question: s.question, options: s.options } : null,
      remaining: this.remaining(),
      timerTotal: this.timerTotal,
      myChoice: mine ? mine.c : null,
      correct: RESULT_PHASES.includes(this.phase) && s?.type === 'quiz' ? s.correct : null,
    };
  }

  remoteState() {
    const st = this.stats();
    const s = this.slide;
    const bucket = (s && this.answers[s.id]) || {};
    return {
      t: T.RSTATE,
      projectName: this.project.name,
      pin: this.pin,
      phase: this.phase,
      idx: this.idx,
      total: this.slides.length,
      slide: s ? { question: s.question, options: s.options, type: s.type, correct: s.correct, timer: s.timer } : null,
      remaining: this.remaining(),
      timerTotal: this.timerTotal,
      overlays: { ...this.overlays },
      stats: st,
      teams: this.teams,
      muted: audio.muted,
      musicOn: !!this.musicOn,
      musicAvailable: !!this.musicAvailable,
      nextLabel: this.nextLabel(),
      joinOpen: this.joinOpen,
      hasIntro: this.hasIntro,
      slides: this.slides.map((x, i) => ({ i, q: x.question })),
      people: [...this.participants.values()].map((p) => ({ name: p.name, team: p.team, online: !!p._online, answered: !!bucket[p.pid] })),
    };
  }

  /** Link encoded in the participant QR: <Join app address>?pin=1234. Empty if not configured. */
  joinUrl() {
    if (!this.joinBase) return '';
    let u;
    try { u = new URL(this.joinBase); } catch (e) { return ''; }
    u.search = '';
    u.hash = '';
    u.searchParams.set('pin', this.pin);
    if (this.backend === 'local') u.searchParams.set('local', '1');
    return u.toString();
  }

  remoteUrl() {
    const u = new URL('./remote.html', location.href);
    u.search = '';
    u.hash = '';
    u.searchParams.set('pin', this.pin);
    u.searchParams.set('key', this.remoteKey);
    if (this.backend === 'local') u.searchParams.set('local', '1');
    return u.toString();
  }

  /** Re-send INFO to every connected phone (e.g. joining opened/closed). */
  _broadcastInfo() {
    for (const c of this.unbound) c.send(this._info(c.pid));
  }

  _broadcastParticipants() {
    for (const p of this.participants.values()) {
      if (!p.conns.size) continue;
      const msg = this.participantState(p.pid);
      p.conns.forEach((c) => c.send(msg));
    }
  }

  pushRemotes() {
    if (!this.remotes.size) return;
    const msg = this.remoteState();
    this.remotes.forEach((c) => c.send(msg));
  }

  serialize() {
    return {
      projectId: this.project.id,
      pin: this.pin,
      remoteKey: this.remoteKey,
      idx: this.idx,
      phase: this.phase,
      overlays: this.overlays,
      answers: this.answers,
      participants: [...this.participants.values()].map(({ pid, name, team, joinedAt }) => ({ pid, name, team, joinedAt })),
      savedAt: Date.now(),
    };
  }

  toCSV() {
    const rows = [['Question', 'Type', 'Name', 'Team', 'Answer', 'Correct', 'Time (s)']];
    this.slides.forEach((s, i) => {
      for (const [pid, a] of Object.entries(this.answers[s.id] || {})) {
        const p = this.participants.get(pid);
        rows.push([
          `${i + 1}. ${s.question}`,
          s.type === 'quiz' ? 'Quiz' : 'Survey',
          p?.name || pid,
          this.teams.find((t) => t.id === p?.team)?.name || '',
          `${a.c + 1}. ${s.options[a.c] ?? ''}`,
          s.type === 'quiz' ? (a.c === s.correct ? 'Yes' : 'No') : '',
          (a.ms / 1000).toFixed(2),
        ]);
      }
    });
    return '﻿' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
  }
}

function clampIdx(i, len) { return Math.max(0, Math.min(len - 1, Number.isFinite(i) ? i : 0)); }
