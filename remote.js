// Host phone remote: connects to the console hub as role "remote" (secret key from the QR).
import { h, registerSW, vibrate, fmtTime } from './ui.js';
import { icon } from './icons.js';
import { T, PHASE, PHASE_LABEL, OPTION_COLORS, RESULT_PHASES, isLocalMode } from './protocol.js';
import { ClientLink } from './transport.js';

registerSW('./sw.js');
const q = new URLSearchParams(location.search);
const pin = q.get('pin');
const key = q.get('key');
const app = document.getElementById('app');

if (!pin || !key) startPicker();
else start();

/** No show chosen yet: list the shows running on this device's sync group. */
async function startPicker() {
  const { sync } = await import('./sync.js');
  await sync.init({ lite: true });          // lite = only live-show info, no project/media copy
  const dot = h('span.dot');
  const list = h('div.r-shows');
  app.append(h('div.r', h('header.r-head', dot, h('h1', 'Host remote')), list));

  const render = () => {
    dot.className = 'dot ' + (sync.status === 'online' ? 'online' : sync.status === 'connecting' ? 'connecting' : '');
    if (sync.status === 'off') {
      list.replaceChildren(h('div.r-msg',
        h('h2', 'Connect this phone'),
        h('p', 'To see running shows here, add this phone to your sync group: on a host computer open Dashboard → Device sync → Add a device, and scan the QR code with this phone.'),
        h('p', 'Or scan the “Remote” QR code shown in the host console.'),
        h('a.btn.primary', { href: './' }, 'Open the Host app'),
      ));
      return;
    }
    const shows = sync.liveShows();
    if (!shows.length) {
      list.replaceChildren(h('div.r-msg',
        h('div.pulse-sm'),
        h('h2', sync.status === 'online' ? 'No show is running right now' : 'Looking for your devices…'),
        h('p', 'Start a show on any of your host computers — it appears here automatically.'),
      ));
      return;
    }
    list.replaceChildren(
      h('div.r-label', 'Running now — tap to control'),
      ...shows.map((s) => {
        const u = new URL(location.href);
        u.search = '';
        u.searchParams.set('pin', s.pin);
        u.searchParams.set('key', s.remoteKey);
        if (s.backend === 'local') u.searchParams.set('local', '1');
        return h('a.r-show', { href: u.toString() },
          h('b', { dir: 'auto' }, s.projectName || 'Untitled'),
          h('span', `${s.deviceName} · code ${s.pin} · ${PHASE_LABEL[s.phase] || ''}${s.players != null ? ` · ${s.players} players` : ''}`),
          icon('next'),
        );
      }),
    );
  };
  sync.addEventListener('update', render);
  setInterval(render, 5000);
  render();
}

function start() {
  let st = null;
  let rxAt = 0;
  const dot = h('span.dot.connecting');
  const head = h('header.r-head', dot, h('h1', 'Host remote'), h('span.r-pin', pin), h('a.btn.sm.ghost', { href: './remote.html', title: 'All running shows' }, 'Shows'));
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
  const mainBtn = btn('toggleTimer', 'Open voting', 'play', '');
  const nextBtn = h('button.btn.primary.r-next', { dataset: { cmd: 'next' }, onclick: () => send('next') },
    h('span.r-next-top', icon('next'), 'Next'), h('span.r-next-what'));
  const joinBtn = btn('joinLock', 'Late join', 'users');
  const ovs = [['count', 'Count', 'users'], ['percent', 'Percent', 'percent'], ['teams', 'Teams', 'split'], ['leaderboard', 'Fastest', 'trophy']]
    .map(([v, l, i]) => { const b = btn('overlay', l, i, '', v); b.dataset.ov = v; return b; });
  const jump = h('select.input', { onchange: () => { if (jump.value !== '') send('goto', Number(jump.value)); } });
  const mute = btn('mute', 'Mute', 'vol');
  const bg = btn('music', 'Music', 'music');

  body.append(
    h('section.r-status', phase, qtext, counts, bars),
    nextBtn,
    h('div.r-row', btn('prev', 'Previous', 'prev'), bg, mute),
    h('div.r-label', 'Manual controls'),
    h('div.r-row', mainBtn, btn('lock', 'Close voting', 'lock'), btn('reveal', 'Reveal', 'eye')),
    h('div.r-row', btn('skip', 'Skip typing', 'skip'), btn('intro', 'Intro', 'sparkle'), btn('lobby', 'Join screen', 'qr')),
    h('div.r-row', joinBtn, btn('resetSlide', 'Reset question', 'stop'), h('span')),
    h('div.r-label', 'Show on screen'),
    h('div.r-ov', ovs),
    h('div.r-label', 'Jump to slide'),
    jump,
    h('button.btn.sm.ghost', { onclick: () => { if (confirm('Go to the end screen?')) send('end'); } }, icon('flag'), 'End screen'),
  );

  function render() {
    if (!st) return;
    phase.querySelector('.dot').className = 'dot ' + ({ open: 'online', paused: 'connecting', typing: 'connecting' }[st.phase] || '');
    phase.querySelector('.pl').textContent = PHASE_LABEL[st.phase] || st.phase;
    const showQ = st.slide && ![PHASE.LOBBY, PHASE.INTRO, PHASE.END].includes(st.phase);
    nextBtn.querySelector('.r-next-what').textContent = st.nextLabel || '';
    nextBtn.disabled = st.phase === PHASE.END;
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
    mainBtn.replaceChildren(icon(open ? 'pause' : 'play'), h('span', open ? 'Pause' : st.phase === PHASE.PAUSED ? 'Resume' : st.phase === PHASE.CLOSED ? 'Reopen' : 'Open voting'));
    mainBtn.disabled = [PHASE.LOBBY, PHASE.INTRO, PHASE.END, ...RESULT_PHASES].includes(st.phase);
    body.querySelector('[data-cmd="skip"]').disabled = st.phase !== PHASE.TYPING;
    body.querySelector('[data-cmd="lock"]').disabled = ![PHASE.OPEN, PHASE.PAUSED, PHASE.READY, PHASE.TYPING].includes(st.phase);
    body.querySelector('[data-cmd="intro"]').disabled = !st.hasIntro || st.phase === PHASE.INTRO;
    body.querySelector('[data-cmd="prev"]').disabled = st.phase === PHASE.LOBBY;
    joinBtn.disabled = st.phase === PHASE.LOBBY;
    joinBtn.replaceChildren(icon('users'), h('span', st.phase === PHASE.LOBBY ? 'Joining open' : st.joinOpen ? 'Close joining' : 'Late join'));
    joinBtn.classList.toggle('on', st.phase !== PHASE.LOBBY && st.joinOpen);
    const voting = [PHASE.TYPING, PHASE.READY, PHASE.OPEN, PHASE.PAUSED].includes(st.phase);
    ovs.forEach((b) => {
      b.classList.toggle('on', !!st.overlays[b.dataset.ov]);
      if (b.dataset.ov !== 'count') b.disabled = voting || (b.dataset.ov === 'teams' && st.teams.length < 2);
    });
    mute.replaceChildren(icon(st.muted ? 'mute' : 'vol'), h('span', st.muted ? 'Muted' : 'Mute'));
    mute.classList.toggle('on', st.muted);
    bg.disabled = !st.musicAvailable && !st.musicOn;
    bg.replaceChildren(icon('music'), h('span', st.musicOn ? 'Music on' : 'Music off'));
    bg.classList.toggle('on', !!st.musicOn);
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
