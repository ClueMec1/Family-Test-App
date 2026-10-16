// Transport layer: one API, two backends.
//   'peer'  -> WebRTC DataChannels via PeerJS (public broker for signaling, Google STUN, no TURN)
//   'local' -> BroadcastChannel between tabs of the same browser (offline rehearsal / testing)
//
// Hub (host side):    const hub = await openHub({pin, backend, onConnection, onStatus})
// Client side:        const link = new ClientLink({pin, backend, meta, onMessage, onStatus})
//
// A "connection" object (hub side) exposes:
//   id, meta, send(obj), close(), on('data'|'close', fn)

import { ICE_SERVERS, hostPeerId, uid, HEARTBEAT_MS, STALE_MS, T } from './protocol.js';

const PEERJS_URL = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';
let peerjsPromise = null;

export function loadPeerJS() {
  if (window.Peer) return Promise.resolve(window.Peer);
  if (!peerjsPromise) {
    peerjsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PEERJS_URL;
      s.crossOrigin = 'anonymous';
      s.onload = () => (window.Peer ? resolve(window.Peer) : reject(new Error('PeerJS failed to load')));
      s.onerror = () => { peerjsPromise = null; reject(new Error('PeerJS failed to load (offline?)')); };
      document.head.appendChild(s);
    });
  }
  return peerjsPromise;
}

const peerOptions = () => ({ debug: 1, config: { iceServers: ICE_SERVERS } });

class Emitter {
  constructor() { this._h = {}; }
  on(ev, fn) { (this._h[ev] ||= []).push(fn); return this; }
  emit(ev, ...a) { (this._h[ev] || []).forEach((fn) => { try { fn(...a); } catch (e) { console.error(e); } }); }
}

/* ----------------------------------------------------------------- HUB --- */

export async function openHub({ pin, backend = 'peer', onConnection, onStatus = () => {} }) {
  return backend === 'local'
    ? openLocalHub({ pin, onConnection, onStatus })
    : openPeerHub({ pin, onConnection, onStatus });
}

async function openPeerHub({ pin, onConnection, onStatus }) {
  const Peer = await loadPeerJS();
  return new Promise((resolve, reject) => {
    const peer = new Peer(hostPeerId(pin), peerOptions());
    let opened = false;
    let destroyed = false;

    peer.on('open', () => {
      onStatus('online');
      if (!opened) {
        opened = true;
        resolve({
          backend: 'peer',
          close() { destroyed = true; peer.destroy(); },
        });
      }
    });
    peer.on('connection', (dc) => {
      const conn = new Emitter();
      conn.id = dc.peer + ':' + dc.connectionId;
      conn.meta = dc.metadata || {};
      conn.send = (obj) => { try { if (dc.open) dc.send(obj); } catch (e) { /* ignore */ } };
      conn.close = () => { try { dc.close(); } catch (e) { /* ignore */ } };
      dc.on('open', () => onConnection(conn));
      dc.on('data', (d) => conn.emit('data', d));
      dc.on('close', () => conn.emit('close'));
      dc.on('error', () => conn.emit('close'));
    });
    peer.on('disconnected', () => {
      // Lost the signaling broker. Existing DataChannels keep working; reconnect for new joiners.
      if (destroyed) return;
      onStatus('reconnecting');
      setTimeout(() => { if (!destroyed && !peer.destroyed) try { peer.reconnect(); } catch (e) { /* ignore */ } }, 1500);
    });
    peer.on('error', (err) => {
      console.warn('[hub] peer error', err.type, err);
      if (!opened) {
        peer.destroy();
        const e = new Error(err.type || 'peer-error');
        e.code = err.type;
        reject(e);
      } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
        onStatus('reconnecting');
      }
    });
  });
}

function openLocalHub({ pin, onConnection, onStatus }) {
  const bc = new BroadcastChannel('clicker-local-' + pin);
  const conns = new Map();
  bc.onmessage = (ev) => {
    const m = ev.data;
    if (!m || m.to !== 'hub') return;
    if (m.kind === 'hello') {
      if (conns.has(m.from)) conns.get(m.from).emit('close');
      const conn = new Emitter();
      conn.id = m.from;
      conn.meta = m.meta || {};
      conn.send = (obj) => bc.postMessage({ to: m.from, from: 'hub', kind: 'data', payload: obj });
      conn.close = () => { bc.postMessage({ to: m.from, from: 'hub', kind: 'bye' }); conns.delete(m.from); };
      conns.set(m.from, conn);
      bc.postMessage({ to: m.from, from: 'hub', kind: 'ack' });
      onConnection(conn);
    } else if (m.kind === 'data') {
      const c = conns.get(m.from);
      if (c) c.emit('data', m.payload);
      else bc.postMessage({ to: m.from, from: 'hub', kind: 'bye' });   // stale client from a previous hub

    } else if (m.kind === 'bye') {
      conns.get(m.from)?.emit('close');
      conns.delete(m.from);
    }
  };
  // Tell clients that may have been waiting for us to (re)announce themselves.
  bc.postMessage({ to: '*', from: 'hub', kind: 'hub-up' });
  onStatus('online');
  return Promise.resolve({ backend: 'local', close() { bc.postMessage({ to: '*', from: 'hub', kind: 'hub-down' }); bc.close(); } });
}

/* -------------------------------------------------------------- CLIENT --- */

