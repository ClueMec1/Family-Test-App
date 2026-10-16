// Project & question configurator with live stage preview.
import { h, toast, debounce } from './ui.js';
import { icon } from './icons.js';
import { PHASE, TEAM_PRESETS, OPTION_COLORS, teamsFromNames } from './protocol.js';
import { getProject, saveProject, newSlide, listMedia, getJoinBase, dbEvents, addMedia, isVideo } from './db.js';
import { topbar } from './dashboard.js';
import { Stage } from './stage.js';
import { audio } from './audio.js';

const TIMERS = [0, 10, 20, 30, 60, 120];
const INTRO = -1;                  // `sel` value for the intro item

export async function mountEditor(root, id) {
  const project = await getProject(id);
  if (!project) { location.hash = '#/'; return null; }
  project.intro ||= { type: 'none', title: '', text: '', showSteps: true, musicId: null, videoId: null };
  let media = await listMedia();
  const audioMedia = () => media.filter((m) => !isVideo(m));
  const videoMedia = () => media.filter((m) => isVideo(m));
  const joinBase = await getJoinBase();
  let sel = 0;

  const savedEl = h('span.saved', 'Saved');
  let dirty = false;
  const persist = debounce(async () => { if (!dirty) return; dirty = false; await saveProject(project); savedEl.textContent = 'Saved ✓'; }, 400);
  const touch = () => { dirty = true; savedEl.textContent = 'Saving…'; persist(); };

  const nameIn = h('input.title-input', { value: project.name, dir: 'rtl', placeholder: 'Project name', 'aria-label': 'Project name', oninput: () => { project.name = nameIn.value; touch(); } });
  const bar = topbar(
    h('a.btn.sm.ghost', { href: '#/', title: 'Back' }, icon('back'), 'Projects'),
    nameIn, savedEl,
  );
  bar.insertBefore(h('button.btn.primary.sm', { onclick: async () => { persist.flush(); audio.unlock(); location.hash = `#/show/${project.id}`; } }, icon('play'), 'Start show'), bar.lastChild);

  const settings = h('section.panel');
  const listPanel = h('section.panel');
  const slideList = h('div.slide-list');
  const form = h('section.panel.stack');
  const previewBox = h('div.preview-box');
  const side = h('aside.side', settings, listPanel);
  const mainCol = h('div.stack', form, h('section.panel.stack',
    h('div.row', h('h3', icon('screen'), 'Screen preview'), h('div.spacer'), h('button.btn.sm', { onclick: replay }, icon('play'), 'Replay')),
    previewBox,
  ));
  root.append(bar, h('main.editor', side, mainCol));

  const stage = new Stage(previewBox);

  /* ---------- helpers ---------- */
  function mediaSelect(list, value, onChange, emptyLabel, extra = []) {
    const s = h('select.input', { onchange: () => onChange(s.value || null) },
      h('option', { value: '' }, emptyLabel),
      extra.map(([v, label]) => h('option', { value: v, selected: v === value }, label)),
      list.map((m) => h('option', { value: m.id, selected: m.id === value, dir: 'auto' }, m.name)));
    return s;
  }
  function seg(options, value, onPick) {
    const wrap = h('div.seg');
    options.forEach(([v, label, disabled]) => wrap.append(h('button', { type: 'button', class: v === value ? 'on' : '', disabled, onclick: () => onPick(v) }, label)));
    return wrap;
  }
  const toggle = (checked, label, onChange, disabled = false) => {
    const input = h('input', { type: 'checkbox', checked, disabled, onchange: () => onChange(input.checked) });
    return h('label.toggle', input, h('span', label));
  };

  /* ---------- event settings ---------- */
  function renderSettings() {
    const presetId = TEAM_PRESETS.find((p) => p.teams.join('|') === project.teams.join('|'))?.id || 'custom';
    const teamsIn = h('input.input', { value: project.teams.join(', '), dir: 'rtl', placeholder: 'e.g. Men, Women', oninput: () => { project.teams = teamsIn.value.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 6); touch(); renderForm(); refreshPreview(); } });
    const preset = h('select.input', {
      onchange: () => {
        const p = TEAM_PRESETS.find((x) => x.id === preset.value);
        if (p) { project.teams = [...p.teams]; teamsIn.value = p.teams.join(', '); touch(); renderForm(); refreshPreview(); }
      },
    }, TEAM_PRESETS.map((p) => h('option', { value: p.id, selected: p.id === presetId }, p.label)), h('option', { value: 'custom', selected: presetId === 'custom' }, 'Custom'));
    const vol = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: project.bgVolume ?? 0.35, oninput: () => { project.bgVolume = Number(vol.value); touch(); } });
    const sfx = (slot, label, builtin) => h('label.field', h('span', label), mediaSelect(audioMedia(), project.sfx?.[slot], (v) => { project.sfx = { ...(project.sfx || {}), [slot]: v }; touch(); }, builtin));
    settings.replaceChildren(
      h('h3', icon('users'), 'Event settings'),
      h('div.stack',
        h('label.field', h('span', 'Teams'), preset),
        h('label.field', h('span', 'Team names (comma-separated)'), teamsIn),
        h('label.field', h('span', 'Join screen music'),
          mediaSelect(audioMedia(), project.bgTrackId, (v) => { project.bgTrackId = v; touch(); }, 'None')),
        h('p.hint', 'Plays automatically while people join. During the show, press Music to play it any time.'),
        h('label.field', h('span', 'Music volume'), vol),
        toggle(project.autoStart !== false, 'Open voting automatically when the question finishes typing', (v) => { project.autoStart = v; touch(); }),
        toggle(!!project.autoReveal, 'Reveal the answer automatically when time runs out', (v) => { project.autoReveal = v; touch(); }),
        h('details', h('summary.label', 'Sound effects'),
          h('div.stack', { style: { marginTop: '10px' } },
            sfx('reveal', 'Answer reveal', 'Built-in (epic reveal)'),
            sfx('timeup', 'Time’s up', 'Built-in'),
            sfx('answer', 'Player taps an answer', 'Built-in'))),
        media.length ? null : h('p.hint', 'Upload music, effects and videos in the Media library on the main screen.'),
      ),
    );
  }

  /* ---------- slide list (drag to reorder) ---------- */
  let dragFrom = null;
  const introSummary = () => {
    const i = project.intro;
    if (i.type === 'video') return i.videoId ? 'Video' : 'Video — none chosen';
    if (i.type === 'text') return `Text${i.musicId ? ' + music' : ''}`;
    return 'Off';
  };
  function renderList() {
    const introItem = h('div.slide-item.intro-item', { role: 'button', tabindex: 0, onclick: () => select(INTRO), onkeydown: (e) => { if (e.key === 'Enter') select(INTRO); } },
      h('span.num', { html: '' }, icon('sparkle')),
      h('span.q', h('span.q-line', 'Intro'), h('small', introSummary())),
      h('span'),
    );
    introItem.classList.toggle('active', sel === INTRO);
    slideList.replaceChildren(introItem, ...project.slides.map((s, i) => {
      const item = h('div.slide-item', {
        draggable: true, role: 'button', tabindex: 0,
        onclick: () => select(i),
        onkeydown: (e) => { if (e.key === 'Enter') select(i); },
        ondragstart: (e) => { dragFrom = i; item.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; },
        ondragend: () => { item.classList.remove('dragging'); slideList.querySelectorAll('.drop-before').forEach((x) => x.classList.remove('drop-before')); },
        ondragover: (e) => { e.preventDefault(); item.classList.add('drop-before'); },
        ondragleave: () => item.classList.remove('drop-before'),
        ondrop: (e) => { e.preventDefault(); if (dragFrom != null && dragFrom !== i) move(dragFrom, i); dragFrom = null; },
      },
        h('span.num', i + 1),
        h('span.q', h('span.q-line', { dir: s.question ? 'rtl' : 'ltr' }, s.question || 'Untitled question'), h('small', `${s.type === 'quiz' ? 'Quiz' : 'Survey'} · ${s.options.length} answers · ${s.timer ? s.timer + 's' : 'no timer'}`)),
        h('span.tools',
          h('button.icon-btn', { title: 'Move up', onclick: (e) => { e.stopPropagation(); if (i > 0) move(i, i - 1); } }, icon('up')),
          h('button.icon-btn', { title: 'Move down', onclick: (e) => { e.stopPropagation(); if (i < project.slides.length - 1) move(i, i + 1); } }, icon('down')),
          h('button.icon-btn', { title: 'Duplicate', onclick: (e) => { e.stopPropagation(); dup(i); } }, icon('copy')),
          h('button.icon-btn', { title: 'Delete', onclick: (e) => { e.stopPropagation(); remove(i); } }, icon('trash')),
        ),
      );
      item.classList.toggle('active', i === sel);
      return item;
    }));
  }
  listPanel.append(
    h('div.row', h('h3', icon('chart'), 'Show order'), h('div.spacer'), h('span.hint', 'Drag to reorder')),
    slideList,
    h('button.btn.sm', { style: { marginTop: '10px', width: '100%' }, onclick: add }, icon('plus'), 'New question'),
  );

  function move(from, to) {
    const [s] = project.slides.splice(from, 1);
    project.slides.splice(to, 0, s);
    sel = to;
    touch(); renderList(); renderForm(); refreshPreview();
  }
  function add() {
    const prev = project.slides[project.slides.length - 1];
    project.slides.push(newSlide(prev ? { timer: prev.timer, typeSpeed: prev.typeSpeed, type: prev.type, correct: prev.type === 'quiz' ? 0 : null } : {}));
    sel = project.slides.length - 1;
    touch(); renderList(); renderForm(); replay();
    form.querySelector('textarea')?.focus();
  }
  function dup(i) {
    project.slides.splice(i + 1, 0, { ...structuredClone(project.slides[i]), id: newSlide().id });
    sel = i + 1;
    touch(); renderList(); renderForm(); replay();
  }
  function remove(i) {
    if (project.slides.length <= 1) return toast('A project needs at least one question', 'error');
    if (!confirm('Delete this question?')) return;
    project.slides.splice(i, 1);
    sel = Math.min(sel, project.slides.length - 1);
    touch(); renderList(); renderForm(); replay();
  }
  function select(i) { sel = i; renderList(); renderForm(); replay(); }

  /* ---------- intro form ---------- */
  function renderIntroForm() {
    const it = project.intro;
    const update = (patch, rerender = false) => { Object.assign(it, patch); touch(); renderList(); if (rerender) renderForm(); refreshPreview(true); };
    const title = h('input.input', { value: it.title || '', dir: 'rtl', placeholder: project.name || 'Welcome!', oninput: () => update({ title: title.value }) });
    const text = h('textarea.input', { rows: 5, dir: 'rtl', value: it.text || '', placeholder: 'Your welcome message, the rules, anything for this occasion…', oninput: () => update({ text: text.value }) });
    const videoIn = h('input', {
      type: 'file', accept: 'video/*,.mp4,.webm,.mov', hidden: true,
      onchange: async () => {
        const f = videoIn.files[0];
        if (!f) return;
        toast('Saving the video…', 'info');
        const item = await addMedia(f);
        media = await listMedia();
        update({ videoId: item.id }, true);
        toast('Video added', 'ok');
      },
    });
    form.replaceChildren(
      h('div.row', h('h3', icon('sparkle'), 'Intro'), h('div.spacer'),
        seg([['none', 'No intro'], ['text', 'Text & music'], ['video', 'Video (MP4)']], it.type, (v) => update({ type: v }, true))),
      h('p.hint', 'Plays after the join screen, before the first question. Pressing Next on the join screen closes joining and starts the intro.'),
      it.type === 'text' ? h('div.stack',
        h('label.field', h('span', 'Title'), title),
        h('label.field', h('span', 'Message'), text),
        toggle(it.showSteps !== false, 'Show the “How to play” steps', (v) => update({ showSteps: v })),
        h('label.field', h('span', 'Intro music'), mediaSelect(audioMedia(), it.musicId, (v) => update({ musicId: v }), 'None')),
        h('p.hint', 'The intro music starts automatically and fades out when you press Next.'),
      ) : null,
      it.type === 'video' ? h('div.stack',
        h('label.field', h('span', 'Video'), mediaSelect(videoMedia(), it.videoId, (v) => update({ videoId: v }, true), 'Choose a video…')),
        h('div.row', h('button.btn.sm', { onclick: () => videoIn.click() }, icon('upload'), 'Upload an MP4'), videoIn,
          h('span.hint', 'Plays full screen with its own sound. No text needed.')),
      ) : null,
    );
  }

  /* ---------- slide form ---------- */
  function renderForm() {
    if (sel === INTRO) return renderIntroForm();
    const s = project.slides[sel];
    const update = (patch, { rerender = false } = {}) => {
      Object.assign(s, patch);
      touch();
      renderList();
      if (rerender) renderForm();
      refreshPreview(patch.question !== undefined || patch.options !== undefined);
    };
    const teamsOk = teamsFromNames(project.teams).length > 1;
    const q = h('textarea.input', { rows: 2, dir: 'rtl', placeholder: 'Type the question here…', value: s.question, oninput: () => update({ question: q.value }) });
    const optRows = s.options.map((o, i) => {
      const inp = h('input.input', { value: o, dir: 'rtl', placeholder: `Answer ${i + 1}`, oninput: () => { s.options[i] = inp.value; update({ options: s.options }); } });
      // RTL row: number on the right, then the answer, then the 'correct' toggle on the left
      return h('div.opt-edit', { dir: 'rtl' },
        h('span.num', { style: { '--c': OPTION_COLORS[i] } }, `${i + 1}.`),
        inp,
        s.type === 'quiz'
          ? h('button.correct-pick', { type: 'button', dir: 'ltr', class: s.correct === i ? 'on' : '', onclick: () => update({ correct: i }, { rerender: true }) }, icon('check'), s.correct === i ? 'Correct' : 'Mark correct')
          : h('span'),
      );
    });
    const custom = h('input.input', { type: 'number', min: 0, max: 600, value: s.timer, style: { width: '90px' }, oninput: () => update({ timer: Math.max(0, Math.min(600, Number(custom.value) || 0)) }) });
    const cps = Math.round(1000 / (s.typeSpeed || 45));
    const speedLabel = h('span.hint', `${cps} characters / second`);
    const speed = h('input', {
      type: 'range', min: 5, max: 80, step: 1, value: cps,
      oninput: () => { speedLabel.textContent = `${speed.value} characters / second`; Object.assign(s, { typeSpeed: Math.round(1000 / Number(speed.value)) }); touch(); },
      onchange: () => replay(),
    });
    const music = s.music ?? 'countdown';
    const musicSel = mediaSelect(audioMedia(), music === 'countdown' || music === 'none' ? null : music,
      (v) => update({ music: v || 'countdown' }, { rerender: true }), 'Built-in ticking countdown', [['none', 'Silent']]);
    if (music === 'none') musicSel.value = 'none';

    form.replaceChildren(
      h('div.row', h('h3', `Question ${sel + 1}`), h('div.spacer'),
        seg([['quiz', 'Quiz (correct answer)'], ['survey', 'Opinion survey']], s.type, (v) => update({ type: v, correct: v === 'quiz' ? (s.correct ?? 0) : null }, { rerender: true }))),
      h('label.field', h('span', 'Question'), q),
      h('div.row', h('span.label', 'Number of buttons'),
        seg([1, 2, 3, 4, 5].map((n) => [n, String(n)]), s.options.length, (n) => {
          const opts = s.options.slice(0, n);
          while (opts.length < n) opts.push('');
          update({ options: opts, correct: s.type === 'quiz' ? Math.min(s.correct ?? 0, n - 1) : null }, { rerender: true });
        })),
      h('div.stack', optRows),
      h('div.row', h('span.label', icon('timer'), ' Timer'),
        seg(TIMERS.map((t) => [t, t ? (t >= 60 ? `${t / 60} min` : `${t}s`) : 'Off']), s.timer, (t) => update({ timer: t }, { rerender: true })),
        h('span.hint', 'or'), custom, h('span.hint', 'seconds')),
      h('div.music-box',
        h('label.field', h('span', icon('music'), ' Music while voting'), musicSel),
        music !== 'none' ? toggle(s.musicAuto !== false, 'Start it automatically when voting opens', (v) => update({ musicAuto: v })) : null,
        h('p.hint', music === 'countdown'
          ? 'A ticking-clock countdown that builds up excitement and lands exactly when time runs out.'
          : music === 'none' ? 'No music — just short beeps in the last 5 seconds.'
            : 'Your track loops while people vote. Turn off “automatically” to start it yourself with the Music button.'),
      ),
      h('div.field', h('span.label', 'After the question (each one is a press of Next)'),
        h('div.steps-box',
          h('span.step-chip.fixed', '1. Reveal answer & percentages'),
          toggle(s.teamStep !== false && teamsOk, '2. Team results & round winner', (v) => update({ teamStep: v }), !teamsOk),
          s.type === 'quiz' ? toggle(s.boardStep !== false, '3. Top 10 fastest correct players', (v) => update({ boardStep: v })) : null,
        ),
        teamsOk ? null : h('span.hint', 'Team results need at least 2 teams in Event settings.'),
      ),
      h('div.field', h('div.row', h('span.label', 'Typing speed'), h('div.spacer'), speedLabel), speed),
    );
  }

  /* ---------- preview ---------- */
  let typingStart = Date.now();
  function previewState() {
    const teams = teamsFromNames(project.teams);
    const base = {
      pin: '1234', joinUrl: joinBase ? joinBase + '?pin=1234' : '', projectName: project.name, teams,
      overlays: { count: true, percent: false, teams: false, leaderboard: false },
      recentNames: [], intro: project.intro, introStart: typingStart, joinOpen: true,
      timerEnd: null, timerRemaining: null,
    };
    const zero = (n) => ({ counts: Array(n).fill(0), percents: Array(n).fill(0), byTeam: {}, teamTotals: {}, answered: 0, online: 0, joined: 0, leaderboard: [], leaderboardKind: 'correct' });
    if (sel === INTRO) {
      return { ...base, phase: project.intro.type === 'none' ? PHASE.LOBBY : PHASE.INTRO, idx: 0, total: project.slides.length, slide: null, typingStart, timerTotal: 0, stats: zero(0) };
    }
    const s = project.slides[sel];
    return { ...base, phase: PHASE.TYPING, idx: sel, total: project.slides.length, slide: s, typingStart, timerTotal: (s.timer || 0) * 1000, stats: zero(s.options.length) };
  }
  function refreshPreview(textChanged) {
    if (textChanged && sel !== INTRO) typingStart = Date.now() - 1e7;    // show edits instantly, typed
    stage.setState(previewState());
  }
  function replay() { typingStart = Date.now(); stage.setState(previewState()); }

  renderSettings();
  renderList();
  renderForm();
  replay();

  const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); persist.flush(); toast('Saved', 'ok', 1200); } };
  window.addEventListener('keydown', onKey);

  // Another device edited or deleted this project: reload it here (unless you're mid-edit).
  const onDb = async (e) => {
    const { kind, id: changedId, origin } = e.detail;
    if (kind === 'media' || (kind === 'tomb' && changedId !== project.id)) { media = await listMedia(); renderSettings(); renderForm(); return; }
    if (changedId !== project.id || origin === 'local') return;
    if (kind === 'tomb') { toast('This project was deleted on another device', 'error', 4000); location.hash = '#/'; return; }
    if (kind === 'project' && !dirty) { toast('Updated from another device', 'info', 2000); window.__remount?.(); }
  };
  dbEvents.addEventListener('change', onDb);
  return () => { dbEvents.removeEventListener('change', onDb); persist.flush(); bar.cleanup(); stage.destroy(); window.removeEventListener('keydown', onKey); };
}
