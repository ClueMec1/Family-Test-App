// Host phone remote: connects to the console hub as role "remote" (secret key from the QR).
import { h, registerSW, vibrate, fmtTime } from '../shared/ui.js';
import { icon } from '../shared/icons.js';
import { T, PHASE, PHASE_LABEL, OPTION_COLORS, isLocalMode } from '../shared/protocol.js';
import { ClientLink } from '../shared/transport.js';

registerSW('./sw.js');
const q = new URLSearchParams(location.search);
const pin = q.get('pin');
const key = q.get('key');
const app = document.getElementById('app');

if (!pin || !key) {
  app.append(h('div.r', h('div.r-msg', h('h2', 'Host remote'), h('p', 'Open the remote by scanning the "Remote" QR code in the host console.'))));
} else {
  start();
}

function start() {
  let st = null;
  let rxAt = 0;
  const dot = h('span.dot.connecting');
  const head = h('header.r-head', dot, h('h1', 'Host remote'), h('span.r-pin', pin));
  const body = h('div.r-body', { style: { display: 'contents' } });
  const root = h('div.r', head, body);
  app.append(root);

  const send = (cmd, value) => { vibrate(15); link.send({ t: T.CMD, cmd, value }); };
  const btn = (cmd, label, ico, cls = '', value) => h(`button.btn${cls}`, { dataset: { cmd }, onclick: () => send(cmd, value) }, icon(ico), h('span', label));

  // static controls
  const time = h('span.r-time');
  const phase = h('div.r-phase', h('span.dot'), h('span.pl'), time);
  const qtext = h('div.r-q');
  const counts = h('div.r-counts');
  const bars = h('div.r-bars');
  const mainBtn = btn('toggleTimer', 'Open voting', 'play', '.hot.r-main');
  const ovs = [['count', 'Count', 'users'], ['percent', 'Percent', 'percent'], ['teams', 'Teams', 'split'], ['leaderboard', 'Fastest', 'trophy']]
    .map(([v, l, i]) => { const b = btn('overlay', l, i, '', v); b.dataset.ov = v; return b; });
  const jump = h('select.input', { onchange: () => { if (jump.value !== '') send('goto', Number(jump.value)); } });
  const mute = btn('mute', 'Mute', 'vol');
  const bg = btn('bg', 'Music', 'music');

  body.append(
    h('section.r-status', phase, qtext, counts, bars),
    h('div.r-nav', btn('prev', 'Previous', 'prev'), btn('next', 'Next', 'next', '.primary'), mainBtn),
    h('div.r-row', btn('skip', 'Skip', 'skip'), btn('lock', 'Lock', 'lock'), btn('reveal', 'Reveal', 'eye')),
    h('div.r-label', 'Show on screen'),
    h('div.r-ov', ovs),
    h('div.r-row', mute, bg, btn('lobby', 'Join', 'qr')),
    h('div.r-label', 'Jump to slide'),
    jump,
    h('button.btn.sm.ghost', { onclick: () => { if (confirm('Go to the end screen?')) send('end'); } }, icon('flag'), 'End screen'),
  );

  function render() {
    if (!st) return;
    phase.querySelector('.dot').className = 'dot ' + ({ open: 'online', paused: 'connecting', typing: 'connecting' }[st.phase] || '');
    phase.querySelector('.pl').textContent = PHASE_LABEL[st.phase] || st.phase;
    const showQ = st.slide && ![PHASE.LOBBY, PHASE.END].includes(st.phase);
    qtext.replaceChildren(showQ ? `${st.idx + 1}/${st.total} · ` : '', h('span', { dir: showQ ? 'rtl' : 'auto' }, showQ ? st.slide.question : st.projectName));
    counts.replaceChildren(
      h('span.pill', icon('users'), h('b', st.stats.online), 'connected'),
      h('span.pill', icon('check'), h('b', st.stats.answered), 'answered'),
    );
    bars.replaceChildren(...(showQ ? st.slide.options.map((o, i) => h('div.r-bar', { style: { '--c': OPTION_COLORS[i], '--p': st.stats.percents[i] + '%' } },
      h('span.num', { class: st.slide.type === 'quiz' && st.slide.correct === i ? 'ok' : '' }, i + 1),
      h('div.t', h('i')),
      h('b', `${st.stats.percents[i]}%`))) : []));
    const open = st.phase === PHASE.OPEN;
    mainBtn.replaceChildren(icon(open ? 'pause' : 'play'), h('span', open ? 'Pause timer' : st.phase === PHASE.PAUSED ? 'Resume' : st.phase === PHASE.CLOSED ? 'Reopen voting' : 'Open voting'));
    mainBtn.disabled = [PHASE.LOBBY, PHASE.END, PHASE.REVEAL].includes(st.phase);
    body.querySelector('[data-cmd="skip"]').disabled = st.phase !== PHASE.TYPING;
    body.querySelector('[data-cmd="lock"]').disabled = ![PHASE.OPEN, PHASE.PAUSED, PHASE.READY].includes(st.phase);
    ovs.forEach((b) => b.classList.toggle('on', !!st.overlays[b.dataset.ov]));
    ovs[2].disabled = st.teams.length < 2;
    mute.replaceChildren(icon(st.muted ? 'mute' : 'vol'), h('span', st.muted ? 'Muted' : 'Mute'));
    mute.classList.toggle('on', st.muted);
    bg.disabled = !st.hasBg;
    bg.classList.toggle('on', st.bgPlaying);
    const sig = st.slides.map((s) => s.q).join('|') + st.idx + st.phase;
    if (jump._sig !== sig) {
      jump._sig = sig;
      jump.replaceChildren(h('option', { value: '' }, 'Choose a slide…'), ...st.slides.map((s) => h('option', { value: s.i, dir: 'rtl', selected: showQ && s.i === st.idx }, `${s.i + 1}. ${s.q}`)));
    }
    tick();
  }

  function tick() {
    if (!st || st.remaining == null) { time.textContent = ''; return; }
    const left = st.phase === PHASE.OPEN ? Math.max(0, st.remaining - (Date.now() - rxAt)) : st.remaining;
    time.textContent = fmtTime(left);
    time.classList.toggle('urgent', st.phase === PHASE.OPEN && left < 5500);
  }
  setInterval(tick, 250);

  const link = new ClientLink({
    pin,
    backend: isLocalMode() ? 'local' : 'peer',
    meta: { role: 'remote', key },
    onStatus: (s) => { dot.className = 'dot ' + s; },
    onMessage: (m) => {
      if (m.t === T.RSTATE) { st = m; rxAt = Date.now(); render(); }
      else if (m.t === T.DENIED) { link.close(); body.replaceChildren(h('div.r-msg', h('h2', 'Access denied'), h('p', 'This remote link is no longer valid. Scan the "Remote" QR code in the host console again.'))); }
    },
  });

  navigator.wakeLock?.request('screen').catch(() => {});
}
