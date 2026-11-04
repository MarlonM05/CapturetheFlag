'use strict';
// ---------------------------------------------------------------------------
// Online-Modus über WebRTC (PeerJS). Kein eigener Server nötig:
// Der Host simuliert das Spiel und schickt 20x pro Sekunde den Zustand an alle,
// die Mitspieler schicken nur ihre Eingaben.
// ---------------------------------------------------------------------------

const ROOM_PREFIX = 'schussental-showdown-v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_HUMANS = 12;

const Net = {
  peer: null, role: null, code: null, myId: null,
  conns: new Map(),      // Host: pid -> Verbindung
  hostConn: null,        // Client: Verbindung zum Host
  players: [], settings: null, inGame: false,
  lastSeen: new Map(), lastHost: 0, hbTimer: 0,
  // Rückrufe (setzt die UI)
  onLobby: null, onStart: null, onSnapshot: null, onPong: null, onInput: null, onDrop: null, onError: null, onToLobby: null,

  available() { return typeof Peer !== 'undefined'; },
  randomCode() { let s = ''; for (let i = 0; i < 5; i++) s += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0]; return s; },
  meInfo(pid) {
    return { pid, driver: save.driver, car: save.car, upgrades: save.up[save.car] || {}, team: 0 };
  },

  // ---------------- Host ----------------
  host(onReady, tries = 0) {
    this.leave();
    this.role = 'host';
    const code = this.randomCode();
    const peer = this.peer = new Peer(ROOM_PREFIX + code, { debug: 1 });
    peer.on('open', () => {
      this.code = code; this.myId = 'host';
      const S = save.settings;
      this.settings = { map: S.map, size: S.size, diff: S.diff, caps: S.caps, time: S.time };
      this.players = [this.meInfo('host')];
      this.startHeartbeat();
      this.lobbyChanged();
      if (onReady) onReady(code);
    });
    peer.on('connection', conn => this.accept(conn));
    peer.on('disconnected', () => { try { if (!peer.destroyed) peer.reconnect(); } catch (e) { /* egal */ } });
    peer.on('error', e => {
      if (e.type === 'unavailable-id' && tries < 4) { this.host(onReady, tries + 1); return; }
      this.fail(this.errText(e));
    });
  },
  accept(conn) {
    conn.on('data', d => this.hostData(conn, d));
    conn.on('close', () => this.hostClose(conn));
    conn.on('error', () => this.hostClose(conn));
  },
  hostData(conn, d) {
    if (!d || typeof d !== 'object') return;
    const pid = conn.peer;
    this.lastSeen.set(pid, performance.now());
    switch (d.t) {
      case 'hello': {
        if (this.inGame) { conn.send({ t: 'full', reason: 'Das Match läuft gerade – versuch es nach der Runde nochmal.' }); setTimeout(() => conn.close(), 400); return; }
        if (this.players.length >= MAX_HUMANS) { conn.send({ t: 'full', reason: 'Der Raum ist voll (max. 12 Spieler).' }); setTimeout(() => conn.close(), 400); return; }
        if (this.players.some(p => p.pid === pid)) return;
        let driver = DRIVERS.some(x => x.id === d.driver) ? d.driver : DRIVERS[0].id;
        if (this.players.some(p => p.driver === driver)) {
          const free = DRIVERS.find(x => !this.players.some(p => p.driver === x.id));
          if (free) driver = free.id;
        }
        const car = CARS.some(c => c.id === d.car) ? d.car : 'flitzer';
        const up = {};
        for (const u of UPGRADES) up[u.id] = clamp(Math.round(+((d.upgrades || {})[u.id]) || 0), 0, MAX_LVL);
        const red = this.players.filter(p => p.team === 0).length, blue = this.players.length - red;
        this.players.push({ pid, driver, car, upgrades: up, team: red <= blue ? 0 : 1 });
        this.conns.set(pid, conn);
        this.lobbyChanged();
        break;
      }
      case 'team': { const p = this.players.find(q => q.pid === pid); if (p && !this.inGame) { p.team = d.team ? 1 : 0; this.lobbyChanged(); } break; }
      case 'in': if (this.onInput) this.onInput(pid, d); break;
      case 'ping': if (conn.open) conn.send({ t: 'pong', ts: d.ts }); break;
    }
  },
  hostClose(conn) {
    const pid = conn.peer;
    if (!this.conns.has(pid)) return;
    this.conns.delete(pid); this.lastSeen.delete(pid);
    try { conn.close(); } catch (e) { /* egal */ }
    this.players = this.players.filter(p => p.pid !== pid);
    if (this.inGame && this.onDrop) this.onDrop(pid);
    this.lobbyChanged();
  },
  setTeam(pid, team) {
    if (this.role === 'host') {
      const p = this.players.find(q => q.pid === pid); if (p) { p.team = team; this.lobbyChanged(); }
    } else this.send({ t: 'team', team });
  },
  setSetting(k, v) { if (this.role !== 'host') return; this.settings[k] = v; this.lobbyChanged(); },
  lobbyChanged() {
    if (this.role === 'host') this.broadcast({ t: 'lobby', players: this.players, settings: this.settings, code: this.code });
    if (this.onLobby) this.onLobby();
  },
  broadcast(msg) {
    for (const c of this.conns.values()) if (c.open) { try { c.send(msg); } catch (e) { /* weiter */ } }
  },
  startMatch() {
    const S = this.settings;
    const humans = this.players.map(p => ({ key: p.pid, driver: p.driver, car: p.car, upgrades: p.upgrades, team: p.team, human: true }));
    const opts = { mapId: S.map, teamSize: S.size, difficulty: S.diff, capLimit: S.caps, timeLimit: S.time };
    opts.roster = Game.buildRoster(opts, humans);
    this.inGame = true;
    this.broadcast({ t: 'start', opts });
    return { ...opts, mode: 'host', me: 'host' };
  },
  backToLobby() {
    this.inGame = false;
    this.broadcast({ t: 'toLobby' });
    this.lobbyChanged();
  },

  // ---------------- Client ----------------
  join(code, onOk) {
    this.leave();
    this.role = 'client';
    this.code = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const peer = this.peer = new Peer({ debug: 1 });
    let opened = false;
    const timer = setTimeout(() => { if (!opened) this.fail('Raum nicht gefunden oder Verbindung blockiert. Code prüfen!'); }, 15000);
    peer.on('open', id => {
      this.myId = id;
      const conn = this.hostConn = peer.connect(ROOM_PREFIX + this.code, { reliable: true, serialization: 'json' });
      conn.on('open', () => {
        opened = true; clearTimeout(timer);
        this.lastHost = performance.now(); this.startHeartbeat();
        const me = this.meInfo(id);
        conn.send({ t: 'hello', driver: me.driver, car: me.car, upgrades: me.upgrades });
        if (onOk) onOk();
      });
      conn.on('data', d => this.clientData(d));
      conn.on('close', () => { if (this.role === 'client') this.fail('Die Verbindung zum Host wurde getrennt.'); });
      conn.on('error', () => { if (this.role === 'client') this.fail('Verbindungsfehler.'); });
    });
    peer.on('error', e => { clearTimeout(timer); this.fail(e.type === 'peer-unavailable' ? 'Raum „' + this.code + '“ nicht gefunden.' : this.errText(e)); });
  },
  clientData(d) {
    if (!d || typeof d !== 'object') return;
    this.lastHost = performance.now();
    switch (d.t) {
      case 'lobby': this.players = d.players; this.settings = d.settings; if (this.onLobby) this.onLobby(); break;
      case 'start': this.inGame = true; if (this.onStart) this.onStart({ ...d.opts, mode: 'client', me: this.myId }); break;
      case 's': if (this.onSnapshot) this.onSnapshot(d); break;
      case 'pong': if (this.onPong) this.onPong(d.ts); break;
      case 'toLobby': this.inGame = false; if (this.onToLobby) this.onToLobby(); break;
      case 'full': this.fail(d.reason); break;
    }
  },
  send(msg) { if (this.hostConn && this.hostConn.open) { try { this.hostConn.send(msg); } catch (e) { /* egal */ } } },

  // Verbindungen, die ohne „close“ verschwinden, nach 8 s aufräumen
  startHeartbeat() {
    clearInterval(this.hbTimer);
    this.hbTimer = setInterval(() => {
      const now = performance.now();
      if (this.role === 'host') {
        this.broadcast({ t: 'hb' });
        for (const [pid, conn] of [...this.conns]) {
          const seen = this.lastSeen.get(pid) || now;
          if (!this.lastSeen.has(pid)) this.lastSeen.set(pid, now);
          if (now - seen > 8000) this.hostClose(conn);
        }
      } else if (this.role === 'client') {
        this.send({ t: 'hb' });
        if (this.lastHost && now - this.lastHost > 8000) this.fail('Der Host antwortet nicht mehr.');
      }
    }, 1000);
  },

  // ---------------- Allgemein ----------------
  errText(e) {
    const m = {
      'browser-incompatible': 'Dein Browser unterstützt kein WebRTC.',
      network: 'Keine Verbindung zum Vermittlungsserver (Internet prüfen).',
      'server-error': 'Der Vermittlungsserver ist gerade nicht erreichbar.',
      'socket-error': 'Verbindung zum Vermittlungsserver fehlgeschlagen.',
      'peer-unavailable': 'Raum nicht gefunden.',
    };
    return m[e && e.type] || ('Netzwerkfehler: ' + (e && (e.type || e.message) || 'unbekannt'));
  },
  fail(msg) {
    const had = this.role;
    this.leave();
    if (had && this.onError) this.onError(msg);
  },
  leave() {
    const p = this.peer;
    clearInterval(this.hbTimer);
    this.role = null; this.peer = null; this.hostConn = null; this.conns = new Map(); this.players = []; this.inGame = false; this.code = null;
    this.lastSeen = new Map(); this.lastHost = 0;
    if (p) { try { p.destroy(); } catch (e) { /* egal */ } }
  },
  get active() { return !!this.role; },
};
