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
const LOST_MS = 12000;        // ohne Lebenszeichen gilt eine Verbindung als weg
// Supabase (Gratis): ~100 Nachrichten/s für alle zusammen -> Raten an die Zahl der Relay-Spieler anpassen
const relayDownHz = n => n <= 2 ? 10 : n <= 4 ? 7 : 5;
const relayUpHz = n => n <= 2 ? 9 : n <= 4 ? 6 : 4;

const rid = n => Array.from({ length: n }, () => 'abcdefghijkmnpqrstuvwxyz23456789'[(Math.random() * 32) | 0]).join('');

// Eine Verbindung Host <-> Mitspieler. Sie läuft sofort über Supabase (Relay) und wechselt
// automatisch auf die direkte WebRTC-Verbindung, sobald die steht (und zurück, falls sie abreißt).
// Relay: Mitspieler -> Host über einen eigenen Kanal je Spieler ("u-…"), Host -> alle Relay-Spieler
// über EINEN gemeinsamen Kanal ("d"), damit das Nachrichten-Limit von Supabase nicht überläuft.
class Link {
  constructor(net, remote, clientLabel, initiator) {
    this.net = net; this.remote = remote; this.clientLabel = clientLabel; this.initiator = initiator;
    this.mode = 'relay'; this.dc = null; this.fast = null; this.pc = null; this.cands = [];
    this.lastSeen = performance.now(); this.closed = false;
    // Relay-Kanal nach oben (Mitspieler -> Host) sofort öffnen
    const up = this.up = net.sb.channel(ROOM_PREFIX + net.code + '-u-' + clientLabel, { config: { broadcast: { self: false } } });
    if (net.role === 'host') up.on('broadcast', { event: 'g' }, ({ payload }) => this.net.onLinkMsg(this, payload));
    up.subscribe();
    if (net.role === 'client') net.ensureDown(true);
    let noRtc = false;
    try { noRtc = localStorage.getItem('ctf_force_relay') === '1'; } catch (e) { /* egal */ }
    if (typeof RTCPeerConnection === 'undefined' || noRtc) return;
    this.startRtc();
  }
  startRtc() {
    const pc = this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.onicecandidate = e => { if (e.candidate) this.signal({ c: e.candidate.toJSON() }); };
    if (this.initiator) {
      this.setupDC(pc.createDataChannel('spiel', { ordered: true }));
      // schneller Kanal: verlorene Pakete werden nicht nachgeschickt (kein Stau)
      this.setupFast(pc.createDataChannel('schnell', { ordered: false, maxRetransmits: 0 }));
      pc.createOffer().then(o => pc.setLocalDescription(o)).then(() => this.signal({ sdp: pc.localDescription })).catch(() => {});
    } else {
      pc.ondatachannel = e => { if (e.channel.label === 'schnell') this.setupFast(e.channel); else this.setupDC(e.channel); };
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
    } catch (e) { /* Signalfehler: es bleibt beim Relay */ }
  }
  setupDC(dc) {
    this.dc = dc;
    dc.onopen = () => { if (this.closed) return; this.lastRtc = performance.now(); this.mode = 'rtc'; this.net.linkChanged(this); };
    dc.onmessage = e => { let d; try { d = JSON.parse(e.data); } catch (x) { return; } this.rtcAlive(); this.net.onLinkMsg(this, d); };
    dc.onclose = () => { if (this.closed) return; if (this.mode === 'rtc') { this.mode = 'relay'; this.net.linkChanged(this); } };
  }
  setupFast(dc) {
    this.fast = dc;
    dc.onmessage = e => { let d; try { d = JSON.parse(e.data); } catch (x) { return; } this.rtcAlive(); this.net.onLinkMsg(this, d); };
  }
  // direkte Verbindung lebt (wieder): darauf umschalten
  rtcAlive() {
    this.lastRtc = performance.now();
    if (this.mode !== 'rtc' && !this.closed && this.dc && this.dc.readyState === 'open') { this.mode = 'rtc'; this.net.linkChanged(this); }
  }
  // offen, aber seit Sekunden stumm (NAT/WLAN-Wechsel): zurück aufs Relay
  checkRtc(now) {
    if (this.mode === 'rtc' && now - (this.lastRtc || now) > 5000) { this.mode = 'relay'; this.net.linkChanged(this); }
  }
  send(msg, fast) {
    if (this.mode === 'rtc' && this.dc && this.dc.readyState === 'open') {
      const ch = fast && this.fast && this.fast.readyState === 'open' ? this.fast : this.dc;
      // Stau vermeiden: volle Puffer beim schnellen Kanal überspringen
      if (fast && ch.bufferedAmount > 64000) return;
      try { ch.send(JSON.stringify(msg)); } catch (e) { /* egal */ }
      return;
    }
    if (this.net.role === 'host') { this.net.downSend({ ...msg, to: this.remote }); return; }
    try { const p = this.up.send({ type: 'broadcast', event: 'g', payload: msg }); if (p && p.catch) p.catch(() => {}); } catch (e) { /* egal */ }
  }
  close() {
    this.closed = true;
    try { if (this.dc) this.dc.close(); } catch (e) { /* egal */ }
    try { if (this.fast) this.fast.close(); } catch (e) { /* egal */ }
    try { if (this.pc) this.pc.close(); } catch (e) { /* egal */ }
    if (this.up) { try { this.net.sb.removeChannel(this.up); } catch (e) { /* egal */ } }
  }
}

