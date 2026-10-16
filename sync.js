// Device sync for the Host app.
//
// All host devices that share a sync code form a "sync group". They find each other through the
// same free PeerJS broker used for shows, then talk directly over WebRTC (encrypted DataChannels).
//
// Topology: one device in the group holds a well-known peer id derived from the code and acts as
// the group hub; the others connect to it. If the hub goes away, the remaining devices race to take
// its place (whoever gets the id first wins) and everyone reconnects — no server, no setup.
//
// Every device keeps a FULL copy of projects, media and the Join app address in its own IndexedDB,
// so it keeps working offline and anything saved elsewhere stays saved here too.
// Running shows are announced to the whole group, so any device (e.g. a phone) can open the
// remote control for a show that's running on another computer.
//
// Security: the code itself never leaves the device. Peer ids use a hash of it, and both sides
// prove they know the code (challenge/response with SHA-256) before any data is exchanged.

import { ICE_SERVERS, uid } from './protocol.js';
import { loadPeerJS } from './transport.js';
import {
  dbEvents, listProjects, getProject, listMedia, getMedia, listTombstones, getTombstone,
  applyRemoteProject, applyRemoteMedia, applyRemoteTombstone,
  getSetting, getSettingRecord, setSetting, getDeviceId, getDeviceName,
} from './db.js';

const SYNCED_SETTINGS = ['joinUrl'];
const CHUNK = 192 * 1024;
const PING_MS = 4000;
const STALE_MS = 14000;
const SHOW_TTL = 16000;

