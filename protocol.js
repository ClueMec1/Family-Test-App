// Shared protocol constants + helpers used by the Host and Participant PWAs.
// Every message on the wire is a plain JSON object with a `t` (type) field.

export const APP_VERSION = '1.0.0';
export const PEER_PREFIX = 'clkshow-he-v1-';           // host peer id = PREFIX + PIN
export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];
export const HEARTBEAT_MS = 4000;     // client -> host ping interval
export const STALE_MS = 13000;        // no traffic for this long = offline / reconnect

/** Message types */
export const T = {
  // participant -> host
  HELLO: 'hello',         // {role:'participant', pid}  (first message on a new link)
  JOIN: 'join',           // {pid, name, team}
  ANSWER: 'answer',       // {pid, slideId, choice}
  PING: 'ping',
  // host -> participant
  INFO: 'info',           // {projectName, teams:[{id,name,color}], joined:bool, me?}
  STATE: 'state',         // public show state (see Hub.publicState)
  ACK: 'ack',             // {slideId, choice, ok, reason?}
  PONG: 'pong',
  KICK: 'kick',           // {reason}
  // remote <-> host
  CMD: 'cmd',             // {cmd, value?}
  RSTATE: 'rstate',       // full remote dashboard state
  DENIED: 'denied',
};

/** Show phases */
export const PHASE = {
  LOBBY: 'lobby',     // join screen on HDMI (joining open)
  INTRO: 'intro',     // host's intro screen (text + music, or a video)
  TYPING: 'typing',   // question typing onto the screen, answers not yet accepted
  READY: 'ready',     // typed, waiting for host to open voting (autoStart off)
  OPEN: 'open',       // accepting answers (timer may be running)
  PAUSED: 'paused',   // timer paused, answers not accepted
  CLOSED: 'closed',   // voting closed (timer ran out or host locked)
  REVEAL: 'reveal',   // correct answer + percentages shown
  TEAMS: 'teams',     // team breakdown + round winner
  BOARD: 'board',     // top 10 fastest (correct) players
  END: 'end',         // end-of-show screen
};

export const PHASE_LABEL = {
  [PHASE.LOBBY]: 'Join screen',
  [PHASE.INTRO]: 'Intro',
  [PHASE.TYPING]: 'Typing question…',
  [PHASE.READY]: 'Ready — waiting to open',
  [PHASE.OPEN]: 'Voting open',
  [PHASE.PAUSED]: 'Paused',
  [PHASE.CLOSED]: 'Voting closed',
  [PHASE.REVEAL]: 'Answer revealed',
  [PHASE.TEAMS]: 'Team results',
  [PHASE.BOARD]: 'Fastest players',
  [PHASE.END]: 'Show ended',
};

/** Phases where results (percentages, teams, leaderboard) may be shown. Never during voting. */
export const RESULT_PHASES = [PHASE.REVEAL, PHASE.TEAMS, PHASE.BOARD];

export const OVERLAYS = ['count', 'percent', 'teams', 'leaderboard'];

export const TEAM_PALETTE = ['#22d3ee', '#f472b6', '#fbbf24', '#a3e635', '#a78bfa', '#fb923c'];
export const OPTION_COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#06b6d4'];

export const TEAM_PRESETS = [
  { id: 'none', label: 'No teams', teams: [] },
  { id: 'gender', label: 'Men / Women', teams: ['Men', 'Women'] },
  { id: 'ab', label: 'Team A / Team B', teams: ['Team A', 'Team B'] },
  { id: 'four', label: '4 teams', teams: ['Red', 'Blue', 'Yellow', 'Green'] },
];

export const hostPeerId = (pin) => PEER_PREFIX + String(pin);

export function randomPin() {
  return String(1000 + Math.floor(Math.random() * 9000));
}

export function uid(len = 10) {
  const a = new Uint8Array(len);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
}

/** Build teams array with stable ids + colors from a list of names. */
export function teamsFromNames(names = []) {
  return names
    .map((n) => String(n).trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((name, i) => ({ id: 't' + i, name, color: TEAM_PALETTE[i % TEAM_PALETTE.length] }));
}

export function cleanName(s) {
  return String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 24);
}

export function isLocalMode() {
  return new URLSearchParams(location.search).get('local') === '1';
}