const Net = {
  sb: null, room: null, role: null, code: null, myId: null, label: null, hostLabel: null,
  links: new Map(),   // Host: pid -> Link, Client: 'host' -> Link
  players: [], settings: null, inGame: false, hbTimer: 0, lastHost: 0, sendGate: 0, snapCount: 0, down: null, downEv: [], lastDown: 0, relayN: 0,
  onLobby: null, onStart: null, onSnapshot: null, onEvents: null, onPong: null, onInput: null, onDrop: null, onError: null, onToLobby: null,

  available() { return !!(window.supabase && window.supabase.createClient); },
  get active() { return !!this.role; },
  randomCode() { let s = ''; for (let i = 0; i < 5; i++) s += CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0]; return s; },
  meInfo(pid) { return { pid, name: myName(), driver: save.driver, car: save.car, upgrades: save.up[save.car] || {}, team: 0, link: 'host' }; },
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
  // gemeinsamer Relay-Kanal Host -> Mitspieler (Client hört nur zu, solange er nicht direkt verbunden ist)
  ensureDown(on) {
    if (on && !this.down && this.code) {
      const ch = this.down = this.sb.channel(ROOM_PREFIX + this.code + '-d', { config: { broadcast: { self: false } } });
      if (this.role === 'client') ch.on('broadcast', { event: 'g' }, ({ payload }) => {
        if (!payload || (payload.to && payload.to !== this.label)) return;
        const l = this.links.get('host'); if (l && l.mode !== 'rtc') this.onLinkMsg(l, payload);
      });
      ch.subscribe();
    } else if (!on && this.down) { const d = this.down; this.down = null; try { this.sb.removeChannel(d); } catch (e) { /* egal */ } }
  },
  downSend(msg) {
    if (!this.down) this.ensureDown(true);
    try { const p = this.down.send({ type: 'broadcast', event: 'g', payload: msg }); if (p && p.catch) p.catch(() => {}); } catch (e) { /* egal */ }
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
    this.settings = { map: S.map, size: S.size, diff: S.diff, caps: S.caps, time: S.time, bots: S.bots !== false };
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
        if (this.players.length >= MAX_HUMANS) { this.roomSend({ t: 'full', to: pid, reason: 'Der Raum ist voll (max. 12 Spieler).' }); return; }
        if (this.players.some(p => p.pid === pid)) { this.lobbyChanged(); return; }
        let driver = activeDrivers().some(x => x.id === d.driver) ? d.driver : '';
        if (driver && this.players.some(p => p.driver === driver)) driver = '';
        let name = cleanName(d.name) || 'Spieler';
        while (this.players.some(p => p.name === name)) name = name.slice(0, 13) + ' ' + (2 + ((Math.random() * 8) | 0));
        const car = CARS.some(c => c.id === d.car) ? d.car : 'flitzer';
        const up = {};
        for (const u of UPGRADES) up[u.id] = clamp(Math.round(+((d.upgrades || {})[u.id]) || 0), 0, MAX_LVL);
        const red = this.players.filter(p => p.team === 0).length, blue = this.players.length - red;
        const entry = { pid, name, driver, car, upgrades: up, team: red <= blue ? 0 : 1, link: 'relay' };
        if (this.inGame) {
          // mitten ins laufende Match: ersetzt einen Bot im Team mit weniger echten Spielern
          const roster = this.onLateJoin ? this.onLateJoin({ key: pid, name, driver, car, upgrades: up }) : null;
          if (!roster) { this.roomSend({ t: 'full', to: pid, reason: 'Das Match läuft gerade – versuch es nach der Runde nochmal.' }); return; }
          const mine = roster.find(r => r.key === pid); if (mine) entry.team = mine.team;
          this.players.push(entry);
          this.links.set(pid, new Link(this, pid, pid, true));
          this.lobbyChanged();
          this.roomSend({ t: 'start', to: pid, opts: { ...this.matchOpts, roster } });
          break;
        }
        this.players.push(entry);
        this.links.set(pid, new Link(this, pid, pid, true));
        this.lobbyChanged();
        break;
      }
      case 'team': { const p = this.players.find(q => q.pid === pid); if (p && !this.inGame) { p.team = d.team ? 1 : 0; this.lobbyChanged(); } break; }
      case 'car': { const p = this.players.find(q => q.pid === pid); if (p && !this.inGame && CARS.some(c => c.id === d.car)) { p.car = d.car; const up = {}; for (const u of UPGRADES) up[u.id] = clamp(Math.round(+((d.upgrades || {})[u.id]) || 0), 0, MAX_LVL); p.upgrades = up; this.lobbyChanged(); } break; }
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
  setCar(car) {
    if (this.role === 'host') { const p = this.players[0]; if (p) { p.car = car; p.upgrades = save.up[car] || {}; this.lobbyChanged(); } }
    else this.roomSend({ t: 'car', from: this.label, car, upgrades: save.up[car] || {} });
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
    } else {
      // direkt verbunden: gemeinsamen Relay-Kanal abbestellen (spart Supabase-Nachrichten), sonst wieder zuhören
      this.ensureDown(link.mode !== 'rtc');
      if (this.onLobby) this.onLobby();
    }
  },
  // Spielzustand an alle. Direkt: Zustand über den schnellen Kanal, Ereignisse sicher.
  // Über Supabase nur mit verringerter Rate (Gratis-Limit 100 Nachrichten/s).
  broadcast(msg) {
    const now = performance.now();
    let relayed = 0;
    for (const l of this.links.values()) {
      if (l.mode === 'rtc') {
        if (msg.t === 's') {
          const { ev, ...state } = msg;
          l.send(state, true);
          if (ev && ev.length) l.send({ t: 'ev', ev });
        } else l.send(msg);
      } else relayed++;
    }
    this.relayN = relayed;
    if (!relayed) { this.downEv = []; return; }
    if (msg.t !== 's') { this.downSend(msg); return; }
    // ein Zustand für alle Relay-Spieler, Ereignisse dazwischen sammeln (Schuss-Effekte dürfen wegfallen)
    this.downEv = this.downEv.concat(msg.ev || []);
    if (now - this.lastDown < 1000 / relayDownHz(relayed)) { this.downEv = this.downEv.filter(e => e[0] !== 's').slice(-120); return; }
    this.lastDown = now;
    this.downSend({ ...msg, ev: this.downEv, rn: relayed }); this.downEv = [];
  },
  startMatch() {
    const S = this.settings;
    const humans = this.players.map(p => ({ key: p.pid, name: p.name, driver: p.driver, car: p.car, upgrades: p.upgrades, team: p.team, human: true }));
    const opts = { mapId: S.map, teamSize: S.size, difficulty: S.diff, capLimit: S.caps, timeLimit: S.time, bots: S.bots !== false };
    opts.roster = Game.buildRoster(opts, humans);
    this.inGame = true; this.matchOpts = opts;
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
    this.roomSend({ t: 'hello', from: this.label, name: me.name, driver: me.driver, car: me.car, upgrades: me.upgrades });
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
      case 'full': this.fail(d.reason); break;
    }
  },
  // Position/Eingaben: direkt über den schnellen Kanal, über Supabase höchstens ~12x pro Sekunde
  send(msg) {
    const l = this.links.get('host'); if (!l) return;
    if (msg.t === 'st') {
      if (l.mode !== 'rtc') {
        const now = performance.now();
        if (now - this.sendGate < 1000 / relayUpHz(this.relayN || 1)) return;
        this.sendGate = now;
      }
      l.send(msg, true);
    } else l.send(msg);
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
      if (d.t === 'st' || d.t === 'up') { if (this.onInput) this.onInput(link.remote, d); }
      else if (d.t === 'ping') link.send({ t: 'pong', ts: d.ts });
    } else {
      this.lastHost = performance.now();
      if (d.t === 's') { if (d.rn) this.relayN = d.rn; if (this.onSnapshot) this.onSnapshot(d); }
      else if (d.t === 'ev') { if (this.onEvents) this.onEvents(d.ev); }
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
        for (const l of this.links.values()) { l.checkRtc(now); if (l.mode === 'rtc') l.send({ t: 'hb' }); else if (l.dc && l.dc.readyState === 'open') try { l.dc.send('{"t":"hb"}'); } catch (e) { /* egal */ } }
        if (!this.inGame && this.relayN === 0 && [...this.links.values()].some(l => l.mode !== 'rtc')) this.downSend({ t: 'hb' });
        if (this.inGame) for (const [pid, l] of [...this.links]) if (now - l.lastSeen > LOST_MS) this.dropPeer(pid);
      } else if (this.role === 'client') {
        const l = this.links.get('host');
        if (l) { l.checkRtc(now); l.send({ t: 'hb' }); if (l.mode !== 'rtc' && l.dc && l.dc.readyState === 'open') try { l.dc.send('{"t":"hb"}'); } catch (e) { /* egal */ } }
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
    this.ensureDown(false); this.downEv = []; this.relayN = 0; this.lastDown = 0;
    this.links = new Map(); this.room = null; this.role = null; this.code = null; this.players = []; this.inGame = false;
    this.hostLabel = null; this.lastHost = 0; this.snapCount = 0;
  },
};