/* ------------------------------------------------------------------ helpers */

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Human-friendly code like "K7QF-M2XA-9TRD" (no 0/O/1/I to avoid typos). */
export function newSyncCode() {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  const s = Array.from(a, (b) => abc[b % abc.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}
export function normalizeSyncCode(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.length === 12 ? `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}` : '';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => a + Math.random() * (b - a);

/* ------------------------------------------------------------- GroupLink ---
 * Network layer. Role 'hub' or 'member'. Emits:
 *   onMessage(msg, fromConnId|'hub'), onMemberJoin(connId), onMemberLeave(connId), onState()
 */
class GroupLink {
  constructor({ code, backend, me, onMessage, onMemberJoin, onMemberLeave, onState }) {
    Object.assign(this, { code, backend, me, onMessage, onMemberJoin, onMemberLeave, onState });
    this.role = null;
    this.status = 'connecting';
    this.members = new Map();     // hub: connId -> {conn, meta, authed, lastRx}
    this.closed = false;
    this._ping = setInterval(() => this._heartbeat(), PING_MS);
    this._start();
  }

  async _start() {
    this.groupId = (await sha256hex('clicker-group|' + this.code)).slice(0, 32);
    this.peerId = 'clkshow-grp-v1-' + this.groupId;
    this._loop();
  }

  _set(status, role = this.role) {
    this.status = status;
    this.role = role;
    this.onState();
  }

  async _loop() {
    while (!this.closed) {
      this._set('connecting', null);
      let ended;
      try {
        const asHub = await this._tryHub();
        if (asHub) ended = asHub;                 // promise that resolves when hub role ends
        else ended = await this._tryMember();     // resolves when membership ends
        await ended;
      } catch (e) {
        console.warn('[sync] link error', e);
      }
      this._teardown?.();
      this._teardown = null;
      if (this.closed) break;
      await sleep(jitter(800, 2600));             // random back-off so devices don't collide re-electing
    }
  }

  close() {
    this.closed = true;
    clearInterval(this._ping);
    this._teardown?.();
  }

  /* ----- sending ----- */
  send(msg, exceptConnId) {
    if (this.role === 'hub') {
      for (const [id, m] of this.members) if (m.authed && id !== exceptConnId) m.conn.send(msg);
    } else if (this.role === 'member' && this._hubConn?.authed) {
      this._hubConn.send(msg);
    }
  }
  /** Like send(), but on the hub skips "lite" members (phone remotes that don't store data). */
  sendData(msg, exceptConnId) {
    if (this.role === 'hub') {
      for (const [id, m] of this.members) if (m.authed && id !== exceptConnId && !m.meta?.lite) m.conn.send(msg);
    } else this.send(msg);
  }
  sendTo(target, msg) {
    if (target === 'hub') { if (this._hubConn?.authed) this._hubConn.send(msg); return; }
    const m = this.members.get(target);
    if (m?.authed) m.conn.send(msg);
  }
  /** Wait until the outgoing buffer to `target` drains a bit (used for media transfers). */
  async drain(target) {
    const conn = target === 'hub' ? this._hubConn : this.members.get(target)?.conn;
    for (let i = 0; i < 400 && conn && conn.buffered() > 2_000_000; i++) await sleep(25);
  }
  isLite(connId) { return !!this.members.get(connId)?.meta?.lite; }

  /* ----- heartbeat ----- */
  _heartbeat() {
    const now = Date.now();
    if (this.role === 'member' && this._hubConn?.authed) {
      this._hubConn.send({ t: 'ping' });
      if (now - this._hubConn.lastRx > STALE_MS) this._hubConn.drop();
    } else if (this.role === 'hub') {
      for (const [id, m] of this.members) if (now - m.lastRx > STALE_MS + 4000) { m.conn.close(); this._memberGone(id); }
    }
  }

  /* ----- hub side ----- */
  _hubAccept(conn) {
    // conn: {id, meta, send, close, buffered, onData(fn), onClose(fn)}
    const m = { conn, meta: conn.meta || {}, authed: false, lastRx: Date.now() };
    this.members.set(conn.id, m);
    const nonceH = uid(16);
    (async () => {
      const proof = await sha256hex(`${this.code}|hub|${m.meta.nonce || ''}`);
      conn.send({ t: 'hello', nonce: nonceH, proof });
    })();
    const timeout = setTimeout(() => { if (!m.authed) { conn.close(); this._memberGone(conn.id); } }, 10000);
    conn.onData(async (msg) => {
      m.lastRx = Date.now();
      if (!msg || typeof msg !== 'object') return;
      if (!m.authed) {
        if (msg.t === 'auth' && msg.proof === await sha256hex(`${this.code}|member|${nonceH}`)) {
          m.authed = true;
          clearTimeout(timeout);
          conn.send({ t: 'welcome', hub: this.me });
          this.onMemberJoin(conn.id);
        } else if (msg.t === 'auth') { conn.close(); this._memberGone(conn.id); }
        return;
      }
      if (msg.t === 'ping') { conn.send({ t: 'pong' }); return; }
      this.onMessage(msg, conn.id);
    });
    conn.onClose(() => { clearTimeout(timeout); this._memberGone(conn.id); });
  }

  _memberGone(id) {
    const m = this.members.get(id);
    if (!m) return;
    this.members.delete(id);
    if (m.authed) this.onMemberLeave(id);
  }

  /* ----- member side ----- */
  _memberAttach(conn, resolveEnded) {
    // conn: {send, close, buffered, onData, onClose}
    const nonceM = this._nonceM;
    conn.authed = false;
    conn.lastRx = Date.now();
    let done = false;
    conn.drop = () => { if (done) return; done = true; try { conn.close(); } catch (e) { /* */ } resolveEnded(); };
    conn.onData(async (msg) => {
      conn.lastRx = Date.now();
      if (!msg || typeof msg !== 'object') return;
      if (!conn.authed) {
        if (msg.t === 'hello') {
          if (msg.proof !== await sha256hex(`${this.code}|hub|${nonceM}`)) { conn.drop(); return; }   // not our group
          conn.send({ t: 'auth', proof: await sha256hex(`${this.code}|member|${msg.nonce}`) });
        } else if (msg.t === 'welcome') {
          conn.authed = true;
          this._hubConn = conn;
          this.hubInfo = msg.hub;
          this._set('online', 'member');
          this.onMessage({ t: '_welcomed' }, 'hub');
        }
        return;
      }
      if (msg.t === 'pong') return;
      this.onMessage(msg, 'hub');
    });
    conn.onClose(() => conn.drop());
  }

  /* ----- backends ----- */
  _tryHub() { return this.backend === 'local' ? this._tryHubLocal() : this._tryHubPeer(); }
  _tryMember() { return this.backend === 'local' ? this._tryMemberLocal() : this._tryMemberPeer(); }

  async _tryHubPeer() {
    const Peer = await loadPeerJS();
    return new Promise((resolve) => {
      const peer = new Peer(this.peerId, { debug: 1, config: { iceServers: ICE_SERVERS } });
      let opened = false;
      let resolveEnded;
      const ended = new Promise((r) => { resolveEnded = r; });
      peer.on('open', () => {
        if (opened) { this._set('online', 'hub'); return; }
        opened = true;
        this._teardown = () => { try { peer.destroy(); } catch (e) { /* */ } this.members.clear(); };
        this._set('online', 'hub');
        resolve(ended);
      });
      peer.on('connection', (dc) => {
        const handlers = { data: [], close: [] };
        const conn = {
          id: dc.peer + ':' + dc.connectionId,
          meta: dc.metadata || {},
          send: (m) => { try { if (dc.open) dc.send(m); } catch (e) { /* */ } },
          close: () => { try { dc.close(); } catch (e) { /* */ } },
          buffered: () => dc.dataChannel?.bufferedAmount || 0,
          onData: (fn) => handlers.data.push(fn),
          onClose: (fn) => handlers.close.push(fn),
        };
        dc.on('open', () => this._hubAccept(conn));
        dc.on('data', (d) => handlers.data.forEach((fn) => fn(d)));
        dc.on('close', () => handlers.close.forEach((fn) => fn()));
        dc.on('error', () => handlers.close.forEach((fn) => fn()));
      });
      peer.on('disconnected', () => { if (!peer.destroyed) setTimeout(() => { try { peer.reconnect(); } catch (e) { /* */ } }, 1500); });
      peer.on('error', (err) => {
        if (!opened) { try { peer.destroy(); } catch (e) { /* */ } resolve(null); }   // id taken -> someone else is hub
        else if (err.type === 'network' || err.type === 'server-error') { /* keep going; reconnect handles it */ }
      });
      setTimeout(() => { if (!opened) { try { peer.destroy(); } catch (e) { /* */ } resolve(null); } }, 12000);
    });
  }

  async _tryMemberPeer() {
    const Peer = await loadPeerJS();
    this._nonceM = uid(16);
    return new Promise((resolve) => {
      let resolveEnded;
      const ended = new Promise((r) => { resolveEnded = r; });
      const peer = new Peer({ debug: 1, config: { iceServers: ICE_SERVERS } });
      this._teardown = () => { try { peer.destroy(); } catch (e) { /* */ } this._hubConn = null; };
      const fail = () => { resolveEnded(); };
      const t = setTimeout(fail, 15000);
      peer.on('open', () => {
        const dc = peer.connect(this.peerId, { reliable: true, metadata: { ...this.me, nonce: this._nonceM } });
        const handlers = { data: [], close: [] };
        const conn = {
          send: (m) => { try { if (dc.open) dc.send(m); } catch (e) { /* */ } },
          close: () => { try { dc.close(); } catch (e) { /* */ } },
          buffered: () => dc.dataChannel?.bufferedAmount || 0,
          onData: (fn) => handlers.data.push(fn),
          onClose: (fn) => handlers.close.push(fn),
        };
        dc.on('open', () => { clearTimeout(t); this._memberAttach(conn, resolveEnded); });
        dc.on('data', (d) => handlers.data.forEach((fn) => fn(d)));
        dc.on('close', () => handlers.close.forEach((fn) => fn()));
        dc.on('error', () => handlers.close.forEach((fn) => fn()));
      });
      peer.on('error', () => { clearTimeout(t); fail(); });
      resolve(ended);
    });
  }

  // Local backend: tabs of one browser (testing / rehearsal). Election uses the Web Locks API.
  async _tryHubLocal() {
    const name = 'clk-grp-' + this.groupId;
    return new Promise((resolve) => {
      navigator.locks.request(name, { ifAvailable: true }, async (lock) => {
        if (!lock) { resolve(null); return; }
        const bc = new BroadcastChannel(name);
        const conns = new Map();
        let resolveEnded;
        const ended = new Promise((r) => { resolveEnded = r; });
        bc.onmessage = (ev) => {
          const m = ev.data;
          if (!m || m.to !== 'hub') return;
          if (m.kind === 'open') {
            const handlers = { data: [], close: [] };
            const conn = {
              id: m.from,
              meta: m.meta,
              send: (p) => bc.postMessage({ to: m.from, from: 'hub', kind: 'data', payload: p }),
              close: () => { bc.postMessage({ to: m.from, from: 'hub', kind: 'close' }); conns.delete(m.from); },
              buffered: () => 0,
              onData: (fn) => handlers.data.push(fn),
              onClose: (fn) => handlers.close.push(fn),
              handlers,
            };
            conns.set(m.from, conn);
            bc.postMessage({ to: m.from, from: 'hub', kind: 'opened' });
            this._hubAccept(conn);
          } else if (m.kind === 'data') {
            conns.get(m.from)?.handlers.data.forEach((fn) => fn(m.payload));
          } else if (m.kind === 'close') {
            conns.get(m.from)?.handlers.close.forEach((fn) => fn());
            conns.delete(m.from);
          }
        };
        this._teardown = () => { bc.postMessage({ to: '*', kind: 'hub-down' }); bc.close(); this.members.clear(); resolveEnded(); };
        bc.postMessage({ to: '*', kind: 'hub-up' });
        this._set('online', 'hub');
        resolve(ended);
        await ended;      // hold the lock for as long as we are hub
      });
    });
  }

  async _tryMemberLocal() {
    const name = 'clk-grp-' + this.groupId;
    this._nonceM = uid(16);
    const cid = 'm-' + uid(8);
    const bc = new BroadcastChannel(name);
    let resolveEnded;
    const ended = new Promise((r) => { resolveEnded = r; });
    const handlers = { data: [], close: [] };
    const conn = {
      send: (p) => bc.postMessage({ to: 'hub', from: cid, kind: 'data', payload: p }),
      close: () => { bc.postMessage({ to: 'hub', from: cid, kind: 'close' }); },
      buffered: () => 0,
      onData: (fn) => handlers.data.push(fn),
      onClose: (fn) => handlers.close.push(fn),
    };
    bc.onmessage = (ev) => {
      const m = ev.data;
      if (!m) return;
      if (m.kind === 'hub-down') { handlers.close.forEach((fn) => fn()); return; }
      if (m.to !== cid) return;
      if (m.kind === 'opened') this._memberAttach(conn, resolveEnded);
      else if (m.kind === 'data') handlers.data.forEach((fn) => fn(m.payload));
      else if (m.kind === 'close') handlers.close.forEach((fn) => fn());
    };
    this._teardown = () => { try { conn.close(); bc.close(); } catch (e) { /* */ } this._hubConn = null; };
    bc.postMessage({ to: 'hub', from: cid, kind: 'open', meta: { ...this.me, nonce: this._nonceM } });
    setTimeout(() => { if (!this._hubConn) resolveEnded(); }, 4000);
    return ended;
  }
}

/* ----------------------------------------------------------- SyncManager --- */

class SyncManager extends EventTarget {
  constructor() {
    super();
    this.link = null;
    this.code = '';
    this.lite = false;
    this.roster = [];             // [{deviceId, name, lite, hub}]
    this.shows = new Map();       // key -> show info (+ seenAt)
    this.myShows = new Map();     // projectId -> info (announced by this tab)
    this.incoming = new Map();    // media id -> {meta, parts:[]}
    this.lastSyncAt = 0;
    this._onDb = (e) => this._localChange(e.detail);
  }

  get status() { return this.link ? this.link.status : 'off'; }
  get role() { return this.link?.role || null; }
  /** Other full devices currently in the group (excluding this one). */
  get otherDevices() { return this.roster.filter((d) => d.deviceId !== this.deviceId && !d.lite); }

  _update() { this.dispatchEvent(new Event('update')); }

  async init({ lite = false } = {}) {
    if (this._inited) return;
    this._inited = true;
    this.lite = lite;
    this.deviceId = await getDeviceId();
    this.deviceName = await getDeviceName();
    this.backend = new URLSearchParams(location.search).get('local') === '1' || /[?&]local=1/.test(location.hash) ? 'local' : 'peer';
    dbEvents.addEventListener('change', this._onDb);
    setInterval(() => this._tick(), 5000);
    const code = await getSetting('syncCode', '');
    if (code) this._connect(code);
    this._update();
  }

  async createGroup() { const code = newSyncCode(); await this.join(code); return code; }

  async join(code) {
    code = normalizeSyncCode(code);
    if (!code) throw new Error('bad code');
    await setSetting('syncCode', code);
    this._connect(code);
  }

  async leave() {
    this.link?.close();
    this.link = null;
    this.code = '';
    this.roster = [];
    this.shows.clear();
    await setSetting('syncCode', '');
    this._update();
  }

  async setDeviceName(name) {
    this.deviceName = String(name || '').trim().slice(0, 32) || this.deviceName;
    await setSetting('deviceName', this.deviceName);
    if (this.link) { this.link.me.name = this.deviceName; this._sendRoster?.(); }
    this._connect(this.code);     // reconnect so others see the new name
  }

  _connect(code) {
    this.link?.close();
    this.code = code;
    this.roster = [];
    if (!code) { this.link = null; this._update(); return; }
    this.link = new GroupLink({
      code,
      backend: this.backend,
      me: { deviceId: this.deviceId, name: this.deviceName, lite: this.lite },
      onMessage: (m, from) => this._onMessage(m, from),
      onMemberJoin: (id) => this._memberJoined(id),
      onMemberLeave: () => { this._sendRoster(); },
      onState: () => {
        if (this.link?.role === 'hub') this._sendRoster();
        if (this.link?.status !== 'online') this.roster = [];
        this._update();
      },
    });
    this._update();
  }

  /* ---------- roster (hub keeps it, members receive it) ---------- */
  _sendRoster() {
    if (this.link?.role !== 'hub') return;
    const list = [{ deviceId: this.deviceId, name: this.deviceName, lite: this.lite, hub: true }];
    for (const m of this.link.members.values()) if (m.authed) list.push({ deviceId: m.meta.deviceId, name: m.meta.name, lite: !!m.meta.lite });
    this.roster = list;
    this.link.send({ t: 'roster', list });
    this._update();
  }

  async _memberJoined(connId) {
    this._sendRoster();
    // tell the newcomer about every running show we know of
    this._pruneShows();
    for (const s of this.shows.values()) this.link.sendTo(connId, { t: 'show', info: s });
  }

  /* ---------- incoming messages ---------- */
  async _onMessage(m, from) {
    const isHub = this.link?.role === 'hub';
    const origin = 'sync:' + from;
    switch (m.t) {
      case '_welcomed':   // we just joined as a member
        if (!this.lite) this.link.send({ t: 'manifest', m: await this._manifest() });
        for (const s of this.myShows.values()) this.link.send({ t: 'show', info: s });
        break;
      case 'roster':
        this.roster = m.list;
        this._update();
        break;
      case 'manifest':
        if (isHub) await this._reconcile(m.m, from);
        break;
      case 'want':
        for (const id of m.projects || []) this._sendProject(id, from);
        for (const id of m.media || []) this._sendMedia(id, from);
        for (const k of m.settings || []) this._sendSetting(k, from);
        break;
      case 'project':
        if (!this.lite && await applyRemoteProject(m.p, origin)) this._synced();
        break;
      case 'tomb':
        if (!this.lite) for (const t of m.list) if (await applyRemoteTombstone(t, origin)) this._synced();
        break;
      case 'setting': {
        if (this.lite || !SYNCED_SETTINGS.includes(m.key)) break;
        const rec = await getSettingRecord(m.key);
        if (!rec || (rec.at || 0) < m.at) { await setSetting(m.key, m.value, { at: m.at, origin }); this._synced(); }
        break;
      }
      case 'media-begin':
        if (!this.lite) this.incoming.set(m.meta.id, { meta: m.meta, parts: [] });
        break;
      case 'media-chunk': {
        const inc = this.incoming.get(m.id);
        if (inc) inc.parts[m.i] = m.data;
        break;
      }
      case 'media-end': {
        const inc = this.incoming.get(m.id);
        this.incoming.delete(m.id);
        if (!inc) break;
        const { meta } = inc;
        const blob = new Blob(inc.parts, { type: meta.type });
        if (blob.size === meta.size && await applyRemoteMedia({ ...meta, blob }, origin)) this._synced();
        break;
      }
      case 'show':
        this.shows.set(m.info.key, { ...m.info, seenAt: Date.now() });
        if (isHub) this.link.send(m, from);           // relay to everyone else
        this._update();
        break;
      case 'show-end':
        this.shows.delete(m.key);
        if (isHub) this.link.send(m, from);
        this._update();
        break;
      default: break;
    }
  }

  _synced() { this.lastSyncAt = Date.now(); this._update(); }

  /* ---------- reconciliation (hub side, when a member connects) ---------- */
  async _manifest() {
    const projects = {};
    for (const p of await listProjects()) projects[p.id] = p.updatedAt;
    const media = (await listMedia()).map((x) => x.id);
    const tombs = await listTombstones();
    const settings = {};
    for (const k of SYNCED_SETTINGS) { const r = await getSettingRecord(k); if (r) settings[k] = r.at || 0; }
    return { projects, media, tombs, settings };
  }

  async _reconcile(M, from) {
    // 1) apply the member's deletions first
    for (const t of M.tombs || []) await applyRemoteTombstone(t, 'sync:' + from);
    const mine = await this._manifest();
    const theirTomb = Object.fromEntries((M.tombs || []).map((t) => [t.id, t.at]));
    const myTomb = Object.fromEntries(mine.tombs.map((t) => [t.id, t.at]));
    const want = { projects: [], media: [], settings: [] };
    // 2) projects
    for (const [id, at] of Object.entries(mine.projects)) {
      if (!(M.projects[id] >= at) && !(theirTomb[id] >= at)) this._sendProject(id, from);
    }
    for (const [id, at] of Object.entries(M.projects || {})) {
      if (!(mine.projects[id] >= at) && !(myTomb[id] >= at)) want.projects.push(id);
    }
    // 3) media
    const theirMedia = new Set(M.media || []);
    for (const id of mine.media) if (!theirMedia.has(id) && !theirTomb[id]) this._sendMedia(id, from);
    for (const id of theirMedia) if (!mine.media.includes(id) && !myTomb[id]) want.media.push(id);
    // 4) deletions they don't know about
    const missingTombs = mine.tombs.filter((t) => !(theirTomb[t.id] >= t.at));
    if (missingTombs.length) this.link.sendTo(from, { t: 'tomb', list: missingTombs });
    // 5) settings
    for (const k of SYNCED_SETTINGS) {
      const a = mine.settings[k] || 0;
      const b = M.settings?.[k] || 0;
      if (a > b) this._sendSetting(k, from);
      else if (b > a) want.settings.push(k);
    }
    if (want.projects.length || want.media.length || want.settings.length) this.link.sendTo(from, { t: 'want', ...want });
  }

  /* ---------- outgoing items ---------- */
  _target(to, msg) {
    if (!this.link || this.link.status !== 'online') return;
    if (to === '*') this.link.sendData(msg);
    else this.link.sendTo(to, msg);
  }

  async _sendProject(id, to = '*', except) {
    const p = await getProject(id);
    if (!p) return;
    if (to === '*' && except) this.link.sendData({ t: 'project', p }, except);
    else this._target(to, { t: 'project', p });
  }

  async _sendSetting(key, to = '*', except) {
    const r = await getSettingRecord(key);
    if (!r) return;
    const msg = { t: 'setting', key, value: r.value, at: r.at || 0 };
    if (to === '*' && except) this.link.sendData(msg, except);
    else this._target(to, msg);
  }

  async _sendMedia(id, to = '*', except) {
    const item = await getMedia(id);
    if (!item || !this.link) return;
    const targets = to === '*'
      ? (this.link.role === 'hub' ? [...this.link.members.keys()].filter((k) => k !== except && !this.link.isLite(k)) : ['hub'])
      : [to];
    const buf = await item.blob.arrayBuffer();
    const meta = { id: item.id, name: item.name, type: item.type, size: item.size, createdAt: item.createdAt };
    for (const target of targets) {
      this.link.sendTo(target, { t: 'media-begin', meta });
      for (let i = 0, n = 0; i < buf.byteLength; i += CHUNK, n++) {
        await this.link.drain(target);
        this.link.sendTo(target, { t: 'media-chunk', id: item.id, i: n, data: buf.slice(i, i + CHUNK) });
      }
      this.link.sendTo(target, { t: 'media-end', id: item.id });
    }
  }

  async _sendTomb(id, to = '*', except) {
    const t = await getTombstone(id);
    if (!t) return;
    if (to === '*' && except) this.link.sendData({ t: 'tomb', list: [t] }, except);
    else this._target(to, { t: 'tomb', list: [t] });
  }

  /** A local (or relayed) DB write happened — forward it to the group. */
  _localChange({ kind, id, origin }) {
    if (!this.link || this.link.status !== 'online' || this.lite) return;
    const isHub = this.link.role === 'hub';
    if (!isHub && origin !== 'local') return;                   // members only push their own edits
    const except = origin.startsWith('sync:') ? origin.slice(5) : undefined;   // hub: don't echo to the sender
    if (kind === 'project') this._sendProject(id, '*', except);
    else if (kind === 'media') this._sendMedia(id, '*', except);
    else if (kind === 'tomb') this._sendTomb(id, '*', except);
    else if (kind === 'setting' && SYNCED_SETTINGS.includes(id)) this._sendSetting(id, '*', except);
  }

  /* ---------- running shows ---------- */
  announceShow(info) {
    const full = { ...info, key: `${this.deviceId}:${info.projectId}`, deviceId: this.deviceId, deviceName: this.deviceName, at: Date.now() };
    this.myShows.set(info.projectId, full);
    this.shows.set(full.key, { ...full, seenAt: Date.now() });
    if (this.link?.status === 'online') this.link.send({ t: 'show', info: full });
    this._update();
  }

  endShow(projectId) {
    const s = this.myShows.get(projectId);
    if (!s) return;
    this.myShows.delete(projectId);
    this.shows.delete(s.key);
    if (this.link?.status === 'online') this.link.send({ t: 'show-end', key: s.key });
    this._update();
  }

  _pruneShows() {
    const now = Date.now();
    let changed = false;
    const mine = new Set([...this.myShows.values()].map((x) => x.key));
    for (const [k, s] of this.shows) if (!mine.has(k) && now - s.seenAt > SHOW_TTL) { this.shows.delete(k); changed = true; }
    return changed;
  }

  _tick() {
    // re-announce our shows (keeps them alive on other devices)
    if (this.link?.status === 'online') for (const s of this.myShows.values()) this.link.send({ t: 'show', info: { ...s, at: Date.now() } });
    if (this._pruneShows()) this._update();
  }

  /** Shows running anywhere in the group, newest first. */
  liveShows() {
    this._pruneShows();
    return [...this.shows.values()].sort((a, b) => b.at - a.at);
  }
}

export const sync = new SyncManager();
window.__sync = sync;   // handy for debugging from devtools
