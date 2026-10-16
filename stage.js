// Stage: renders the HDMI presentation from a display-state snapshot.
// Used by the console preview, the console's fullscreen mode, and display.html (second screen).
import { PHASE, OPTION_COLORS } from './protocol.js';
import { h, fmtTime } from './ui.js';
import { iconSvg } from './icons.js';
import { qrSvg } from './qr.js';
import { typedAt } from './typewriter.js';
import { Particles } from './particles.js';

const BANNERS = {
  [PHASE.READY]: 'Get ready…',
  [PHASE.OPEN]: 'Vote now on your phone!',
  [PHASE.PAUSED]: 'Timer paused',
  [PHASE.CLOSED]: 'Voting closed',
};

export class Stage {
  constructor(container) {
    this.container = container;
    this.fit = h('div.stage-fit');
    this.el = h('div.stage');
    this.fit.append(this.el);
    container.append(this.fit);

    this.el.append(
      h('div.st-bg', h('i'), h('i'), h('i')),
      (this.top = h('header.st-top',
        (this.title = h('div.st-title')),
        (this.count = h('div.st-count')),
        (this.joinChip = h('div.st-join', (this.joinQr = h('div.qr')), h('div', h('small', 'Join code'), (this.joinPin = h('b'))))),
      )),
      (this.main = h('main.st-main')),
      (this.lb = h('aside.st-lb')),
      (this.timer = h('div.st-timer', { html: `<svg viewBox="0 0 120 120"><circle class="trk" cx="60" cy="60" r="52"/><circle class="arc" cx="60" cy="60" r="52"/></svg><b></b>` })),
      (this.banner = h('div.st-banner')),
      (this.canvas = h('canvas.st-fx')),
    );
    this.fx = new Particles(this.canvas);
    this.state = null;
    this.viewKey = '';
    this.qrCache = new Map();
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(container);
    this._resize();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  _resize() {
    const r = this.container.getBoundingClientRect();
    const k = Math.min(r.width / 1920, r.height / 1080) || 0.1;
    this.el.style.transform = `translate(-50%, -50%) scale(${k})`;
  }

  async _qr(url) {
    if (!this.qrCache.has(url)) this.qrCache.set(url, qrSvg(url));
    return this.qrCache.get(url);
  }

  fxEvent(e) {
    if (e.kind === 'answer' || e.kind === 'join') this.fx.answer(e);
    else if (e.kind === 'reveal') this.fx.celebrate();
  }

  setState(s) {
    this.state = s;
    const view = s.phase === PHASE.LOBBY ? 'lobby' : s.phase === PHASE.END ? 'end' : s.slide ? 'q' : 'empty';
    const key = view === 'q' ? `q:${s.slide.id}:${s.slide.question}:${s.slide.options.join('|')}:${s.teams.length}` : view + (view === 'end' ? JSON.stringify(s.final) : '');
    if (key !== this.viewKey) {
      this.viewKey = key;
      this.typedDone = false;
      this.main.replaceChildren();
      if (view === 'lobby') this._buildLobby(s);
      else if (view === 'q') this._buildQuestion(s);
      else if (view === 'end') this._buildEnd(s);
      else this.main.append(h('div.st-empty', 'This project has no slides'));
    }
    if (s.typingStart !== this._typingStart) { this._typingStart = s.typingStart; this.typedDone = false; }
    this.el.dataset.phase = s.phase;
    this.el.classList.toggle('with-lb', view === 'q' && s.overlays.leaderboard);
    this.el.classList.toggle('with-teams', view === 'q' && s.overlays.teams && s.teams.length > 1);
    this.el.classList.toggle('has-timer', view === 'q' && s.timerTotal > 0);
    this.el.classList.toggle('with-pct', view === 'q' && (s.overlays.percent || s.phase === PHASE.REVEAL));

    // header
    this.title.innerHTML = view === 'q'
      ? `<span class="st-proj" dir="auto"></span><span class="st-qn">Question ${s.idx + 1} / ${s.total}</span><span class="st-kind">${s.slide.type === 'quiz' ? 'Quiz' : 'Survey'}</span>`
      : '<span class="st-proj" dir="auto"></span>';
    this.title.firstChild.textContent = s.projectName;
    this.joinChip.hidden = view === 'lobby';
    this.joinPin.textContent = s.pin;
    if (!s.joinUrl) { this.joinQr.hidden = true; this._joinUrl = ''; }
    else if (this._joinUrl !== s.joinUrl) {
      this._joinUrl = s.joinUrl;
      this._qr(s.joinUrl).then((svg) => { this.joinQr.hidden = !svg; if (svg) { this.joinQr.innerHTML = svg; if (this.lobbyQr) this.lobbyQr.innerHTML = svg; } });
    }

    // count overlay
    const st = s.stats;
    this.count.hidden = !(s.overlays.count && view === 'q');
    this.count.innerHTML = `${iconSvg('users')}<b>${st.online}</b><span>connected</span><i></i>${iconSvg('check')}<b>${st.answered}</b><span>answered</span>`;

    if (view === 'lobby') this._updateLobby(s);
    if (view === 'q') this._updateQuestion(s);
    this._updateLeaderboard(s, view);

    // banner
    let banner = BANNERS[s.phase] || '';
    if (s.phase === PHASE.REVEAL) banner = s.slide?.type === 'quiz' && s.slide.correct != null ? 'The correct answer!' : 'The results';
    this.banner.textContent = banner;
    this.banner.hidden = !banner || view !== 'q';
    this.banner.dataset.phase = s.phase;
  }

  /* ---------------- lobby ---------------- */
  _buildLobby(s) {
    const url = s.joinUrl ? new URL(s.joinUrl) : null;
    this.lobbyQr = h('div.qr.lobby-qr', { hidden: !url });
    if (url) this._qr(s.joinUrl).then((svg) => { if (svg) this.lobbyQr.innerHTML = svg; else { this.lobbyQr.classList.add('qr-fallback'); this.lobbyQr.textContent = s.joinUrl; } });
    this.lobbyCount = h('b');
    this.lobbyNames = h('div.lobby-names');
    this.main.append(
      h('section.lobby',
        h('div.lobby-text',
          h('div.lobby-kicker', 'Join from your phone'),
          h('h1.lobby-title', { dir: 'auto' }, s.projectName),
          h('ol.lobby-steps',
            h('li', h('span.num', '1.'), h('span', 'Scan the code with your camera')),
            h('li', h('span.num', '2.'), h('span', 'Type your name and pick a team')),
            h('li', h('span.num', '3.'), h('span', 'Tap the answer as fast as you can')),
          ),
          h('div.lobby-pin', h('span', 'Game code'), h('b', s.pin)),
          url ? h('div.lobby-url', url.host + url.pathname) : null,
        ),
        h('div.lobby-qr-wrap', this.lobbyQr, h('div.lobby-counter', this.lobbyCount, h('span', 'players joined'))),
      ),
      this.lobbyNames,
    );
  }

  _updateLobby(s) {
    this.lobbyCount.textContent = s.stats.joined;
    const names = (s.recentNames || []).slice(-30);
    const sig = names.map((n) => n.name).join('|');
    if (sig !== this._namesSig) {
      this._namesSig = sig;
      this.lobbyNames.replaceChildren(...names.map((n) => h('span.lobby-name', { dir: 'auto', style: { '--c': n.color } }, n.name)));
    }
  }

  /* ---------------- question ---------------- */
  _buildQuestion(s) {
    const sl = s.slide;
    const qLen = (sl.question || '').length;
    const optLen = Math.max(0, ...sl.options.map((o) => (o || '').length));
    this.main.style.setProperty('--qsize', qLen > 140 ? '50px' : qLen > 80 ? '62px' : '78px');
    this.main.style.setProperty('--osize', optLen > 60 ? '36px' : optLen > 34 ? '44px' : sl.options.length >= 5 ? '46px' : '54px');
    this.qText = h('span.typed');
    this.caret = h('span.caret');
    this.qEl = h('h1.q-text', { dir: 'rtl' }, this.qText);
    this.legend = h('div.team-legend');
    this.optEls = sl.options.map((o, i) => {
      const text = h('span.typed');
      const teamBars = h('div.team-bars', s.teams.map((t) => h('div.tb', { style: { '--c': t.color } }, h('span.tb-name', { dir: 'auto' }, t.name), h('div.tb-bar', h('i')), h('span.tb-pct', { dir: 'ltr' }, '0%'))));
      const li = h('li.opt', { style: { '--c': OPTION_COLORS[i % OPTION_COLORS.length] } },
        h('span.num', `${i + 1}.`),
        h('div.opt-body',
          h('div.opt-text', text),
          h('div.opt-bar', h('i')),
          teamBars,
        ),
        h('span.opt-pct', { dir: 'ltr' }, h('b', '0'), '%'),
        h('span.opt-count', { dir: 'ltr' }),
      );
      li.typed = text;
      return li;
    });
    // Host-written content: the whole question block flows right-to-left.
    this.main.append(h('section.q-wrap', { dir: 'rtl' }, this.qEl, this.legend, h('ol.opts', this.optEls)));
  }

  _updateQuestion(s) {
    const st = s.stats;
    const sl = s.slide;
    const reveal = s.phase === PHASE.REVEAL;
    const maxCount = Math.max(...st.counts, 0);
    this.optEls.forEach((li, i) => {
      li.style.setProperty('--p', st.percents[i] + '%');
      li.querySelector('.opt-pct b').textContent = st.percents[i];
      li.querySelector('.opt-count').textContent = st.counts[i] ? `${st.counts[i]} ${st.counts[i] === 1 ? 'vote' : 'votes'}` : '';
      const isCorrect = sl.type === 'quiz' && sl.correct === i;
      li.classList.toggle('correct', reveal && (sl.type === 'quiz' ? isCorrect : st.counts[i] === maxCount && maxCount > 0));
      li.classList.toggle('dim', reveal && sl.type === 'quiz' && sl.correct != null && !isCorrect);
      s.teams.forEach((t, ti) => {
        const tb = li.querySelectorAll('.tb')[ti];
        const tot = st.teamTotals[t.id] || 0;
        const pct = tot ? Math.round(((st.byTeam[t.id]?.[i] || 0) / tot) * 100) : 0;
        tb.style.setProperty('--p', pct + '%');
        tb.querySelector('.tb-pct').textContent = pct + '%';
      });
    });
    const legendSig = s.teams.map((t) => `${t.id}:${st.teamTotals[t.id] || 0}`).join('|');
    if (legendSig !== this._legendSig) {
      this._legendSig = legendSig;
      this.legend.replaceChildren(...s.teams.map((t) => h('span.tl', { style: { '--c': t.color } }, h('i'), h('span', { dir: 'auto' }, t.name), h('small', { dir: 'ltr' }, `${st.teamTotals[t.id] || 0} answered`))));
    }
  }

  _updateLeaderboard(s, view) {
    const show = view === 'q' && s.overlays.leaderboard;
    this.lb.hidden = !show;
    if (!show) return;
    const rows = s.stats.leaderboard;
    const sig = JSON.stringify(rows) + s.stats.leaderboardKind;
    if (sig === this._lbSig) return;
    this._lbSig = sig;
    this.lb.replaceChildren(
      h('h2', { html: iconSvg('trophy') + (s.stats.leaderboardKind === 'correct' ? ' Top 10 fastest correct' : ' Top 10 fastest') }),
      rows.length
        ? h('ol', rows.map((r, i) => h('li', { style: { '--c': r.color } }, h('span.num', `${i + 1}.`), h('span.lb-name', { dir: 'auto' }, r.name), h('span.lb-ms', (r.ms / 1000).toFixed(2) + 's'))))
        : h('p.lb-empty', 'No answers yet'),
    );
  }

  /* ---------------- end ---------------- */
  _buildEnd(s) {
    const f = s.final || { rows: [], teams: [] };
    const teams = f.teams.filter((t) => t.pts > 0).sort((a, b) => b.pts - a.pts);
    this.main.append(h('section.end',
      h('div.end-kicker', { dir: 'auto' }, s.projectName),
      h('h1.end-title', 'Thanks for playing!'),
      teams.length > 1 ? h('div.end-teams', teams.map((t, i) => h('div.end-team', { style: { '--c': t.color } }, i === 0 ? h('span.crown', { html: iconSvg('trophy') }) : null, h('b', t.pts), h('span', { dir: 'auto' }, t.name)))) : null,
      f.rows.length ? h('ol.end-board', f.rows.map((r, i) => h('li', { style: { '--c': r.color } }, h('span.num', `${i + 1}.`), h('span.lb-name', { dir: 'auto' }, r.name), h('span.lb-ms', `${r.pts} correct`)))) : null,
    ));
  }

  /* ---------------- per-frame: typing + timer ---------------- */
  destroy() { this.dead = true; this._ro.disconnect(); this.fit.remove(); }

  _loop() {
    if (this.dead) return;
    requestAnimationFrame(this._loop);
    const s = this.state;
    if (!s) return;
    if (this.optEls && s.slide && this.viewKey.startsWith('q:') && !this.typedDone) {
      const ty = typedAt(s.slide, Date.now() - s.typingStart);
      const lines = [this.qText, ...this.optEls.map((li) => li.typed)];
      const src = [Array.from(s.slide.question || ''), ...s.slide.options.map((o) => Array.from(o || ''))];
      lines.forEach((el, i) => {
        const n = ty.counts[i];
        const txt = n < 0 ? '' : src[i].slice(0, n).join('');
        if (el.textContent !== txt) el.textContent = txt;
        if (i > 0) this.optEls[i - 1].classList.toggle('shown', n >= 0);
      });
      const host = lines[Math.max(0, Math.min(lines.length - 1, ty.counts[ty.line] < 0 ? ty.line - 1 : ty.line))];
      if (this.caret.parentNode !== host.parentNode || this.caret.previousSibling !== host) host.after(this.caret);
      this.caret.hidden = ty.done;
      this.el.classList.toggle('typing', !ty.done);
      if (ty.done) this.typedDone = true;
    }
    // timer ring
    const showTimer = this.viewKey.startsWith('q:') && s.timerTotal > 0 && [PHASE.TYPING, PHASE.READY, PHASE.OPEN, PHASE.PAUSED].includes(s.phase);
    this.timer.hidden = !showTimer;
    if (showTimer) {
      const left = s.timerEnd ? Math.max(0, s.timerEnd - Date.now()) : s.timerRemaining ?? s.timerTotal;
      const frac = Math.max(0, Math.min(1, left / s.timerTotal));
      const arc = this.timer.querySelector('.arc');
      arc.style.strokeDashoffset = String(326.7 * (1 - frac));
      this.timer.querySelector('b').textContent = fmtTime(left);
      this.timer.classList.toggle('urgent', s.phase === PHASE.OPEN && left < 5500);
      this.timer.classList.toggle('paused', s.phase === PHASE.PAUSED);
    }
  }
}
