'use strict';
// ---------------------------------------------------------------------------
// Online-Modus wie bei Make-It-Meme: Räume, Codes und Lobby laufen über
// Supabase Realtime (WebSocket über Port 443, klappt in praktisch jedem Netz).
// Das eigentliche Spiel läuft danach über eine direkte WebRTC-Verbindung
// zwischen Host und Mitspieler. Klappt die nicht (strenges WLAN, Mobilfunk),
// leitet Supabase die Daten mit geringerer Rate weiter.
// Der Schlüssel unten ist ein öffentlicher Browser-Schlüssel und darf im Code stehen.
// ---------------------------------------------------------------------------

const SUPA_URL = 'https://wpqrfrrhufnvdxcdqrcv.supabase.co';
const SUPA_KEY = 'sb_publishable_lvsuefwTpYIo55gci4xPlA_1miuYt9J';
const ROOM_PREFIX = 'ctf1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_HUMANS = 12;
const ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
const RTC_TIMEOUT = 7000;     // so lange versuchen wir die direkte Verbindung
const LOST_MS = 10000;        // ohne Lebenszeichen gilt eine Verbindung als weg

const rid = n => Array.from({ length: n }, () => 'abcdefghijkmnpqrstuvwxyz23456789'[(Math.random() * 32) | 0]).join('');