/**
 * Auto-reconnecting client link with heartbeat.
 * status values: 'connecting' | 'online' | 'nohost' | 'offline'
 */
export class ClientLink {
  constructor({ pin, backend = 'peer', meta = {}, onMessage = () => {}, onStatus = () => {}, onOpen = () => {} }) {
    Object.assign(this, { pin, backend, meta, onMessage, onStatus, onOpen });
    this.status = 'idle';
    this.closed = false;
    this.retry = 0;
    this.lastRx = 0;
    this.queue = [];
    this._hb = setInterval(() => this._heartbeat(), HEARTBEAT_MS);
    this._visibility = () => { if (document.visibilityState === 'visible' && this.status !== 'online') this.reconnectNow(); };
    document.addEventListener('visibilitychange', this._visibility);
    window.addEventListener('online', this._visibility);
    this._connect();
  }

  _setStatus(s) { if (this.status !== s) { this.status = s; this.onStatus(s); } }

  send(obj) {
    if (this.status === 'online' && this._send) this._send(obj);
    else if (obj.t !== T.PING) this.queue.push(obj);
  }

  _gotData(d) {
    this.lastRx = Date.now();
    if (d && d.t === T.PONG) return;
    this.onMessage(d);
  }

  _opened() {
    this.retry = 0;
    this.lastRx = Date.now();
    this._setStatus('online');
    this.onOpen();
    const q = this.queue; this.queue = [];
    q.forEach((m) => this._send(m));
  }

  _heartbeat() {
    if (this.closed) return;
    if (this.status === 'online') {
      this._send?.({ t: T.PING });
      if (Date.now() - this.lastRx > STALE_MS) this._drop('stale');
    }
  }

  _drop(why) {
    if (this.closed) return;
    console.info('[link] drop:', why);
    this._teardown?.();
    this._teardown = null;
    this._send = null;
    if (this.status === 'online') this._setStatus('connecting');
    clearTimeout(this._retryTimer);
    const delay = Math.min(8000, 600 * 2 ** this.retry++);
    this._retryTimer = setTimeout(() => this._connect(), delay);
  }

  reconnectNow() {
    if (this.closed) return;
    clearTimeout(this._retryTimer);
    this.retry = 0;
    this._teardown?.();
    this._teardown = null;
    this._connect();
  }

  close() {
    this.closed = true;
    clearInterval(this._hb);
    clearTimeout(this._retryTimer);
    document.removeEventListener('visibilitychange', this._visibility);
    window.removeEventListener('online', this._visibility);
    this._teardown?.();
  }

  _connect() {
    if (this.closed) return;
    if (this.status !== 'nohost') this._setStatus('connecting');
    if (this.backend === 'local') this._connectLocal();
    else this._connectPeer().catch((e) => { this._setStatus('offline'); this._drop(e.message); });
  }

  _connectLocal() {
    const cid = 'c-' + uid(8);
    const bc = new BroadcastChannel('clicker-local-' + this.pin);
    let acked = false;
    const helloTimer = setTimeout(() => { if (!acked) { this._setStatus('nohost'); } }, 1500);
    bc.onmessage = (ev) => {
      const m = ev.data;
      if (!m) return;
      if (m.kind === 'hub-up') {            // host tab (re)started
        if (acked) this.reconnectNow();
        else bc.postMessage({ to: 'hub', from: cid, kind: 'hello', meta: this.meta });
        return;
      }
      if (m.kind === 'hub-down') { this._drop('hub-down'); return; }
      if (m.to !== cid) return;
      if (m.kind === 'ack') { acked = true; clearTimeout(helloTimer); this._opened(); }
      else if (m.kind === 'data') this._gotData(m.payload);
      else if (m.kind === 'bye') this._drop('bye');
    };
    this._send = (obj) => bc.postMessage({ to: 'hub', from: cid, kind: 'data', payload: obj });
    this._teardown = () => { clearTimeout(helloTimer); try { bc.postMessage({ to: 'hub', from: cid, kind: 'bye' }); bc.close(); } catch (e) { /* closed */ } };
    bc.postMessage({ to: 'hub', from: cid, kind: 'hello', meta: this.meta });
  }

  async _connectPeer() {
    const Peer = await loadPeerJS();
    if (this.closed) return;
    const peer = new Peer(peerOptions());
    let dc = null;
    let done = false;
    const fail = (why) => { if (done) return; done = true; this._drop(why); };
    this._teardown = () => { done = true; try { dc?.close(); } catch (e) { /* */ } try { peer.destroy(); } catch (e) { /* */ } };

    const openTimeout = setTimeout(() => { if (this.status !== 'online') fail('open-timeout'); }, 15000);
    peer.on('open', () => {
      dc = peer.connect(hostPeerId(this.pin), { reliable: true, serialization: 'json', metadata: this.meta });
      dc.on('open', () => {
        clearTimeout(openTimeout);
        this._send = (obj) => { try { dc.open && dc.send(obj); } catch (e) { /* */ } };
        this._opened();
      });
      dc.on('data', (d) => this._gotData(d));
      dc.on('close', () => fail('dc-close'));
      dc.on('error', () => fail('dc-error'));
    });
    peer.on('error', (err) => {
      clearTimeout(openTimeout);
      if (err.type === 'peer-unavailable') this._setStatus('nohost');
      fail(err.type);
    });
    peer.on('disconnected', () => { /* signaling gone; DataChannel may still work */ });
  }
}