// Eine Verbindung Host <-> Mitspieler: erst direkt (WebRTC), sonst über Supabase
class Link {
  constructor(net, remote, clientLabel, initiator) {
    this.net = net; this.remote = remote; this.clientLabel = clientLabel;
    this.mode = 'pending'; this.dc = null; this.pc = null; this.relay = null; this.cands = [];
    this.lastSeen = performance.now(); this.lastRelaySend = 0; this.closed = false;
    let forceRelay = false;
    try { forceRelay = localStorage.getItem('ctf_force_relay') === '1'; } catch (e) { /* egal */ }
    if (typeof RTCPeerConnection === 'undefined' || forceRelay) {
      if (initiator) setTimeout(() => this.fallback(), 300);
      return;
    }
    const pc = this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.onicecandidate = e => { if (e.candidate) this.signal({ c: e.candidate.toJSON() }); };
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' && initiator) this.fallback(); };
    if (initiator) {
      this.setupDC(pc.createDataChannel('spiel', { ordered: true }));
      pc.createOffer().then(o => pc.setLocalDescription(o)).then(() => this.signal({ sdp: pc.localDescription })).catch(() => this.fallback());
      this.timer = setTimeout(() => { if (this.mode !== 'rtc') this.fallback(); }, RTC_TIMEOUT);
    } else {
      pc.ondatachannel = e => this.setupDC(e.channel);
    }
  }
  signal(data) { this.net.roomSend({ t: 'sig', to: this.remote, from: this.net.label, ...data }); }
  async onSignal(m) {
    const pc = this.pc; if (!pc || this.closed) return;
    try {
      if (m.sdp) {
        await pc.setRemoteDescription(m.sdp);
        if (m.sdp.type === 'offer') { const a = await pc.createAnswer(); await pc.setLocalDescription(a); this.signal({ sdp: pc.localDescription }); }
        for (const c of this.cands.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      } else if (m.c) {
        if (pc.remoteDescription) await pc.addIceCandidate(m.c).catch(() => {});
        else this.cands.push(m.c);
      }
    } catch (e) { /* Signalfehler: der Host fällt nach Ablauf auf Supabase zurück */ }
  }
  setupDC(dc) {
    this.dc = dc;
    dc.onopen = () => { if (this.mode === 'relay') return; this.mode = 'rtc'; clearTimeout(this.timer); this.net.linkChanged(this); };
    dc.onmessage = e => { let d; try { d = JSON.parse(e.data); } catch (x) { return; } this.net.onLinkMsg(this, d); };
    dc.onclose = () => { if (this.mode === 'rtc' && !this.closed) { this.mode = 'pending'; this.fallback(); } };
  }
  // Direkt geht nicht -> über einen eigenen Supabase-Kanal weiterleiten
  fallback() {
    if (this.closed || this.mode === 'relay') return;
    if (this.mode === 'rtc' && this.dc && this.dc.readyState === 'open') return;
    this.useRelay();
    if (this.net.role === 'host') this.net.roomSend({ t: 'relay', to: this.remote });
  }
  useRelay() {
    if (this.closed || this.relay) return;
    clearTimeout(this.timer);
    try { if (this.pc) this.pc.close(); } catch (e) { /* egal */ }
    this.mode = 'relay';
    const ch = this.relay = this.net.sb.channel(ROOM_PREFIX + this.net.code + '-r-' + this.clientLabel, { config: { broadcast: { self: false } } });
    ch.on('broadcast', { event: 'g' }, ({ payload }) => this.net.onLinkMsg(this, payload));
    ch.subscribe();
    this.net.linkChanged(this);
  }
  send(msg) {
    if (this.mode === 'rtc' && this.dc && this.dc.readyState === 'open') {
      try { this.dc.send(JSON.stringify(msg)); } catch (e) { /* egal */ }
    } else if (this.mode === 'relay' && this.relay) {
      try { const p = this.relay.send({ type: 'broadcast', event: 'g', payload: msg }); if (p && p.catch) p.catch(() => {}); } catch (e) { /* egal */ }
    }
  }
  close() {
    this.closed = true; clearTimeout(this.timer);
    try { if (this.dc) this.dc.close(); } catch (e) { /* egal */ }
    try { if (this.pc) this.pc.close(); } catch (e) { /* egal */ }
    if (this.relay) { try { this.net.sb.removeChannel(this.relay); } catch (e) { /* egal */ } }
  }
}

const Net = {
  sb: null, room: null, role: null, code: null, myId: null, label: null, hostLabel: null,
  links: new Map(),   // Host: pid -> Link, Client: 'host' -> Link
  players: [], settings: null, inGame: false, hbTimer: 0, lastHost: 0, sendGate: 0, snapCount: 0,
  onLobby: null, onStart: null, onSnapshot: null, onPong: null, onInput: null, onDrop: null, onError: null, onToLobby: null,

  available() { return !!(window.supabase && window.supabase.createClient); },
  get active() { return !!this.role; },
  randomCode() { let s = ''; for (let i = 0; i < 5; i++) s += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0]; return s; },
  meInfo(pid) { return { pid, driver: save.driver, car: save.car, upgrades: save.up[save.car] || {}, team: 0, link: 'host' }; },
  client() {
    if (!this.sb) this.sb = window.supabase.createClient(SUPA_URL, SUPA_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 40 } },
    });
    return this.sb;
  },

  // Raum-Kanal betreten. Liefert die Liste der Anwesenden (Presence).
  openRoom(code, role) {
    return new Promise((resolve, reject) => {
      const sb = this.client();
      const ch = this.room = sb.channel(ROOM_PREFIX + code, { config: { broadcast: { self: false }, presence: { key: this.label } } });
      let done = false;
      const fail = msg => { if (done) return; done = true; reject(msg); };
      ch.on('broadcast', { event: 'm' }, ({ payload }) => this.onRoomMsg(payload));
      ch.on('presence', { event: 'leave' }, ({ key }) => this.onPresenceLeave(key));
      const timer = setTimeout(() => fail('Der Spielserver ist nicht erreichbar. Prüf deine Internetverbindung, schalte VPN oder Werbeblocker aus oder probier ein anderes Netz.'), 12000);
      ch.subscribe(async status => {
        if (status === 'SUBSCRIBED') {
          try { await ch.track({ role, at: Date.now() }); } catch (e) { clearTimeout(timer); fail('Der Spielserver hat die Anmeldung abgelehnt.'); return; }
          setTimeout(() => { if (done) return; done = true; clearTimeout(timer); resolve(ch.presenceState() || {}); }, 1500);
        } else if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && !done) { clearTimeout(timer); fail('Der Spielserver ist nicht erreichbar.'); }
      });
    });
  },
  roomSend(msg) {
    if (!this.room) return;
    try { const p = this.room.send({ type: 'broadcast', event: 'm', payload: msg }); if (p && p.catch) p.catch(() => {}); } catch (e) { /* egal */ }
  },
  hostIn(presence) {
    for (const [k, metas] of Object.entries(presence)) if (k !== this.label && metas.some(m => m.role === 'host')) return k;
    return null;
  },

  // ---------------- Host ----------------
  async host(onReady, tries = 0) {
    if (!this.available()) { this.fail('Die Verbindungsbibliothek konnte nicht geladen werden.'); return; }
    this.leave();
    this.role = 'host'; this.label = rid(10); this.myId = 'host';
    this.code = this.randomCode();
    let pres;
    try { pres = await this.openRoom(this.code, 'host'); } catch (msg) { this.fail(msg); return; }
    if (this.role !== 'host') return;
    if (this.hostIn(pres)) { if (tries < 4) { this.host(onReady, tries + 1); return; } this.fail('Kein freier Raumcode gefunden.'); return; }
    const S = save.settings;
    this.settings = { map: S.map, size: S.size, diff: S.diff, caps: S.caps, time: S.time };
    this.players = [this.meInfo('host')];
    this.startHeartbeat();
    this.lobbyChanged();
    if (onReady) onReady(this.code);
  },
  hostRoomMsg(d) {
    const pid = d.from;
    if (typeof pid !== 'string') return;
    switch (d.t) {
      case 'hello': {
        if (this.inGame) { this.roomSend({ t: 'full', to: pid, reason: 'Das Match läuft gerade – versuch es nach der Runde nochmal.' }); return; }
        if (this.players.length >= MAX_HUMANS) { this.roomSend({ t: 'full', to: pid, reason: 'Der Raum ist voll (max. 12 Spieler).' }); return; }
        if (this.players.some(p => p.pid === pid)) { this.lobbyChanged(); return; }
        let driver = DRIVERS.some(x => x.id === d.driver) ? d.driver : DRIVERS[0].id;
        if (this.players.some(p => p.driver === driver)) {
          const free = DRIVERS.find(x => !this.players.some(p => p.driver === x.id));
          if (free) driver = free.id;
        }
        const car = CARS.some(c => c.id === d.car) ? d.car : 'flitzer';
        const up = {};
        for (const u of UPGRADES) up[u.id] = clamp(Math.round(+((d.upgrades || {})[u.id]) || 0), 0, MAX_LVL);
        const red = this.players.filter(p => p.team === 0).length, blue = this.players.length - red;
        this.players.push({ pid, driver, car, upgrades: up, team: red <= blue ? 0 : 1, link: 'pending' });
        this.links.set(pid, new Link(this, pid, pid, true));
        this.lobbyChanged();
        break;
      }
      case 'team': { const p = this.players.find(q => q.pid === pid); if (p && !this.inGame) { p.team = d.team ? 1 : 0; this.lobbyChanged(); } break; }
      case 'bye': this.dropPeer(pid); break;
    }
  },
  dropPeer(pid) {
    const l = this.links.get(pid);
    if (l) { l.close(); this.links.delete(pid); }
    const had = this.players.some(p => p.pid === pid);
    this.players = this.players.filter(p => p.pid !== pid);
    if (had && this.inGame && this.onDrop) this.onDrop(pid);
    if (had) this.lobbyChanged();
  },
  setTeam(pid, team) {
    if (this.role === 'host') { const p = this.players.find(q => q.pid === pid); if (p) { p.team = team; this.lobbyChanged(); } }
    else this.roomSend({ t: 'team', from: this.label, team });
  },
  setSetting(k, v) { if (this.role !== 'host') return; this.settings[k] = v; this.lobbyChanged(); },
  lobbyChanged() {
    if (this.role === 'host') this.roomSend({ t: 'lobby', host: this.label, players: this.players, settings: this.settings, code: this.code });
    if (this.onLobby) this.onLobby();
  },
  linkChanged(link) {
    if (this.role === 'host') {
      const p = this.players.find(q => q.pid === link.remote);
      if (p) { p.link = link.mode; this.lobbyChanged(); }
    } else if (this.onLobby) this.onLobby();
  },
  // Spielzustand an alle. Über Supabase nur mit verringerter Rate (Gratis-Limit 100 Nachrichten/s).
  broadcast(msg) {
    const relayed = [...this.links.values()].filter(l => l.mode === 'relay').length;
    const every = Math.max(2, Math.ceil(relayed * 1.2));
    this.snapCount++;
    for (const l of this.links.values()) {
      if (l.mode === 'rtc') l.send(msg);
      else if (l.mode === 'relay' && (msg.t !== 's' || this.snapCount % every === 0)) {
        // Ereignisse aus ausgelassenen Zuständen nicht verlieren
        const m = msg.t === 's' && l.pendingEv && l.pendingEv.length ? { ...msg, ev: l.pendingEv.concat(msg.ev) } : msg;
        l.send(m); l.pendingEv = [];
      } else if (l.mode === 'relay' && msg.t === 's') {
        l.pendingEv = (l.pendingEv || []).concat(msg.ev.filter(e => e[0] !== 's')).slice(-60);
      }
    }
  },
  startMatch() {
    const S = this.settings;
    const humans = this.players.map(p => ({ key: p.pid, driver: p.driver, car: p.car, upgrades: p.upgrades, team: p.team, human: true }));
    const opts = { mapId: S.map, teamSize: S.size, difficulty: S.diff, capLimit: S.caps, timeLimit: S.time };
    opts.roster = Game.buildRoster(opts, humans);
    this.inGame = true;
    this.roomSend({ t: 'start', opts });
    return { ...opts, mode: 'host', me: 'host' };
  },
  backToLobby() { this.inGame = false; this.roomSend({ t: 'toLobby' }); this.lobbyChanged(); },

  // ---------------- Mitspieler ----------------
  async join(code, onOk) {
    if (!this.available()) { this.fail('Die Verbindungsbibliothek konnte nicht geladen werden.'); return; }
    this.leave();
    this.role = 'client'; this.label = rid(10); this.myId = this.label;
    this.code = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    let pres;
    try { pres = await this.openRoom(this.code, 'client'); } catch (msg) { this.fail(msg); return; }
    if (this.role !== 'client') return;
    // kurz auf den Host warten
    let host = this.hostIn(pres);
    for (let i = 0; i < 12 && !host && this.room; i++) { await new Promise(r => setTimeout(r, 500)); host = this.hostIn(this.room.presenceState() || {}); }
    if (this.role !== 'client') return;
    if (!host) { this.fail('Kein Spiel mit dem Code „' + this.code + '“ gefunden. Prüf den Code und ob der Host die Seite noch offen hat.'); return; }
    this.hostLabel = host; this.lastHost = performance.now();
    this.links.set('host', new Link(this, host, this.label, false));
    const me = this.meInfo(this.label);
    this.roomSend({ t: 'hello', from: this.label, driver: me.driver, car: me.car, upgrades: me.upgrades });
    this.startHeartbeat();
    if (onOk) onOk();
  },
  clientRoomMsg(d) {
    if (d.to && d.to !== this.label) return;
    if (d.t === 'lobby' || d.t === 'start' || d.t === 'toLobby') this.lastHost = performance.now();
    switch (d.t) {
      case 'lobby': this.players = d.players; this.settings = d.settings; if (d.host) this.hostLabel = d.host; if (this.onLobby) this.onLobby(); break;
      case 'start': this.inGame = true; if (this.onStart) this.onStart({ ...d.opts, mode: 'client', me: this.label }); break;
      case 'toLobby': this.inGame = false; if (this.onToLobby) this.onToLobby(); break;
      case 'relay': { const l = this.links.get('host'); if (l) l.useRelay(); break; }
      case 'full': this.fail(d.reason); break;
    }
  },
  // Inputs über Supabase nur ~10x pro Sekunde
  send(msg) {
    const l = this.links.get('host'); if (!l) return;
    if (l.mode === 'relay' && msg.t === 'in') {
      const now = performance.now();
      if (now - this.sendGate < 100) return;
      this.sendGate = now;
    }
    l.send(msg);
  },
  get linkMode() { const l = this.links.get('host'); return l ? l.mode : null; },

  // ---------------- Nachrichten ----------------
  onRoomMsg(d) {
    if (!d || typeof d !== 'object') return;
    if (d.t === 'sig') {
      if (d.to !== this.label) return;
      const l = this.role === 'host' ? this.links.get(d.from) : this.links.get('host');
      if (l) l.onSignal(d);
      return;
    }
    if (this.role === 'host') this.hostRoomMsg(d); else if (this.role === 'client') this.clientRoomMsg(d);
  },
  onLinkMsg(link, d) {
    if (!d || typeof d !== 'object') return;
    link.lastSeen = performance.now();
    if (this.role === 'host') {
      if (d.t === 'in') { if (this.onInput) this.onInput(link.remote, d); }
      else if (d.t === 'ping') link.send({ t: 'pong', ts: d.ts });
    } else {
      this.lastHost = performance.now();
      if (d.t === 's') { if (this.onSnapshot) this.onSnapshot(d); }
      else if (d.t === 'pong') { if (this.onPong) this.onPong(d.ts); }
    }
  },
  onPresenceLeave(key) {
    if (this.role === 'host') { if (this.players.some(p => p.pid === key)) this.dropPeer(key); }
    else if (this.role === 'client' && key === this.hostLabel) {
      // kurz warten – manchmal ist es nur ein Verbindungswackler
      setTimeout(() => {
        if (this.role !== 'client' || !this.room) return;
        if (!this.hostIn(this.room.presenceState() || {})) this.fail('Der Host hat das Spiel verlassen.');
      }, 4000);
    }
  },
  startHeartbeat() {
    clearInterval(this.hbTimer);
    this.hbTimer = setInterval(() => {
      const now = performance.now();
      if (this.role === 'host') {
        for (const l of this.links.values()) if (l.mode === 'rtc') l.send({ t: 'hb' });
        if (this.inGame) for (const [pid, l] of [...this.links]) if (l.mode !== 'pending' && now - l.lastSeen > LOST_MS) this.dropPeer(pid);
      } else if (this.role === 'client') {
        const l = this.links.get('host');
        if (l && l.mode === 'rtc') l.send({ t: 'hb' });
        if (this.inGame && now - this.lastHost > LOST_MS) this.fail('Der Host antwortet nicht mehr.');
      }
    }, 2000);
  },

  // ---------------- Allgemein ----------------
  fail(msg) {
    const had = this.role;
    this.leave();
    if (had && this.onError) this.onError(msg);
  },
  leave() {
    clearInterval(this.hbTimer);
    if (this.room) {
      if (this.role === 'client') this.roomSend({ t: 'bye', from: this.label });
      const r = this.room;
      try { r.untrack(); } catch (e) { /* egal */ }
      setTimeout(() => { try { this.sb.removeChannel(r); } catch (e) { /* egal */ } }, 200);
    }
    for (const l of this.links.values()) l.close();
    this.links = new Map(); this.room = null; this.role = null; this.code = null; this.players = []; this.inGame = false;
    this.hostLabel = null; this.lastHost = 0; this.snapCount = 0;
  },
};
