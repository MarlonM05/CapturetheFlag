'use strict';
// roundRect-Fallback für ältere Browser
if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    r = Math.min(typeof r === 'number' ? r : 0, Math.abs(w) / 2, Math.abs(h) / 2);
    this.moveTo(x + r, y); this.arcTo(x + w, y, x + w, y + h, r); this.arcTo(x + w, y + h, x, y + h, r);
    this.arcTo(x, y + h, x, y, r); this.arcTo(x, y, x + w, y, r); this.closePath(); return this;
  };
}
// ---------------------------------------------------------------------------
// Schussental Showdown – Spiellogik, KI und Darstellung
// ---------------------------------------------------------------------------

const GRAV = 24;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const angNorm = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const d2 = (ax, ay, bx, by) => (ax - bx) * (ax - bx) + (ay - by) * (ay - by);
const rand = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[(Math.random() * arr.length) | 0];

const SHAPE = {
  sport: { turret: -1.0, face: 0.35, faceR: 0.78 },
  buggy: { turret: -0.75, face: 0.45, faceR: 0.82 },
  tank: { turret: -0.35, face: 1.55, faceR: 0.75 },
  jeep: { turret: -1.25, face: 0.7, faceR: 0.8 },
  truck: { turret: -0.7, face: 0.85, faceR: 0.82 },
};

const PROP = [
  { name: 'Holzkiste', hw: 0.85, hh: 0.85, h: 1.4, hp: 30, col: '#a0692e', top: '#c58a45' },
  { name: 'Strohballen', hw: 1.15, hh: 0.75, h: 1.3, hp: 20, col: '#c9a64a', top: '#e3c56a' },
  { name: 'Betonbarriere', hw: 1.6, hh: 0.5, h: 1.05, hp: 0, col: '#9a9a98', top: '#c3c3bf' },
];

// ---------------- Eingabe ----------------
const Input = {
  keys: {}, mouse: { x: 0, y: 0, down: false, right: false, moved: false, dx: 0, dy: 0 },
  touch: { active: false, move: null, aim: null, jump: false, boost: false, mine: false, drift: false },
  init(canvas) {
    addEventListener('keydown', e => {
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
      this.keys[e.code] = true;
      if (Input.onKey) Input.onKey(e.code);
    });
    addEventListener('keyup', e => { this.keys[e.code] = false; });
    addEventListener('blur', () => { this.keys = {}; this.mouse.down = false; });
    canvas.addEventListener('mousemove', e => {
      if (document.pointerLockElement === canvas) { this.mouse.dx += e.movementX || 0; this.mouse.dy += e.movementY || 0; return; }
      this.mouse.x = e.clientX; this.mouse.y = e.clientY; this.mouse.moved = true;
    });
    canvas.addEventListener('mousedown', e => {
      if (e.button === 0) this.mouse.down = true; if (e.button === 2) this.mouse.right = true; Sound.init();
      // Drohnen-Kamera: Klick fängt die Maus ein (Mausblick); Esc gibt sie frei
      if (Input.wantLock && Input.wantLock() && document.pointerLockElement !== canvas && canvas.requestPointerLock) { try { canvas.requestPointerLock(); } catch (er) { /* egal */ } }
    });
    addEventListener('mouseup', e => { if (e.button === 0) this.mouse.down = false; if (e.button === 2) this.mouse.right = false; });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    canvas.addEventListener('wheel', e => { if (Input.onWheel) Input.onWheel(Math.sign(e.deltaY)); e.preventDefault(); }, { passive: false });
    // Touch: linke Hälfte = Fahren, rechte Hälfte = Zielen/Schießen, Knöpfe rechts unten
    const tstart = e => {
      Sound.init();
      this.touch.active = true;
      for (const t of e.changedTouches) {
        if (Input.onTouchUi && Input.onTouchUi(t.clientX, t.clientY)) continue;
        const btn = this.touchButton(t.clientX, t.clientY);
        if (btn === 'cam') { if (Input.onKey) Input.onKey('KeyC'); continue; }
        if (btn) { this.touch[btn] = t.identifier; continue; }
        if (t.clientX < innerWidth * 0.5) { if (!this.touch.move) this.touch.move = { id: t.identifier, ox: t.clientX, oy: t.clientY, x: t.clientX, y: t.clientY }; }
        else if (!this.touch.aim) this.touch.aim = { id: t.identifier, ox: t.clientX, oy: t.clientY, x: t.clientX, y: t.clientY };
      }
      e.preventDefault();
    };
    const tmove = e => {
      for (const t of e.changedTouches) {
        for (const k of ['move', 'aim']) {
          const s = this.touch[k];
          if (s && s.id === t.identifier) { s.x = t.clientX; s.y = t.clientY; }
        }
      }
      e.preventDefault();
    };
    const tend = e => {
      for (const t of e.changedTouches) {
        for (const k of ['move', 'aim']) if (this.touch[k] && this.touch[k].id === t.identifier) this.touch[k] = null;
        for (const k of ['jump', 'boost', 'mine', 'drift']) if (this.touch[k] === t.identifier) this.touch[k] = false;
      }
      e.preventDefault();
    };
    canvas.addEventListener('touchstart', tstart, { passive: false });
    canvas.addEventListener('touchmove', tmove, { passive: false });
    canvas.addEventListener('touchend', tend, { passive: false });
    canvas.addEventListener('touchcancel', tend, { passive: false });
  },
  touchButtons() {
    const s = Math.min(innerWidth, innerHeight);
    const r = Math.max(30, s * 0.075);
    const bx = innerWidth - r * 1.4, by = innerHeight - r * 1.4;
    return [
      { id: 'jump', label: 'SPRUNG', x: bx - r * 2.4, y: by, r },
      { id: 'boost', label: 'TURBO', x: bx - r * 1.4, y: by - r * 2.2, r },
      { id: 'mine', label: 'MINE', x: bx - r * 3.9, y: by - r * 1.7, r: r * 0.8 },
      { id: 'drift', label: 'DRIFT', x: bx - r * 0.1, y: by - r * 4.2, r: r * 0.8 },
      { id: 'cam', label: 'KAMERA', x: innerWidth - r * 0.9, y: r * 3.2, r: r * 0.6 },
    ];
  },
  touchButton(x, y) {
    for (const b of this.touchButtons()) if ((x - b.x) ** 2 + (y - b.y) ** 2 < (b.r * 1.15) ** 2) return b.id;
    return null;
  },
};

// ---------------- Partikel ----------------
class Particles {
  constructor() { this.list = []; }
  add(p) {
    if (this.list.length >= 1600) return;
    if (this.world) {
      p.gz = this.world.terrain(p.x, p.y);
      if (p.zAbs !== undefined) { p.z = p.zAbs - p.gz; if (p.vz === undefined) p.vz = 0; }
    }
    this.list.push(p);
  }
  update(dt) {
    const L = this.list;
    for (let i = L.length - 1; i >= 0; i--) {
      const p = L[i];
      p.life -= dt;
      if (p.life <= 0) { L[i] = L[L.length - 1]; L.pop(); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.vz !== undefined) { p.vz -= (p.g || 0) * dt; p.z += p.vz * dt; if (p.z < 0) { p.z = 0; p.vz *= -0.3; p.vx *= 0.6; p.vy *= 0.6; } }
      const dr = p.drag || 0; if (dr) { p.vx *= 1 - dr * dt; p.vy *= 1 - dr * dt; }
      p.size += (p.grow || 0) * dt;
      if (p.rot !== undefined) p.rot += p.vr * dt;
    }
  }
  draw(g, pass) {
    for (const p of this.list) {
      if ((p.add ? 1 : 0) !== pass) continue;
      const f = p.life / p.max;
      g.globalAlpha = clamp((p.alpha || 1) * (p.fade === false ? 1 : f), 0, 1);
      g.fillStyle = p.color;
      const y = p.y - (p.z || 0) * 0.3;
      if (p.type === 'spark') {
        g.strokeStyle = p.color; g.lineWidth = p.size;
        g.beginPath(); g.moveTo(p.x, y); g.lineTo(p.x - p.vx * 0.03, y - p.vy * 0.03); g.stroke();
      } else if (p.type === 'debris') {
        g.save(); g.translate(p.x, y); g.rotate(p.rot); g.fillRect(-p.size / 2, -p.size / 3, p.size, p.size * 0.66); g.restore();
      } else if (p.type === 'ring') {
        g.strokeStyle = p.color; g.lineWidth = 0.5 * f + 0.1;
        g.beginPath(); g.arc(p.x, y, p.size, 0, 7); g.stroke();
      } else if (p.type === 'text') {
        g.save(); g.translate(p.x, y); g.scale(1 / p.Z, 1 / p.Z);
        g.font = 'bold 15px sans-serif'; g.textAlign = 'center'; g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,0.7)';
        g.strokeText(p.text, 0, 0); g.fillText(p.text, 0, 0); g.restore();
      } else {
        g.beginPath(); g.arc(p.x, y, p.size, 0, 7); g.fill();
      }
    }
    g.globalAlpha = 1;
  }
}

// ---------------- Fahrzeug ----------------
let CAR_ID = 1;
function newBotState(role = 'attack') {
  return { role, thinkT: Math.random() * 0.3, wp: null, stuckT: 0, revT: 0, revSteer: 1, roam: null, roamT: 0, target: null, aimErr: 0, field: null, fieldKey: -1, jumpT: 0, hurtT: 0, mineT: 0 };
}
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
class Car {
  constructor(game, def, lv, driver, team, isPlayer) {
    this.id = CAR_ID++;
    this.game = game; this.def = def; this.lv = lv; this.driver = driver; this.team = team; this.isPlayer = isPlayer;
    this.ups = { spd: 0, arm: 0, dmg: 0 }; this.xp = 0; this.pts = 0; this.lvlGiven = 0;
    this.st = carStats(def, lv, this.ups);
    this.shape = SHAPE[def.shape];
    this.w = WEAPONS[def.weapon];
    this.range = this.w.speed * this.w.life * (this.w.accel ? 1.4 : 1);
    this.kills = 0; this.deaths = 0; this.caps = 0; this.returns = 0; this.assists = 0; this.score = 0;
    this.input = { thr: 0, steer: 0, aim: 0, fire: false, jump: false, boost: false, mine: false };
    this.bot = isPlayer ? null : newBotState();
    this.human = isPlayer; this.earned = 0; this.key = null;
    this.alive = false; this.respawnT = 0;
    this.spawn(true);
  }
  spawn(first) {
    const g = this.game, base = g.world.bases[this.team];
    const p = g.world.randomFreeNear(base.x, base.y, 3, 13);
    this.x = p.x; this.y = p.y;
    this.a = Math.atan2(g.world.h / 2 - base.y, g.world.w / 2 - base.x) + rand(-0.4, 0.4);
    this.vx = 0; this.vy = 0; this.z = g.world.terrain(p.x, p.y); this.vz = 0; this.groundZ = this.z; this.groundKind = 'terrain'; this.onGround = true;
    this.turret = this.a;
    this.hp = this.st.hp; this.boost = this.st.boost; this.boosting = false;
    this.jumpCd = 0; this.fireCd = 0; this.mines = 2; this.mineCd = 0; this.mineRegen = 0;
    this.alive = true; this.protect = first ? 0 : 2.5; this.flag = -1; this.flashT = 0;
    this.life = (this.life || 0) + 1; this.rs = null; this.sunk = false; this.crashAcc = 0; this.steerS = 0;
    this.hitBy = new Map(); this.sinkT = 0; this.rampCd = 0; this.smokeT = 0; this.airT = 0;
    this.lastSkid = null;
  }
  get speed() { return Math.hypot(this.vx, this.vy); }
  // Werte nach Match-Upgrade neu berechnen
  recalc() {
    const old = this.st.hp;
    this.st = carStats(this.def, this.lv, this.ups);
    if (this.alive) this.hp = Math.min(this.st.hp, this.hp + Math.max(0, this.st.hp - old));
  }
}

// ---------------- Spiel ----------------
class Game {
  constructor(canvas, opts) {
    this.canvas = canvas; this.g = canvas.getContext('2d');
    this.opts = opts;
    this.map = MAPS.find(m => m.id === opts.mapId) || MAPS[0];
    this.world = new World(this.map);
    this.particles = new Particles();
    this.bullets = []; this.mines = []; this.feed = []; this.msgs = [];
    this.score = [0, 0];
    this.time = opts.timeLimit; this.state = 'countdown'; this.countT = 3.5; this.lastCount = 4;
    this.earned = 0; this.shake = 0; this.zoomMul = 1; this.showBoard = false; this.paused = false;
    this.cam = { x: 0, y: 0 };
    this.mini = this.world.renderMini(1100);
    this.props = this.map.crates.map(c => ({ ...c, ...PROP[c.t], z: this.world.terrain(c.x, c.y), alive: true, hpNow: PROP[c.t].hp, respawnT: 0 }));
    this.pickups = this.map.pickups.map(p => ({ ...p, z: this.world.terrain(p.x, p.y), active: true, t2: 0 }));
    this.flags = this.world.bases.map((b, i) => ({ team: i, state: 'base', x: b.x, y: b.y, z: this.world.terrain(b.x, b.y), carrier: null, dropT: 0 }));
    this.particles.world = this.world;
    this.demo = !!opts.demo;
    this.mode = opts.mode || 'local';
    this.isHost = this.mode === 'host'; this.isClient = this.mode === 'client';
    this.events = []; this.rtt = 0.1;
    const roster = opts.roster || Game.buildRoster({ ...opts, bots: true }, [{ key: 'local', name: this.demo ? null : (opts.name || 'Spieler'), driver: opts.driver, car: opts.car, upgrades: opts.upgrades || {}, team: 0, human: !this.demo }]);
    const me = opts.me || 'local';
    this.me = me;
    this.cars = roster.map(r => this.carFromRoster(r));
    this.byId = new Map(this.cars.map(c => [c.id, c]));
    this.player = this.cars.find(c => c.key === me) || this.cars[0];
    this.cam.x = this.player.x; this.cam.y = this.player.y;
    // 3D-Ansicht (Three.js), sonst klassisch 2D
    const c3 = document.getElementById('game3d');
    this.r3d = null;
    if (opts.three !== false && typeof R3 !== 'undefined' && R3.supported() && c3) {
      try { this.r3d = new Renderer3D(this, c3); } catch (e) { console.error(e); this.r3d = null; }
    }
    if (!this.r3d && c3) c3.style.display = 'none';
    // Kamera: 'chase' = Drohne hinter dem Auto, 'top' = von oben
    this.camMode = this.r3d ? (opts.camMode || 'chase') : 'top';
    this.lookYaw = 0; this.lookPitch = 0;
    Input.wantLock = () => !this.demo && this.running && this.camMode === 'chase' && !this.paused && this.state !== 'over' && !Input.touch.active;
    this.camYaw = this.player.a;
    this.viewRect = { x0: 0, y0: 0, x1: 1, y1: 1 };
    this.resize();
    this._onResize = () => this.resize();
    addEventListener('resize', this._onResize);
    this.acc = 0; this.last = performance.now();
    this.running = true;
    this.say('Mach dich bereit!', '#fff', 2.5);
    this.frame = this.frame.bind(this);
    requestAnimationFrame(this.frame);
  }
  // Kader: Menschen + Bots, die die Teams auffüllen
  carFromRoster(r) {
    const me = this.me;
    const def = CARS.find(c => c.id === r.car) || CARS[0];
    const c = new Car(this, def, r.upgrades || {}, driverById(r.driver), r.team, r.key === me && !this.demo);
    c.id = r.id; c.key = r.key; c.human = !!r.human;
    c.name = (r.name || c.driver.name || 'Bot').slice(0, 18);
    if (c.human || this.isClient) c.bot = null;
    else if (c.bot) c.bot.role = r.role || 'attack';
    c.remote = this.isHost && c.human && r.key !== me;
    return c;
  }
  rosterEntry(c) { return { id: c.id, key: c.key, name: c.name, driver: c.driver.id || '', car: c.def.id, upgrades: c.lv, team: c.team, human: !!c.human, role: c.bot ? c.bot.role : 'attack' }; }
  // Auto im laufenden Spiel ersetzen oder hinzufügen (Nachjoinen)
  putCar(r) {
    const old = this.byId.get(r.id);
    if (old) {
      if (old.flag >= 0 && this.isHost) this.dropFlag(old);
      if (this.r3d) this.r3d.removeCar(old);
    }
    const c = this.carFromRoster(r);
    const i = this.cars.indexOf(old);
    if (i >= 0) this.cars[i] = c; else this.cars.push(c);
    this.byId.set(c.id, c);
    for (const f of this.flags) if (f.carrier === old) f.carrier = null;
    return c;
  }
  // Host: Spieler kommt mitten ins Match -> ins Team mit weniger echten Spielern, ersetzt dort einen Bot
  lateJoin(info) {
    const humans = [0, 1].map(t => this.cars.filter(c => c.human && c.team === t).length);
    const sizes = [0, 1].map(t => this.cars.filter(c => c.team === t).length);
    let team = humans[0] !== humans[1] ? (humans[0] < humans[1] ? 0 : 1) : sizes[0] !== sizes[1] ? (sizes[0] < sizes[1] ? 0 : 1) : (this.score[0] <= this.score[1] ? 0 : 1);
    const pickBot = t => this.cars.filter(c => !c.human && c.team === t).sort((a, b) => (a.flag >= 0) - (b.flag >= 0) || (b.alive ? 0 : 1) - (a.alive ? 0 : 1))[0];
    let bot = pickBot(team);
    if (!bot && pickBot(1 - team) && humans[1 - team] < humans[team]) { team = 1 - team; bot = pickBot(team); }
    // Rückkehrer bekommt sein altes Auto (Team, Punkte, XP) zurück
    const own = this.cars.find(c => !c.human && c.wasName && c.wasName === info.name);
    if (own) { bot = own; team = own.team; }
    const id = bot ? bot.id : Math.max(...this.cars.map(c => c.id)) + 1;
    const r = { id, key: info.key, name: info.name, driver: info.driver, car: info.car, upgrades: info.upgrades || {}, team, human: true };
    const keep = own ? { kills: own.kills, deaths: own.deaths, caps: own.caps, returns: own.returns, assists: own.assists, score: own.score, xp: own.xp, pts: own.pts, earned: own.earned } : null;
    const c = this.putCar(r);
    if (keep) { Object.assign(c, keep); if (own.car === undefined && own.def.id === c.def.id) { c.ups = { ...own.ups }; if (c.recalc) c.recalc(); } }
    c.protect = 3;
    this.events.push(['rj', r]);
    this.log({ text: bot ? 'ist beigetreten (ersetzt ' + bot.name + ')' : 'ist beigetreten', a: c, flagTeam: team });
    return this.cars.map(o => this.rosterEntry(o));
  }
  static buildRoster(opts, humans) {
    const roster = [];
    let id = 1;
    const used = new Set(humans.map(h => h.driver));
    const pool = activeDrivers();
    const others = pool.filter(d => !used.has(d.id)).sort(() => Math.random() - 0.5);
    const lvRange = [[0, 1], [1, 3], [3, 5]][opts.difficulty] || [1, 3];
    let di = 0;
    for (const h of humans) roster.push({ ...h, id: id++ });
    if (opts.bots === false) return roster;
    for (let team = 0; team < 2; team++) {
      const have = humans.filter(h => h.team === team).length;
      for (let i = have; i < opts.teamSize; i++) {
        const lv = {};
        for (const u of UPGRADES) lv[u.id] = Math.round(rand(lvRange[0], lvRange[1]));
        const drv = others.length ? others[di++ % others.length] : null;
        roster.push({ key: 'bot' + id, id: id++, car: pick(CARS).id, upgrades: lv, driver: drv ? drv.id : '', name: drv ? drv.name : 'Bot ' + id, team, human: false, role: i % 3 === 1 ? 'defend' : 'attack' });
      }
    }
    return roster;
  }
  destroy() {
    this.running = false;
    if (document.pointerLockElement && document.exitPointerLock) document.exitPointerLock();
    if (this.r3d) { this.r3d.dispose(); this.r3d = null; }
    removeEventListener('resize', this._onResize);
    Sound.engineStop();
  }
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    this.dpr = dpr;
    this.hud = clamp(Math.min(innerWidth, innerHeight) / 720, 0.6, 1);
    this.canvas.width = Math.round(innerWidth * dpr); this.canvas.height = Math.round(innerHeight * dpr);
    this.canvas.style.width = innerWidth + 'px'; this.canvas.style.height = innerHeight + 'px';
    if (this.r3d) this.r3d.resize();
    this.updateZoom();
  }
  updateZoom() {
    const base = Math.hypot(innerWidth, innerHeight) / 150;
    this.Z = Math.round(clamp(base * this.zoomMul, 3.2, 16) * this.dpr * 4) / 4;
  }
  tapUp(x, y) {
    for (const b of this.upBoxes || []) if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) { this.requestUp(b.k); return true; }
    return false;
  }
  toggleCam() {
    if (!this.r3d) return this.camMode;
    this.camMode = this.camMode === 'chase' ? 'top' : 'chase';
    this.camYaw = this.player.a;
    this.say(this.camMode === 'chase' ? 'Kamera: Drohne' : 'Kamera: von oben', '#fff', 1, false);
    return this.camMode;
  }
  zoom(dir) { this.zoomMul = clamp(this.zoomMul * (dir > 0 ? 0.9 : 1.1), 0.6, 1.6); this.updateZoom(); }

  // ---------------- Schleife ----------------
  frame(now) {
    if (!this.running) return;
    let dt = (now - this.last) / 1000; this.last = now;
    if (dt > 0.1) dt = 0.1;
    if (!this.paused) {
      this.acc += dt;
      const step = 1 / 60;
      let n = 0;
      while (this.acc >= step && n < 6) { this.update(step); this.acc -= step; n++; }
      if (n === 6) this.acc = 0;
    }
    this.render(dt);
    requestAnimationFrame(this.frame);
  }

  say(text, color = '#fff', dur = 2, big = true) {
    const same = this.msgs.find(m => m.text === text);
    if (same) { same.t = same.max = dur; return; }
    this.msgs.push({ text, color, t: dur, max: dur, big }); if (this.msgs.length > 3) this.msgs.shift(); }
  log(entry) {
    entry.t = 7; this.feed.unshift(entry); if (this.feed.length > 6) this.feed.pop();
    if (this.isHost) this.events.push(['l', { kind: entry.kind, text: entry.text, flagTeam: entry.flagTeam, cap: entry.cap, fx: entry.fx, a: entry.a ? entry.a.id : 0, b: entry.b ? entry.b.id : 0 }]);
    if (entry.fx) this.flagFx(entry.fx, entry.a, entry.flagTeam);
  }
  // Meldungen & Sounds zu Flaggen-Ereignissen aus Sicht des lokalen Spielers
  flagFx(fx, c, flagTeam) {
    const me = this.player;
    if (fx === 'pick') {
      if (c === me) this.say('DU HAST DIE FLAGGE! Ab zur Basis!', '#ffe66d', 2.5);
      else if (flagTeam === me.team) this.say('Unsere Flagge wurde geklaut!', '#ff8c7f', 2);
      Sound.play(flagTeam === me.team ? 'lost' : 'flag');
    } else if (fx === 'ret') {
      Sound.play('pickup', c ? this.vol(c.x, c.y) : 1);
    } else if (fx === 'cap' && c) {
      this.say('PUNKT FÜR ' + TEAM[c.team].name.toUpperCase() + '!', TEAM[c.team].light, 2.8);
      Sound.play(c.team === me.team ? 'capture' : 'lost');
      for (let i = 0; i < 40; i++) {
        const a = rand(0, 6.3), s = rand(4, 16);
        this.particles.add({ x: c.x, y: c.y, z: 1, vz: rand(6, 14), g: 18, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1.8, max: 1.8, size: 0.35, color: pick([TEAM[c.team].color, '#fff', '#ffe66d']), add: true });
      }
    }
  }
  pickupFx(c, t) {
    if (c.isPlayer) {
      if (t === 0) this.say('+ Reparatur', '#7dff8a', 1, false);
      if (t === 1) this.say('+ Turbo & Mine', '#7ad7ff', 1, false);
    }
    if (t !== 2) Sound.play('pickup', this.vol(c.x, c.y));
  }
  earn(n, x, y, why, car) {
    if (car) car.earned += n;
    if (car && !car.isPlayer) { if (this.isHost) this.events.push(['e', car.id, n, r1(x), r1(y), why || '']); return; }
    this.earnFx(n, x, y, why);
  }
  earnFx(n, x, y, why) {
    this.earned += n;
    if (x !== undefined) this.particles.add({ type: 'text', text: '+' + n + ' 💰' + (why ? ' ' + why : ''), x, y: y - 2, vx: 0, vy: -4, life: 1.6, max: 1.6, size: 0, color: '#ffe66d', Z: this.Z, alpha: 1 });
    Sound.play('coin');
  }
  // ---------------- XP & Match-Upgrades ----------------
  addXp(c, n) {
    if (!c || this.isClient || this.state === 'over') return;
    c.xp += n;
    const lvl = Math.min(MATCH_UPS.length * MATCH_UP_MAX, Math.floor(c.xp / XP.perLevel));
    while (c.lvlGiven < lvl) {
      c.lvlGiven++; c.pts++;
      if (c.isPlayer) { this.say('UPGRADE BEREIT!  [1] Tempo  [2] Panzerung  [3] Waffe', '#7dd3ff', 2.5, false); Sound.play('pickup'); }
      if (c.bot) { const opts = MATCH_UPS.filter(u => c.ups[u.k] < MATCH_UP_MAX); if (opts.length) this.applyUp(c, pick(opts).k); }
    }
  }
  applyUp(c, k) {
    if (!c || c.pts <= 0 || !(k in c.ups) || c.ups[k] >= MATCH_UP_MAX) return false;
    c.ups[k]++; c.pts--; c.recalc();
    if (c.isPlayer) { const u = MATCH_UPS.find(x => x.k === k); this.say(`${u.icon} ${u.name} Stufe ${c.ups[k]}`, '#7dd3ff', 1.4, false); Sound.play('buy'); }
    return true;
  }
  requestUp(k) {
    const p = this.player;
    if (!p || p.pts <= 0 || p.ups[k] >= MATCH_UP_MAX) return;
    if (this.isClient) { this.upT = performance.now(); if (typeof Net !== 'undefined') Net.send({ t: 'up', k }); p.pts--; p.ups[k]++; p.recalc(); const u = MATCH_UPS.find(x => x.k === k); this.say(`${u.icon} ${u.name} Stufe ${p.ups[k]}`, '#7dd3ff', 1.4, false); Sound.play('buy'); }
    else this.applyUp(p, k);
  }
  // Treffer-Rückmeldung für den Schützen
  hitFx(target, amt) {
    this.hitT = 0.14;
    Sound.play('hit', 0.8);
    const a = this.dmgAcc || (this.dmgAcc = new Map());
    const e = a.get(target) || { amt: 0, t: performance.now() };
    e.amt += amt; a.set(target, e);
  }
  vol(x, y) { const d = Math.sqrt(d2(x, y, this.cam.x, this.cam.y)); return clamp(1 - d / 140, 0, 1); }

  update(dt) {
    const W = this.world;
    if (this.isClient) { this.clientUpdate(dt); this.updateCommon(dt); return; }
    if (this.state === 'countdown') {
      this.countT -= dt;
      const c = Math.ceil(this.countT);
      if (c < this.lastCount && c > 0) { this.lastCount = c; Sound.play('countdown'); this.say(String(c), '#ffe66d', 0.9); }
      if (this.countT <= 0) { this.state = 'play'; Sound.play('go'); this.say('LOS! Hol dir die Flagge!', '#7dff8a', 1.6); }
    } else if (this.state === 'play') {
      this.time -= dt;
      if (this.time <= 0) { this.time = 0; this.endGame(); }
    }
    const playing = this.state !== 'countdown';
    if (!this.demo) { this.readPlayerInput(); this.showBoard = !!Input.keys.Tab; }
    for (const c of this.cars) {
      if (!c.alive) {
        c.respawnT -= dt;
        if (c.respawnT <= 0 && this.state !== 'over') c.spawn(false);
        continue;
      }
      if (c.bot) this.think(c, dt);
      if (playing && this.state !== 'over') this.weapons(c, dt); else c.input.fire = false;
      if (c.remote) this.remoteMove(c, dt, playing); else this.physics(c, dt, playing);
    }
    this.carCollisions();
    this.updateBullets(dt);
    this.updateMines(dt);
    this.updateFlags(dt);
    this.updatePickups(dt);
    if (this.isHost) this.netTick();
    this.updateCommon(dt);
  }
  updateCommon(dt) {
    this.particles.update(dt);
    this.hitT = Math.max(0, (this.hitT || 0) - dt);
    // Schadenszahlen gesammelt anzeigen (kein Zahlensalat bei der Minigun)
    if (this.dmgAcc && this.dmgAcc.size) {
      const now = performance.now();
      for (const [t, e] of this.dmgAcc) {
        if (now - e.t < 280) continue;
        this.dmgAcc.delete(t);
        if (e.amt >= 1) this.particles.add({ type: 'text', text: '-' + Math.round(e.amt), x: t.x + rand(-1, 1), y: t.y - 1, vx: 0, vy: -3, life: 0.9, max: 0.9, size: 0, color: '#ff7a5c', Z: this.Z, alpha: 1 });
      }
    }
    for (const f of this.feed) f.t -= dt;
    for (const m of this.msgs) m.t -= dt;
    this.msgs = this.msgs.filter(m => m.t > 0);
    this.shake = Math.max(0, this.shake - dt * 3);
    // Kamera
    const p = this.player;
    if (this.camMode === 'chase') {
      if (p.alive) {
        const vF = p.vx * Math.cos(p.a) + p.vy * Math.sin(p.a);
        if (vF > -3) this.camYaw += angNorm(p.a - this.camYaw) * (1 - Math.exp(-dt * 3.2));
        this.cam.x = p.x; this.cam.y = p.y;
        if (!this.demo) {
          const M = Input.mouse;
          if (M.dx || M.dy) {
            this.lookYaw = clamp((this.lookYaw || 0) + M.dx * 0.0032, -2.6, 2.6);
            this.lookPitch = clamp((this.lookPitch || 0) - M.dy * 0.0024, -0.35, 0.65);
            this.lookIdle = 0; M.dx = 0; M.dy = 0;
          } else this.lookIdle = (this.lookIdle || 0) + dt;
          if (this.lookIdle > 1.4 && p.speed > 6) { const k = Math.exp(-dt * 2.2); this.lookYaw *= k; this.lookPitch *= k; }
        }
      }
      this.viewYaw = this.camYaw + (this.lookYaw || 0);
      if (this.demo) return;
      if (this.player.alive) Sound.engineUpdate(clamp(p.speed / p.st.speed, 0, 1.3), p.boosting, this.state !== 'over');
      else Sound.engineUpdate(0, false, false);
      return;
    }
    let tx = p.x + p.vx * 0.45, ty = p.y + p.vy * 0.45;
    if (!Input.touch.active && Input.mouse.moved) {
      const mw = this.screenToWorld(Input.mouse.x, Input.mouse.y);
      tx += clamp(mw.x - p.x, -40, 40) * 0.22; ty += clamp(mw.y - p.y, -40, 40) * 0.22;
    }
    const k = 1 - Math.exp(-dt * 5);
    this.cam.x += (tx - this.cam.x) * k; this.cam.y += (ty - this.cam.y) * k;
    if (this.demo) return;
    if (this.player.alive) Sound.engineUpdate(clamp(p.speed / p.st.speed, 0, 1.3), p.boosting, this.state !== 'over');
    else Sound.engineUpdate(0, false, false);
  }

  screenToWorld(sx, sy) {
    if (this.r3d) return this.r3d.screenToGround(sx, sy, (this.player ? this.player.z : 0) + 1);
    const Z = this.Z / this.dpr;
    return { x: this.cam.x + (sx - innerWidth / 2) / Z, y: this.cam.y + (sy - innerHeight / 2) / Z };
  }

  readPlayerInput() {
    const c = this.player, inp = c.input, K = Input.keys;
    if (!c.alive) return;
    const T = Input.touch;
    if (T.active && (T.move || T.aim || T.jump || T.boost || T.mine || T.drift)) {
      inp.thr = 0; inp.steer = 0;
      if (T.move) {
        const dx = T.move.x - T.move.ox, dy = T.move.y - T.move.oy;
        const m = Math.hypot(dx, dy), R = Math.min(innerWidth, innerHeight) * 0.12;
        if (m > 8) {
          // in der Drohnen-Ansicht heißt „nach oben“ = geradeaus
          const want = this.camMode === 'chase' ? this.camYaw + Math.atan2(dx, -dy) : Math.atan2(dy, dx);
          let diff = angNorm(want - c.a);
          const mag = clamp(m / R, 0, 1);
          if (Math.abs(diff) > 2.4 && c.speed < 6) { inp.thr = -mag; inp.steer = -Math.sign(diff); }
          else { inp.steer = clamp(diff * 2.2, -1, 1); inp.thr = mag * (Math.abs(diff) > 1.6 ? 0.4 : 1); }
        }
      }
      inp.pitch = 0;
      if (T.aim) {
        const dx = T.aim.x - T.aim.ox, dy = T.aim.y - T.aim.oy;
        if (Math.hypot(dx, dy) > 10) { inp.aim = this.camMode === 'chase' ? this.camYaw + Math.atan2(dx, -dy) : Math.atan2(dy, dx); inp.fire = Math.hypot(dx, dy) > 28; inp.manualAim = true; }
        else { inp.fire = false; inp.manualAim = false; }
      } else { inp.fire = false; inp.manualAim = false; }
      inp.jump = !!T.jump; inp.boost = !!T.boost; inp.mine = !!T.mine; inp.drift = !!T.drift;
      if (!inp.manualAim || this.opts.autoAim) this.autoAim(c, !inp.manualAim);
      return;
    }
    inp.thr = (K.KeyW || K.ArrowUp ? 1 : 0) - (K.KeyS || K.ArrowDown ? 1 : 0);
    inp.steer = (K.KeyD || K.ArrowRight ? 1 : 0) - (K.KeyA || K.ArrowLeft ? 1 : 0);
    inp.jump = !!K.Space;
    inp.boost = !!(K.ShiftLeft || K.ShiftRight);
    inp.mine = !!(K.KeyE || Input.mouse.right);
    inp.drift = !!(K.KeyQ || K.KeyX);
    inp.fire = Input.mouse.down || !!K.KeyF || !!K.Enter;
    inp.pitch = 0;
    if (this.r3d && this.camMode === 'chase') {
      const cr = this.crosshair();
      const ap = this.r3d.aimPoint(cr.x, cr.y, c);
      inp.aim = Math.atan2(ap.y - c.y, ap.x - c.x);
      const dz = ap.z - (c.z + 1.1), hd = Math.max(1, Math.hypot(ap.x - c.x, ap.y - c.y));
      inp.pitch = ap.kind === 'ground' && Math.abs(dz) < 2.5 ? 0 : clamp(Math.atan2(dz, hd), -0.6, 0.9);
      this.aimLock = ap.car || null;
    } else if (Input.mouse.moved && this.r3d) {
      // Strahl durch das Fadenkreuz: trifft Auto, Hauswand, Boden oder Himmel -> Seiten- und Höhenwinkel
      const ap = this.r3d.aimPoint(Input.mouse.x, Input.mouse.y, c);
      inp.aim = Math.atan2(ap.y - c.y, ap.x - c.x);
      const dz = ap.z - (c.z + 1.1), hd = Math.max(1, Math.hypot(ap.x - c.x, ap.y - c.y));
      inp.pitch = ap.kind === 'ground' && Math.abs(dz) < 2.5 ? 0 : clamp(Math.atan2(dz, hd), -0.6, 0.9);
      this.aimLock = ap.car || null;
    } else if (Input.mouse.moved) {
      const mw = this.screenToWorld(Input.mouse.x, Input.mouse.y);
      inp.aim = Math.atan2(mw.y - c.y, mw.x - c.x);
    } else inp.aim = c.a;
    if (this.opts.autoAim) this.autoAim(c, true);
  }
  // Fadenkreuz der Drohnen-Ansicht (CSS-Pixel): Bildmitte, etwas über dem Autodach
  crosshair() { return { x: innerWidth / 2, y: innerHeight * 0.4 }; }
  autoAim(c, alsoFire) {
    const t = this.findTarget(c, c.range * 0.95);
    if (t) {
      const tt = Math.sqrt(d2(c.x, c.y, t.x, t.y)) / c.w.speed;
      c.input.aim = Math.atan2(t.y + t.vy * tt - c.y, t.x + t.vx * tt - c.x);
      const dz = (t.z + 0.9) - (c.z + 1.1);
      c.input.pitch = Math.abs(dz) > 1.8 ? clamp(Math.atan2(dz, Math.max(1, tt * c.w.speed)), -0.6, 0.9) : 0;
      if (alsoFire && Input.touch.active && !c.input.manualAim) c.input.fire = true;
    } else if (alsoFire && Input.touch.active && !c.input.manualAim) { c.input.fire = false; c.input.aim = c.a; }
  }
  findTarget(c, range) {
    let best = null, bd = range * range;
    for (const o of this.cars) {
      if (!o.alive || o.team === c.team) continue;
      let dd = d2(c.x, c.y, o.x, o.y);
      if (o.flag >= 0) dd *= 0.5;
      if (dd < bd && this.world.los(c.x, c.y, o.x, o.y)) { bd = dd; best = o; }
    }
    return best;
  }

  // ---------------- Physik ----------------
  physics(c, dt, playing) {
    const W = this.world, st = c.st, inp = c.input;
    const thr = playing ? inp.thr : 0;
    // Lenkung weich einblenden (Menschen), Zurückstellen geht schneller
    const back = Math.abs(inp.steer) < Math.abs(c.steerS) || Math.sign(inp.steer) !== Math.sign(c.steerS);
    const sr = c.bot ? 12 : back ? 7 : 3.2;
    c.steerS += clamp(inp.steer - c.steerS, -sr * dt, sr * dt);
    const steer = c.steerS;
    c.protect = Math.max(0, c.protect - dt); c.flashT = Math.max(0, c.flashT - dt);
    c.jumpCd = Math.max(0, c.jumpCd - dt); c.rampCd = Math.max(0, c.rampCd - dt);
    if (!inp.jump) c.jumpHeld = false;
    // Boden: Gelände, Tunnelboden, Brücke oder Dach
    c.groundZ = W.groundAt(c.x, c.y, c.z);
    c.groundKind = W.groundKind;
    const [sx, sy] = c.groundKind === 'roof' ? [0, 0] : W.slopeAt(c.x, c.y, c.z);
    c.slopeX = sx; c.slopeY = sy;
    const surfVz = sx * c.vx + sy * c.vy;
    c.airLock = Math.max(0, (c.airLock || 0) - dt);
    const onGround = c.airLock <= 0 && c.z <= c.groundZ + 0.1 && c.vz <= surfVz + 0.8;
    if (!c.onGround && onGround) {
      if (c.airT > 0.25 && (c.pitch || c.flipAcc)) this.landFlip(c);
      if (c.airT > 0.35) {
        Sound.play('land', this.vol(c.x, c.y));
        for (let i = 0; i < 8; i++) this.particles.add({ x: c.x + rand(-1.5, 1.5), y: c.y + rand(-1.5, 1.5), vx: rand(-4, 4), vy: rand(-4, 4), life: 0.6, max: 0.6, size: 0.8, grow: 2.5, color: '#bdb5a5', alpha: 0.5, drag: 3 });
      }
      c.airT = 0;
    }
    c.onGround = onGround;
    if (!onGround) c.airT += dt;
    else if (c.pitch || c.dodgeT) { c.pitch = 0; c.pitchV = 0; c.flipAcc = 0; c.dodgeT = 0; }
    // Hangabtrieb: bergauf langsamer, bergab schneller
    if (onGround) { c.vx -= GRAV * 0.6 * sx * dt; c.vy -= GRAV * 0.6 * sy * dt; }
    const fx = Math.cos(c.a), fy = Math.sin(c.a);
    let vF = c.vx * fx + c.vy * fy, vL = -c.vx * fy + c.vy * fx;
    // Turbo
    c.boosting = playing && inp.boost && c.boost > 0.02 && (thr >= 0 || !onGround);
    if (c.boosting) { c.boost = Math.max(0, c.boost - dt); }
    else {
      // Nitro lädt schneller beim Driften und in der Luft (Sprünge, Saltos)
      const bonus = (c.drifting && Math.hypot(c.vx, c.vy) > 8 ? 0.7 : 0) + (!onGround ? 0.45 : 0);
      c.boost = Math.min(st.boost, c.boost + (st.boostRegen + bonus) * dt);
    }
    const wz = W.waterAt(c.x, c.y);
    const surfWater = wz !== null && c.groundKind !== 'deck' && c.groundKind !== 'roof' && c.z < wz + 0.5;
    if (onGround) {
      let maxS = st.speed * (c.boosting ? 1.5 : 1) * (c.flag >= 0 ? 0.94 : 1);
      let target = 0, acc = 8;
      const t = c.boosting ? 1 : thr;
      if (t > 0) { target = maxS * t; acc = vF < 0 ? st.accel * 2 : st.accel * (c.boosting ? 1.8 : 1); }
      else if (t < 0) { target = -st.speed * 0.5 * -t; acc = vF > 0 ? st.accel * 2.2 : st.accel * 0.8; }
      if (vF < target) vF = Math.min(target, vF + acc * dt);
      else if (vF > target) vF = Math.max(target, vF - (t === 0 ? 7 : acc) * dt);
      // Drift: Handbremse (Q) – Heck bricht aus, Auto lenkt stärker ein
      c.drifting = !!inp.drift && Math.abs(vF) > 7 && playing;
      const grip = c.drifting ? 2.6 : c.boosting ? 5 : 9;
      vL *= Math.exp(-grip * dt);
      if (c.drifting) {
        vF -= Math.sign(vF) * 3 * dt;
        if (Math.random() < 0.6) {
          const px = -fy, py = fx, s = Math.random() < 0.5 ? 1 : -1;
          this.particles.add({ x: c.x - fx * c.def.len * 0.4 + px * s, y: c.y - fy * c.def.len * 0.4 + py * s, z: 0.3, vz: 1.2, vx: rand(-1.5, 1.5), vy: rand(-1.5, 1.5), life: 0.9, max: 0.9, size: 0.6, grow: 2.2, color: '#d9d9d9', alpha: 0.45 });
        }
      }
      const turnF = clamp(Math.abs(vF) / 7, 0, 1) * Math.sign(vF || 1);
      // bei hohem Tempo weniger empfindlich
      const tf = c.bot ? 1 : 0.8 * (1 - 0.35 * clamp(Math.abs(vF) / st.speed, 0, 1.3));
      c.a += steer * st.turn * tf * dt * turnF * (c.drifting ? 1.4 : c.boosting ? 0.8 : 1);
      if (c.boosting && Math.random() < 0.7) {
        this.particles.add({ x: c.x - fx * c.def.len * 0.55, y: c.y - fy * c.def.len * 0.55, vx: -fx * 10 + rand(-2, 2), vy: -fy * 10 + rand(-2, 2), life: 0.25, max: 0.25, size: 0.6, grow: -1.5, color: Math.random() < 0.5 ? '#7ad7ff' : '#ffffff', add: true });
      }
      // Sprung
      c.airJumps = c.bot ? 0 : 1;
      if (playing && inp.jump && c.jumpCd <= 0) {
        c.vz = Math.max(0, surfVz) + st.jump; c.jumpCd = st.jumpCd; c.onGround = false; c.jumpHeld = true;
        Sound.play('jump', this.vol(c.x, c.y));
        for (let i = 0; i < 10; i++) this.particles.add({ x: c.x, y: c.y, vx: rand(-6, 6), vy: rand(-6, 6), life: 0.5, max: 0.5, size: 0.7, grow: 2, color: '#d7d0c0', alpha: 0.5, drag: 4 });
      }
      // Reifenspuren
      if (c.drifting || Math.abs(vL) > 4.5 || (c.boosting && Math.random() < 0.3) || (t !== 0 && Math.abs(vF) < 6 && Math.abs(target) > 10)) this.skid(c);
      else c.lastSkid = null;
    } else {
      c.drifting = false;
      // Doppelsprung: Taste in der Luft erneut drücken
      if (playing && inp.jump && !c.jumpHeld && c.airJumps > 0 && c.airT > 0.06) {
        c.airJumps--; c.jumpHeld = true;
        const dThr = inp.thr || 0, dSt = inp.steer || 0;
        if (dThr || dSt) {
          // Ausweichsprung: kräftiger Stoß in Richtung (vorne/hinten/seitlich), Vorwärts-/Rückwärtssalto
          const l = Math.hypot(dThr, dSt);
          vF += dThr / l * 11; vL += dSt / l * 11; c.vz = Math.max(c.vz, 0) * 0.4 + st.jump * 0.6;
          if (dThr) { c.dodgeT = 0.55; c.dodgeDir = Math.sign(dThr); }
        } else c.vz = Math.max(c.vz, 0) + st.jump * 0.9;
        Sound.play('jump', this.vol(c.x, c.y));
        for (let i = 0; i < 8; i++) this.particles.add({ x: c.x, y: c.y, zAbs: c.z + 0.3, vz: -3, vx: rand(-5, 5), vy: rand(-5, 5), life: 0.4, max: 0.4, size: 0.6, grow: 2, color: '#bfe8ff', alpha: 0.6, add: true });
      }
      // Saltos: W/S + Nitro dreht nach vorne/hinten, W/S allein neigt nur leicht; kurz vor dem Boden richtet sich das Auto auf
      const hgt = c.z - c.groundZ, nearGround = hgt < 3.5 && c.vz < 0;
      const up = Math.round((c.pitch || 0) / (Math.PI * 2)) * Math.PI * 2;
      let wantV;
      const pt = c.bot ? 0 : thr;   // Bots fliegen gerade
      if (c.dodgeT > 0) { c.dodgeT -= dt; wantV = -c.dodgeDir * 11.4; if (c.dodgeT <= 0) { c.pitch = angNorm(c.pitch); c.flipAcc = 0; } }
      else if (c.boosting && pt !== 0 && !nearGround) wantV = -pt * 7.2;
      else { const tgt = (nearGround ? up : up - pt * 0.35); wantV = clamp((tgt - (c.pitch || 0)) * (nearGround ? 6 : 4), -5.5, 5.5); }
      c.pitchV = c.dodgeT > 0 ? wantV : (c.pitchV || 0) + (wantV - (c.pitchV || 0)) * Math.min(1, dt * 7);
      c.pitch = (c.pitch || 0) + c.pitchV * dt;
      c.flipAcc = (c.flipAcc || 0) + c.pitchV * dt;
      c.a += steer * st.turn * (c.boosting ? 0.75 : 0.35) * dt;
      c.lastSkid = null;
      if (c.boosting) {
        // Nitro in der Luft: Schub nach vorne und Auftrieb -> gleiten / fliegen
        vF = Math.min(vF + st.accel * 1.3 * dt, st.speed * 1.5);
        vL *= Math.exp(-2.5 * dt);
        c.vz += GRAV * (c.z - c.groundZ > 18 ? 0.9 : c.vz < 9 ? 1.3 : 0.92) * dt;   // kräftiger Auftrieb bis ~20 m: über Dächer hüpfen
        if (c.vz < -3) c.vz += 14 * dt;
        if (c.z - c.groundZ > 22 && c.vz > 0) c.vz *= 0.9;
        if (Math.random() < 0.8) this.particles.add({ x: c.x - fx * c.def.len * 0.6, y: c.y - fy * c.def.len * 0.6, zAbs: c.z + 0.6, vz: -2, vx: -fx * 12 + rand(-2, 2), vy: -fy * 12 + rand(-2, 2), life: 0.35, max: 0.35, size: 0.7, grow: -1.2, color: Math.random() < 0.5 ? '#7ad7ff' : '#ffb347', add: true });
      }
    }
    c.vx = fx * vF - fy * vL; c.vy = fy * vF + fx * vL;
    // Rampen
    if (onGround && c.groundKind !== 'roof' && c.rampCd <= 0) {
      for (const r of W.ramps) {
        const dx = c.x - r.x, dy = c.y - r.y;
        if (dx * dx + dy * dy > (r.len * r.len + r.wid * r.wid) / 4 + 4) continue;
        const ca = Math.cos(r.a), sa = Math.sin(r.a);
        const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
        if (Math.abs(u) < r.len / 2 && Math.abs(v) < r.wid / 2 + 0.5) {
          const along = c.vx * ca + c.vy * sa;
          // Bots nehmen Flussschanzen nur gerade (sonst fahren sie drüber)
          if (along > 4 && !(r.big && c.bot && along < 0.85 * Math.hypot(c.vx, c.vy))) {
            c.vz = Math.max(0, surfVz) + clamp(4.5 + (r.big ? Math.max(along, 30) : along) * 0.32, 7, 15.5) + (r.big ? 1.5 : 0); c.rampCd = 0.8; c.onGround = false; c.z = Math.max(c.z, c.groundZ + 0.4);
            // auf Rampenrichtung ausrichten, damit man nicht seitlich abprallt; Flussschanzen geben Mindesttempo
            const sp2 = r.big ? Math.max(Math.hypot(c.vx, c.vy), 30) : Math.hypot(c.vx, c.vy);
            const al = r.big ? 1 : 0.5;   // Flussschanzen schicken immer quer über den Fluss
            c.vx = c.vx * (1 - al) + ca * sp2 * al; c.vy = c.vy * (1 - al) + sa * sp2 * al;
            if (r.big) c.a = r.a;
            Sound.play('jump', this.vol(c.x, c.y));
            if (c.isPlayer) this.say('Sprung!', '#ffe66d', 0.7, false);
          }
        }
      }
    }
    // Schwerkraft: am Boden folgt das Auto der Oberfläche, sonst fällt es
    if (c.onGround) c.vz = surfVz; else c.vz -= GRAV * dt;
    c.z += c.vz * dt;
    // Decke (Tunnel, Brückenunterseite) begrenzt Sprünge
    const roof = W.ceilingAt(c.x, c.y, c.z);
    if (roof !== null && c.z + 1.6 > roof) { c.z = Math.max(c.groundZ, roof - 1.6); if (c.vz > 0) c.vz = 0; }
    // Bewegung + Kollision (Substeps)
    const sp = c.speed;
    const steps = sp * dt > 0.6 ? 2 : 1;
    let moved = 0;
    for (let s = 0; s < steps; s++) {
      const ox = c.x, oy = c.y;
      const mx = c.vx * dt / steps, my = c.vy * dt / steps, ml = Math.hypot(mx, my);
      // Gelände/Brücken: steile Hänge und Plattenkanten sind Wände
      // höchstens 45° Steigung (bezogen auf den Abstand zum Prüfpunkt) plus kleine Bordsteinkante
      const rr = c.def.radius * 0.85, ux = ml > 1e-4 ? mx / ml : 0, uy = ml > 1e-4 ? my / ml : 0;
      const stepH = 0.15 + 1.0 * ml, stepF = 0.15 + 1.0 * (ml + rr);
      // am Boden fährt man nicht ins Wasser (Ufer wie ein Bordstein) – nur ein zu kurzer Sprung endet im Fluss
      const wet = (x, y) => { if (c.z - c.groundZ > 0.8 || c.groundKind !== 'terrain') return false; const wz2 = W.waterAt(x, y); return wz2 !== null && wz2 > c.z - 3; };
      const bl = (x, y) => W.blockedAt(x, y, c.z, stepH) || wet(x, y) || (ml > 1e-4 && (W.blockedAt(x + ux * rr, y + uy * rr, c.z, stepF) || wet(x + ux * rr, y + uy * rr)));
      if (!bl(ox + mx, oy + my)) { c.x = ox + mx; c.y = oy + my; }
      else {
        const imp = Math.hypot(c.vx, c.vy);
        if (!bl(ox + mx, oy)) { c.x = ox + mx; c.vy *= -0.15; }
        else if (!bl(ox, oy + my)) { c.y = oy + my; c.vx *= -0.15; }
        else { c.vx *= -0.2; c.vy *= -0.2; }
        if (imp > 22) {
          const cdmg = (imp - 22) * 0.45 / c.def.mass;
          if (this.isClient && c === this.player) c.crashAcc += cdmg;
          this.damage(c, cdmg, null, 'crash');
          Sound.play('clank', this.vol(c.x, c.y));
        }
      }
      moved += Math.hypot(c.x - ox, c.y - oy);
      const hit = W.collideCircle(c, c.def.radius, c.z);
      if (hit) {
        const vn = c.vx * hit.nx + c.vy * hit.ny;
        if (vn < 0) {
          c.vx -= 1.3 * vn * hit.nx; c.vy -= 1.3 * vn * hit.ny;
          c.vx *= 0.92; c.vy *= 0.92;
          if (-vn > 22) {
            const cdmg = (-vn - 22) * 0.45 / c.def.mass;
            if (this.isClient && c === this.player) c.crashAcc += cdmg;
            this.damage(c, cdmg, null, 'crash');
            Sound.play('clank', this.vol(c.x, c.y));
            if (c.isPlayer) this.shake = Math.min(1, this.shake + 0.3);
            for (let i = 0; i < 6; i++) this.particles.add({ type: 'spark', x: c.x - hit.nx * c.def.radius, y: c.y - hit.ny * c.def.radius, zAbs: c.z + 0.8, vx: rand(-12, 12), vy: rand(-12, 12), life: 0.3, max: 0.3, size: 0.15, color: '#ffd27a', add: true });
          }
        }
      }
      this.propCollide(c);
    }
    // Landen / an der Oberfläche bleiben (über scharfe Kuppen hebt das Auto ab)
    const g2 = W.groundAt(c.x, c.y, c.z);
    if (c.z < g2) {
      if (c.airT > 0.25 && (c.pitch || c.flipAcc)) this.landFlip(c);
      c.z = g2;
      const [s2x, s2y] = W.groundKind === 'roof' ? [0, 0] : W.slopeAt(c.x, c.y, c.z);
      const sv = s2x * c.vx + s2y * c.vy;
      if (c.vz < sv) c.vz = sv;
    } else if (c.onGround && c.z - g2 < 0.18 + 0.05 * moved) c.z = g2;
    else if (c.onGround) { if (c.vz > 3.5) c.vz = 3.5; c.airLock = 0.12; }   // über Kuppen nur sanft abheben (Federung)
    // Wasser
    if (surfWater) {
      c.sinkT += dt; c.vx *= 0.9; c.vy *= 0.9;
      if (Math.random() < 0.5) this.particles.add({ x: c.x + rand(-2, 2), y: c.y + rand(-2, 2), vx: rand(-3, 3), vy: rand(-3, 3), life: 0.7, max: 0.7, size: 0.6, grow: 2, color: '#cfe8ff', alpha: 0.7 });
      if (c.sinkT > 0.5) {
        if (this.isClient) { c.sunk = true; return; }
        Sound.play('splash', this.vol(c.x, c.y));
        this.kill(c, c.lastAttacker && c.lastAttackT > performance.now() - 5000 ? c.lastAttacker : null, 'water');
        return;
      }
    } else c.sinkT = 0;
    // Rauch bei Schaden
    if (c.hp < c.st.hp * 0.35) {
      c.smokeT -= dt;
      if (c.smokeT <= 0) {
        c.smokeT = c.hp < c.st.hp * 0.15 ? 0.05 : 0.12;
        this.particles.add({ x: c.x, y: c.y, zAbs: c.z + 1, vz: 2, vx: rand(-1, 1) + c.vx * 0.2, vy: rand(-1, 1) + c.vy * 0.2, life: 1.2, max: 1.2, size: 0.6, grow: 1.8, color: c.hp < c.st.hp * 0.15 ? '#2a2a2a' : '#666', alpha: 0.55 });
      }
    }
    this.dropMine(c, dt, playing);
  }
  // Landung nach Sprung: Saltos zählen, schiefe Landung bremst und kostet etwas Panzerung
  landFlip(c) {
    if (c.dodgeT > 0) { c.dodgeT = 0; c.pitch = 0; c.pitchV = 0; c.flipAcc = 0; return; }   // Ausweichsprung landet immer sauber
    const off = angNorm(c.pitch || 0), flips = Math.floor((Math.abs(c.flipAcc || 0) + 0.6) / (Math.PI * 2));
    if (Math.abs(off) > 1.0) {
      c.vx *= 0.35; c.vy *= 0.35;
      if (this.isClient && c === this.player) c.crashAcc += c.st.hp * 0.12;
      else this.damage(c, c.st.hp * 0.12, null, 'crash');
      Sound.play('clank', this.vol(c.x, c.y));
      if (c.isPlayer) { this.say('Bruchlandung!', '#ff8c7f', 1, false); this.shake = Math.min(1, this.shake + 0.5); }
    } else if (flips > 0) {
      const n = Math.min(flips, 3), txt = (c.flipAcc > 0 ? 'Rückwärtssalto' : 'Salto') + (n > 1 ? ' ×' + n : '') + '!';
      c.boost = Math.min(c.st.boost, c.boost + 0.8 * n);   // Salto füllt Nitro auf
      if (c.isPlayer) { this.say(txt + ' +Nitro', '#ffe66d', 1.2, false); Sound.play('pickup'); }
      if (this.isClient && c === this.player) { if (typeof Net !== 'undefined') Net.send({ t: 'flip', n }); }
      else this.addXp(c, 25 * n);
    }
    c.pitch = 0; c.pitchV = 0; c.flipAcc = 0;
  }
  dropMine(c, dt, playing) {
    c.mineCd = Math.max(0, c.mineCd - dt);
    if (c.mines < 3) { c.mineRegen += dt; if (c.mineRegen > 12) { c.mineRegen = 0; c.mines++; } }
    if (playing && !this.isClient && c.input.mine && c.mines > 0 && c.mineCd <= 0 && c.z <= c.groundZ + 0.3) {
      c.mines--; c.mineCd = 0.8;
      const fx = Math.cos(c.a), fy = Math.sin(c.a);
      this.mines.push({ x: c.x - fx * c.def.len * 0.7, y: c.y - fy * c.def.len * 0.7, z: c.groundZ, team: c.team, owner: c, arm: 0.9, life: 60 });
      Sound.play('mine');
    }
  }
  // Host: Auto eines Mitspielers – die Position meldet der Mitspieler selbst (keine Eingabeverzögerung)
  remoteMove(c, dt, playing) {
    c.protect = Math.max(0, c.protect - dt); c.flashT = Math.max(0, c.flashT - dt);
    const rs = c.rs;
    if (rs && rs.life === c.life) {
      const age = Math.min(0.25, (performance.now() - rs.t) / 1000);
      const tx = rs.x + rs.vx * age, ty = rs.y + rs.vy * age;
      const k = Math.min(1, dt * 15);
      if (Math.hypot(tx - c.x, ty - c.y) > 10) { c.x = tx; c.y = ty; }
      else { c.x += (tx - c.x) * k; c.y += (ty - c.y) * k; }
      c.z += (rs.z - c.z) * k; c.a += angNorm(rs.a - c.a) * k;
      c.vx = rs.vx; c.vy = rs.vy; c.vz = rs.vz; c.boosting = rs.b; c.pitch = rs.p;
      if (rs.cd > 0) { const d = rs.cd; rs.cd = 0; this.damage(c, d, null, 'crash'); }
      if (rs.w && c.alive) { Sound.play('splash', this.vol(c.x, c.y)); this.kill(c, c.lastAttacker && c.lastAttackT > performance.now() - 5000 ? c.lastAttacker : null, 'water'); return; }
    }
    c.groundZ = this.world.groundAt(c.x, c.y, c.z);
    c.groundKind = this.world.groundKind;
    c.onGround = c.z <= c.groundZ + 0.15;
    this.dropMine(c, dt, playing);
  }
  // Rückstoß für Autos, die ein Mitspieler selbst steuert
  kick(c, dvx, dvy, dvz, setVz) {
    if (c.remote) this.events.push(['kb', c.id, r1(dvx), r1(dvy), r1(dvz), setVz ? 1 : 0]);
    c.vx += dvx; c.vy += dvy; if (setVz) c.vz = dvz; else c.vz += dvz;
  }
  skid(c) {
    const fx = Math.cos(c.a), fy = Math.sin(c.a), px = -fy, py = fx;
    const bl = c.def.len * 0.35, bw = c.def.wid * 0.4;
    const L = { x: c.x - fx * bl + px * bw, y: c.y - fy * bl + py * bw }, R = { x: c.x - fx * bl - px * bw, y: c.y - fy * bl - py * bw };
    const last = c.lastSkid;
    if (last) {
      this.world.decal(c.x, c.y, 4, g => {
        g.strokeStyle = 'rgba(20,20,20,0.32)'; g.lineWidth = 0.45; g.lineCap = 'round';
        g.beginPath(); g.moveTo(last.L.x, last.L.y); g.lineTo(L.x, L.y); g.moveTo(last.R.x, last.R.y); g.lineTo(R.x, R.y); g.stroke();
      });
    }
    c.lastSkid = { L, R };
  }
  propCollide(c) {
    for (const p of this.props) {
      if (!p.alive || c.z > p.z + p.h || c.z + 1.6 < p.z) continue;
      const dx = c.x - p.x, dy = c.y - p.y;
      if (dx * dx + dy * dy > 16) continue;
      const ca = Math.cos(p.a), sa = Math.sin(p.a);
      const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
      const cu = clamp(u, -p.hw, p.hw), cv = clamp(v, -p.hh, p.hh);
      let nu = u - cu, nv = v - cv;
      const dd = Math.hypot(nu, nv), r = c.def.radius;
      if (dd >= r) continue;
      if (p.hp > 0 && c.speed > 7) { if (!this.isClient) { this.breakProp(p, c); c.vx *= 0.85; c.vy *= 0.85; } continue; }
      if (dd < 1e-4) { nu = u >= 0 ? 1 : -1; nv = 0; } else { nu /= dd; nv /= dd; }
      const nx = nu * ca - nv * sa, ny = nu * sa + nv * ca;
      c.x += nx * (r - dd); c.y += ny * (r - dd);
      const vn = c.vx * nx + c.vy * ny;
      if (vn < 0) { c.vx -= 1.2 * vn * nx; c.vy -= 1.2 * vn * ny; }
    }
  }
  breakProp(p, by) {
    if (this.isClient) return;
    if (this.isHost) this.events.push(['k', this.props.indexOf(p), by ? by.id : 0]);
    p.alive = false; p.respawnT = 45;
    this.breakPropFx(p, by);
    // Zufallsbelohnung in Kisten
    if (Math.random() < 0.35) this.pickups.push({ x: p.x, y: p.y, t: Math.random() < 0.5 ? 0 : 2, active: true, t2: 0, temp: 15 });
  }
  breakPropFx(p, by) {
    Sound.play('crate', this.vol(p.x, p.y));
    for (let i = 0; i < 14; i++) this.particles.add({ type: 'debris', x: p.x, y: p.y, z: 0.5, vz: rand(3, 9), g: 25, vx: rand(-9, 9) + (by ? by.vx * 0.4 : 0), vy: rand(-9, 9) + (by ? by.vy * 0.4 : 0), life: 1.4, max: 1.4, size: rand(0.4, 0.9), color: i % 2 ? p.col : p.top, rot: rand(0, 6), vr: rand(-10, 10), fade: false });
  }
  carCollisions() {
    const C = this.cars;
    for (let i = 0; i < C.length; i++) {
      const a = C[i]; if (!a.alive) continue;
      for (let j = i + 1; j < C.length; j++) {
        const b = C[j]; if (!b.alive) continue;
        const dx = b.x - a.x, dy = b.y - a.y, rr = a.def.radius + b.def.radius;
        const dd2 = dx * dx + dy * dy;
        if (dd2 >= rr * rr) continue;
        const dz = a.z - b.z;
        // Draufspringen
        if (Math.abs(dz) > 1.2) {
          const top = dz > 0 ? a : b, bot = dz > 0 ? b : a;
          if (Math.abs(dz) < 2.6 && top.vz < -4 && top.team !== bot.team) {
            this.damage(bot, 30 + 18 * top.def.mass, top, 'stomp');
            this.kick(top, 0, 0, 7, true);
            this.boom(bot.x, bot.y, 0.6, false);
            if (top.isPlayer) this.say('PLATTGEMACHT!', '#ffb14d', 1.2, false);
          }
          continue;
        }
        const d = Math.sqrt(dd2) || 0.01, nx = dx / d, ny = dy / d, pen = rr - d;
        const ma = a.def.mass, mb = b.def.mass, tot = ma + mb;
        a.x -= nx * pen * mb / tot; a.y -= ny * pen * mb / tot;
        b.x += nx * pen * ma / tot; b.y += ny * pen * ma / tot;
        const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rv < 0) {
          const jimp = -(1.4) * rv / (1 / ma + 1 / mb);
          a.vx -= jimp * nx / ma; a.vy -= jimp * ny / ma;
          b.vx += jimp * nx / mb; b.vy += jimp * ny / mb;
          if (-rv > 9 && a.team !== b.team) {
            const dmg = (-rv - 9) * 2.2;
            this.damage(a, dmg * mb / ma, b, 'ram'); this.damage(b, dmg * ma / mb, a, 'ram');
            Sound.play('clank', this.vol(a.x, a.y));
          }
        }
      }
    }
  }

  // ---------------- Waffen ----------------
  weapons(c, dt) {
    const inp = c.input;
    const turnRate = c.human ? 40 : 7;
    const diff = angNorm(inp.aim - c.turret);
    c.turret += clamp(diff, -turnRate * dt, turnRate * dt);
    const pw = clamp(inp.pitch || 0, -0.6, 0.9);
    c.tpitch = (c.tpitch || 0) + clamp(pw - (c.tpitch || 0), -turnRate * 0.5 * dt, turnRate * 0.5 * dt);
    c.fireCd -= dt;
    if (inp.fire && c.fireCd <= 0 && c.alive) {
      c.fireCd = 1 / c.st.rate;
      this.fire(c);
    }
  }
  fire(c) {
    const w = c.w;
    const sh = c.shape;
    const px = c.x + Math.cos(c.a) * sh.turret, py = c.y + Math.sin(c.a) * sh.turret;
    const bl = w === WEAPONS.cannon ? 3 : 2;
    const mx = px + Math.cos(c.turret) * bl, my = py + Math.sin(c.turret) * bl;
    const pt = c.tpitch || 0, cp = Math.cos(pt);
    for (let i = 0; i < w.count; i++) {
      const ang = c.turret + (Math.random() - 0.5) * 2 * w.spread;
      const sp = w.speed * (w.count > 1 ? rand(0.85, 1.1) : 1);
      const bl = {
        x: mx, y: my, z: c.z + 1.1 + Math.sin(pt) * 1.2, vz: Math.abs(pt) > 0.03 ? Math.sin(pt + (Math.random() - 0.5) * w.spread) * sp : 0,
        vx: Math.cos(ang) * sp * cp + c.vx * 0.35, vy: Math.sin(ang) * sp * cp + c.vy * 0.35,
        life: w.life * (w.count > 1 ? rand(0.8, 1.1) : 1), dmg: c.st.dmg, owner: c, team: c.team, w, cosmetic: this.isClient,
      };
      this.bullets.push(bl);
      if (this.isHost) this.events.push(['s', c.id, r2(bl.x), r2(bl.y), r2(bl.z), r1(bl.vx), r1(bl.vy), r2(bl.life), c.def.weapon, r1(bl.vz)]);
    }
    Sound.play(w.sound, this.vol(c.x, c.y) * (c.isPlayer ? 1 : 0.7));
    this.particles.add({ x: mx, y: my, vx: c.vx, vy: c.vy, life: 0.06, max: 0.06, size: w.splash ? 1.4 : 0.7, color: '#ffe9a8', add: true });
    if (w.splash) {
      c.vx -= Math.cos(c.turret) * 2.5 / c.def.mass; c.vy -= Math.sin(c.turret) * 2.5 / c.def.mass;
      for (let i = 0; i < 4; i++) this.particles.add({ x: mx, y: my, vx: Math.cos(c.turret) * 4 + rand(-2, 2), vy: Math.sin(c.turret) * 4 + rand(-2, 2), life: 0.6, max: 0.6, size: 0.6, grow: 2, color: '#999', alpha: 0.5, drag: 3 });
    }
    if (c.isPlayer && w.splash) this.shake = Math.min(1, this.shake + 0.15);
  }
  updateBullets(dt) {
    const W = this.world;
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i];
      let dead = false;
      b.life -= dt;
      // Raketen: Zielsuche + Beschleunigung
      if (b.w.homing) {
        const sp = Math.hypot(b.vx, b.vy);
        const nsp = Math.min(sp + b.w.accel * dt, b.w.maxSpeed || 70);
        let ang = Math.atan2(b.vy, b.vx);
        let best = null, bd = 32 * 32;
        for (const o of this.cars) {
          // nur Ziele in einem schmalen Kegel vorne; wer springt oder fliegt, ist schwer zu verfolgen
          if (!o.alive || o.team === b.team || o.z - b.z > 2.5) continue;
          const dd = d2(b.x, b.y, o.x, o.y);
          if (dd < bd && Math.abs(angNorm(Math.atan2(o.y - b.y, o.x - b.x) - ang)) < 0.35) { bd = dd; best = o; }
        }
        if (best) ang += clamp(angNorm(Math.atan2(best.y - b.y, best.x - b.x) - ang), -b.w.homing * dt, b.w.homing * dt);
        b.vx = Math.cos(ang) * nsp; b.vy = Math.sin(ang) * nsp;
        if (Math.random() < 0.8) this.particles.add({ x: b.x, y: b.y, vx: rand(-1, 1), vy: rand(-1, 1), life: 0.5, max: 0.5, size: 0.35, grow: 1.6, color: '#bbb', alpha: 0.45 });
      }
      const ox = b.x, oy = b.y;
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.w === WEAPONS.cannon) b.z -= dt * 0.4;
      // flache Hänge: Geschoss folgt dem Boden, steile Hänge/Wände treffen
      const gb = W.groundAt(b.x, b.y, b.z);
      if (b.vz) {
        b.z += b.vz * dt;
        if (b.z < gb + 0.1) {   // schräg nach unten: schlägt am Boden ein
          b.z = gb + 0.2;
          if (b.w.splash) this.explode(b);
          else this.particles.add({ type: 'spark', x: b.x, y: b.y, zAbs: b.z, vx: rand(-5, 5), vy: rand(-5, 5), life: 0.18, max: 0.18, size: 0.12, color: '#ffe8a0', add: true });
          this.bullets[i] = this.bullets[this.bullets.length - 1]; this.bullets.pop(); continue;
        }
      } else if (b.z < gb + 0.35 && gb - (b.gPrev === undefined ? gb : b.gPrev) < 1.0) b.z = gb + 0.5;
      b.gPrev = gb;
      // Autos
      for (const c of this.cars) {
        if (!c.alive || c.team === b.team) continue;
        if (Math.abs(b.z - (c.z + 0.9)) > 1.9) continue;
        const rx = c.x - ox, ry = c.y - oy, sx = b.x - ox, sy = b.y - oy;
        const l2 = sx * sx + sy * sy || 1;
        const t = clamp((rx * sx + ry * sy) / l2, 0, 1);
        const qx = ox + sx * t, qy = oy + sy * t;
        const r = c.def.radius + b.w.size;
        if (d2(qx, qy, c.x, c.y) < r * r) {
          b.x = qx; b.y = qy;
          if (b.w.splash) this.explode(b);
          else {
            this.damage(c, b.dmg, b.owner, 'shot');
            this.particles.add({ type: 'spark', x: qx, y: qy, vx: -b.vx * 0.1 + rand(-6, 6), vy: -b.vy * 0.1 + rand(-6, 6), life: 0.2, max: 0.2, size: 0.15, color: '#fff3b0', add: true });
          }
          dead = true; break;
        }
      }
      // Kisten
      if (!dead) for (const p of this.props) {
        if (!p.alive || b.z > p.z + p.h + 0.4 || b.z < p.z - 0.5) continue;
        const dx = b.x - p.x, dy = b.y - p.y;
        if (dx * dx + dy * dy > 9) continue;
        const ca = Math.cos(p.a), sa = Math.sin(p.a);
        const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
        if (Math.abs(u) < p.hw + 0.2 && Math.abs(v) < p.hh + 0.2) {
          if (b.w.splash) this.explode(b);
          else if (p.hp > 0) { p.hpNow -= b.dmg; if (p.hpNow <= 0) this.breakProp(p, null); }
          this.particles.add({ type: 'spark', x: b.x, y: b.y, vx: rand(-5, 5), vy: rand(-5, 5), life: 0.15, max: 0.15, size: 0.12, color: '#ffe', add: true });
          dead = true; break;
        }
      }
      // Gebäude
      if (!dead && W.solidAt(b.x, b.y, b.z)) {
        if (b.w.splash) { b.x = ox; b.y = oy; this.explode(b); }
        else {
          for (let k = 0; k < 3; k++) this.particles.add({ type: 'spark', x: ox, y: oy, vx: -b.vx * 0.08 + rand(-5, 5), vy: -b.vy * 0.08 + rand(-5, 5), life: 0.18, max: 0.18, size: 0.12, color: '#ffe8a0', add: true });
          this.particles.add({ x: ox, y: oy, vx: 0, vy: 0, life: 0.4, max: 0.4, size: 0.3, grow: 1.5, color: '#bbb', alpha: 0.4 });
        }
        dead = true;
      }
      if (!dead && b.life <= 0) { if (b.w.splash) this.explode(b); dead = true; }
      if (dead) { this.bullets[i] = this.bullets[this.bullets.length - 1]; this.bullets.pop(); }
    }
  }
  explode(b) {
    if (this.isClient) return;
    const R = b.w.splash;
    this.boom(b.x, b.y, R / 4.5, true);
    for (const c of this.cars) {
      if (!c.alive || c.team === b.team) continue;
      const dd = Math.sqrt(d2(b.x, b.y, c.x, c.y));
      if (dd > R + c.def.radius || Math.abs(c.z - b.z) > R) continue;
      const f = clamp(1 - Math.max(0, dd - c.def.radius) / R, 0.25, 1);
      this.damage(c, b.dmg * f, b.owner, 'boom');
      const nx = (c.x - b.x) / (dd || 1), ny = (c.y - b.y) / (dd || 1);
      this.kick(c, nx * 8 * f / c.def.mass, ny * 8 * f / c.def.mass, 4 * f / c.def.mass, false);
    }
    for (const p of this.props) if (p.alive && p.hp > 0 && d2(b.x, b.y, p.x, p.y) < (R + 1) ** 2) this.breakProp(p, null);
  }
  boom(x, y, scale = 1, sound = true) {
    if (this.isHost) this.events.push(['b', r1(x), r1(y), r2(scale), sound ? 1 : 0]);
    if (sound) Sound.play(scale > 1.2 ? 'bigboom' : 'boom', this.vol(x, y));
    const P = this.particles;
    P.add({ x, y, vx: 0, vy: 0, life: 0.15, max: 0.15, size: 4 * scale, color: '#fff7d6', add: true });
    P.add({ type: 'ring', x, y, vx: 0, vy: 0, life: 0.35, max: 0.35, size: 1, grow: 22 * scale, color: '#ffe2a6', alpha: 0.8 });
    for (let i = 0; i < 16 * scale; i++) {
      const a = rand(0, 6.3), s = rand(2, 11) * scale;
      P.add({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.3, 0.7), max: 0.7, size: rand(0.8, 1.6) * scale, grow: 1, color: pick(['#ffb347', '#ff7b39', '#ffd36b', '#ff5a2a']), add: true, drag: 3 });
    }
    for (let i = 0; i < 10 * scale; i++) {
      const a = rand(0, 6.3), s = rand(1, 5) * scale;
      P.add({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: rand(0.8, 1.6), max: 1.6, size: rand(1, 1.8) * scale, grow: 2.2, color: pick(['#555', '#444', '#666']), alpha: 0.55, drag: 2 });
    }
    for (let i = 0; i < 8 * scale; i++) P.add({ type: 'spark', x, y, vx: rand(-25, 25), vy: rand(-25, 25), life: 0.35, max: 0.35, size: 0.18, color: '#ffe9a0', add: true, drag: 2 });
    this.world.decal(x, y, 4 * scale, g => {
      const gr = g.createRadialGradient(x, y, 0, x, y, 3.2 * scale);
      gr.addColorStop(0, 'rgba(15,12,10,0.55)'); gr.addColorStop(1, 'rgba(15,12,10,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, 3.2 * scale, 0, 7); g.fill();
    });
    const dd = Math.sqrt(d2(x, y, this.cam.x, this.cam.y));
    this.shake = Math.min(1.2, this.shake + clamp(1 - dd / 60, 0, 1) * 0.5 * scale);
  }
  damage(c, amt, by, kind) {
    if (this.isClient) return;
    if (!c.alive || c.protect > 0 || amt <= 0 || this.state === 'over') return;
    if (c.flag >= 0) amt *= 0.7;   // Flaggenträger halten etwas mehr aus (große Karte)
    c.hp -= amt; c.flashT = 0.08;
    if (by && by !== c) { c.hitBy.set(by, performance.now()); c.lastAttacker = by; c.lastAttackT = performance.now(); }
    if (c.bot) c.bot.hurtT = 1.2;
    if (by && kind !== 'crash' && by !== c) {
      if (by.isPlayer) this.hitFx(c, amt);
      else if (by.remote) this.events.push(['h', by.id, c.id, r1(amt)]);
    }
    if (c.isPlayer) this.shake = Math.min(1, this.shake + amt / 120);
    if (c.hp <= 0) {
      if (!by || by === c) { const la = c.lastAttacker; if (la && performance.now() - c.lastAttackT < 4000) by = la; }
      this.kill(c, by && by !== c ? by : null, kind);
    }
  }
  kill(c, by, kind) {
    if (this.isClient || !c.alive) return;
    c.alive = false; c.hp = 0; c.deaths++;
    c.respawnT = 3.5;
    c.killedBy = by;
    this.boom(c.x, c.y, 1.5, true);
    for (let i = 0; i < 10; i++) this.particles.add({ type: 'debris', x: c.x, y: c.y, z: 1, vz: rand(4, 12), g: 25, vx: rand(-12, 12), vy: rand(-12, 12), life: 2, max: 2, size: rand(0.5, 1.1), color: i % 3 ? TEAM[c.team].dark : '#333', rot: rand(0, 6), vr: rand(-12, 12), fade: false });
    this.dropFlag(c, kind === 'water');
    if (by) {
      by.kills++; by.score += 10;
      if (by.human) this.earn(REWARD.kill, c.x, c.y, '', by);
      this.addXp(by, XP.kill);
      const now = performance.now();
      for (const [o, t] of c.hitBy) {
        if (o !== by && o.alive !== undefined && o.team !== c.team && now - t < 6000) { o.assists++; o.score += 4; if (o.human) this.earn(REWARD.assist, c.x, c.y, 'Assist', o); this.addXp(o, XP.assist); }
      }
    }
    this.log({ a: by, b: c, kind });
    if (c.isPlayer) Sound.engineStop();
  }

  updateMines(dt) {
    for (let i = this.mines.length - 1; i >= 0; i--) {
      const m = this.mines[i];
      m.arm -= dt; m.life -= dt;
      let boom = m.life <= 0;
      if (m.arm <= 0 && !boom) {
        for (const c of this.cars) {
          if (!c.alive || c.team === m.team || c.z > c.groundZ + 1.0 || Math.abs(c.groundZ - (m.z || 0)) > 1.5) continue;
          if (d2(c.x, c.y, m.x, m.y) < 2.4 * 2.4) { boom = true; break; }
        }
      }
      if (boom) {
        this.mines.splice(i, 1);
        this.explode({ x: m.x, y: m.y, z: (m.z || 0) + 0.3, team: m.team, owner: m.owner, dmg: 55, w: { splash: 4.5 } });
      }
    }
  }

  // ---------------- Flaggen ----------------
  dropFlag(c, toBase) {
    if (c.flag < 0) return;
    const f = this.flags[c.flag];
    c.flag = -1;
    const W = this.world;
    const fwz = W.waterAt(c.x, c.y);
    if (toBase || (fwz !== null && c.z < fwz + 1.5) || c.groundKind === 'roof' || W.nav[W.navIdx(c.x, c.y)] && W.solid[W.navIdx(c.x, c.y)]) {
      this.resetFlag(f, true);
    } else {
      f.state = 'dropped'; f.x = c.x; f.y = c.y; f.z = c.groundZ; f.carrier = null; f.dropT = 25;
      this.log({ text: 'hat die Flagge verloren', a: c, flagTeam: f.team });
    }
  }
  resetFlag(f, msg) {
    const b = this.world.bases[f.team];
    f.state = 'base'; f.x = b.x; f.y = b.y; f.z = this.world.terrain(b.x, b.y); f.carrier = null;
    if (msg) this.log({ text: 'Flagge ist zurück in der Basis', flagTeam: f.team });
  }
  updateFlags(dt) {
    if (this.state !== 'play') return;
    const bases = this.world.bases;
    for (const f of this.flags) {
      if (f.state === 'carried') { f.x = f.carrier.x; f.y = f.carrier.y; f.z = f.carrier.z; }
      if (f.state === 'dropped') { f.dropT -= dt; if (f.dropT <= 0) this.resetFlag(f, true); }
    }
    for (const c of this.cars) {
      if (!c.alive || c.z > c.groundZ + 3) continue;
      for (const f of this.flags) {
        if (f.state === 'carried') continue;
        if (d2(c.x, c.y, f.x, f.y) > 3.8 * 3.8 || Math.abs(c.z - f.z) > 4) continue;
        if (f.team !== c.team && c.flag < 0) {
          f.state = 'carried'; f.carrier = c; c.flag = f.team;
          c.score += 3;
          this.log({ text: 'hat die Flagge geklaut!', a: c, flagTeam: f.team, fx: 'pick' });
          if (c.human) this.earn(REWARD.pickup, c.x, c.y, '', c);
          this.addXp(c, XP.pickup);
        } else if (f.team === c.team && f.state === 'dropped') {
          this.resetFlag(f, false);
          c.returns++; c.score += 5;
          this.log({ text: 'hat die Flagge zurückgeholt', a: c, flagTeam: f.team, fx: 'ret' });
          if (c.human) this.earn(REWARD.ret, c.x, c.y, 'Rettung', c);
          this.addXp(c, XP.ret);
        }
      }
      if (c.flag >= 0 && this.flags[c.team].state === 'base' && d2(c.x, c.y, bases[c.team].x, bases[c.team].y) < 9 * 9) {
        const f = this.flags[c.flag];
        c.flag = -1; this.resetFlag(f, false);
        this.score[c.team]++; c.caps++; c.score += 25;
        this.log({ text: 'hat gepunktet! 🏁', a: c, flagTeam: f.team, cap: true, fx: 'cap' });
        if (c.human) this.earn(REWARD.capture, c.x, c.y, 'Punkt!', c);
        this.addXp(c, XP.capture);
        if (this.score[c.team] >= this.opts.capLimit) this.endGame();
      }
    }
  }
  updatePickups(dt) {
    for (const p of this.props) if (!p.alive) {
      p.respawnT -= dt;
      if (p.respawnT <= 0 && !this.cars.some(c => c.alive && d2(c.x, c.y, p.x, p.y) < 36)) { p.alive = true; p.hpNow = p.hp; }
    }
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      if (p.temp !== undefined) { p.temp -= dt; if (p.temp <= 0) { this.pickups.splice(i, 1); continue; } }
      if (!p.active) { p.t2 -= dt; if (p.t2 <= 0) p.active = true; continue; }
      for (const c of this.cars) {
        if (!c.alive || c.z > c.groundZ + 2.5 || Math.abs(c.z - (p.z || 0)) > 3 || d2(c.x, c.y, p.x, p.y) > 2.8 * 2.8) continue;
        if (p.t === 0 && c.hp >= c.st.hp) continue;
        if (p.t === 2 && !c.human) continue;
        if (p.t === 0) c.hp = Math.min(c.st.hp, c.hp + c.st.hp * 0.45);
        else if (p.t === 1) { c.boost = c.st.boost; c.mines = Math.min(3, c.mines + 1); }
        else this.earn(60, p.x, p.y, '', c);
        this.pickupFx(c, p.t);
        if (this.isHost) this.events.push(['p', c.id, p.t]);
        if (p.temp !== undefined) { this.pickups.splice(i, 1); }
        else { p.active = false; p.t2 = 20; }
        break;
      }
    }
  }

  endGame() {
    if (this.state === 'over') return;
    this.state = 'over';
    const me = this.player.team, s = this.score;
    const res = s[me] > s[1 - me] ? 'win' : s[me] < s[1 - me] ? 'lose' : 'draw';
    this.earned += REWARD[res];
    this.result = res;
    this.say(res === 'win' ? 'SIEG!' : res === 'lose' ? 'NIEDERLAGE' : 'UNENTSCHIEDEN', res === 'win' ? '#7dff8a' : res === 'lose' ? '#ff8c7f' : '#fff', 3);
    Sound.play(res === 'win' ? 'capture' : 'lost');
    setTimeout(() => { if (this.onEnd) this.onEnd(res); }, 2600);
  }

  // ---------------- Netzwerk (Host) ----------------
  netTick() {
    this.netT = (this.netT || 0) + 1;
    if (this.netT % 3) return; // 20 Zustände pro Sekunde
    this.netSeq = (this.netSeq || 0) + 1;
    const snap = {
      t: 's', n: this.netSeq, st: this.state, tm: r1(this.time), ct: r2(this.countT), sc: this.score,
      c: this.cars.map(c => [c.id, r2(c.x), r2(c.y), r2(c.a), r2(c.turret), r2(c.z), r1(c.vx), r1(c.vy), Math.ceil(c.hp), c.alive ? 1 : 0, c.flag,
        c.boosting ? 1 : 0, c.protect > 0 ? 1 : 0, r1(c.respawnT), c.kills, c.deaths, c.caps, c.returns, c.score, c.earned, c.mines, r2(c.boost),
        c.killedBy ? c.killedBy.id : 0, r1(c.vz), c.life, c.xp, c.pts, '' + c.ups.spd + c.ups.arm + c.ups.dmg, r2(c.pitch || 0), r2(c.tpitch || 0)]),
      f: this.flags.map(f => [f.state, r1(f.x), r1(f.y), f.carrier ? f.carrier.id : 0, r1(f.dropT), r1(f.z)]),
      pr: this.props.map(p => (p.alive ? 1 : 0)).join(''),
      pk: this.pickups.map(p => [r1(p.x), r1(p.y), p.t, p.active ? 1 : 0]),
      m: this.mines.map(m => [r1(m.x), r1(m.y), m.team, m.arm > 0 ? 0 : 1, r1(m.z || 0)]),
      ev: this.events,
    };
    this.events = [];
    if (typeof Net !== 'undefined') Net.broadcast(snap);
  }
  // Mitspieler meldet Position + Eingaben
  remoteInput(key, d) {
    const c = this.cars.find(o => o.key === key);
    if (!c || !c.human) return;
    if (d.t === 'up') { this.applyUp(c, String(d.k)); return; }
    if (d.t === 'flip') { this.addXp(c, 25 * clamp(+d.n || 0, 0, 3)); return; }
    if (d.t !== 'st') return;
    const num = (v, a, b) => { v = +v; return Number.isFinite(v) ? clamp(v, a, b) : 0; };
    const i = c.input;
    i.aim = num(d.tu, -10, 10); i.pitch = num(d.tp, -1, 1); i.fire = !!d.f; i.mine = !!d.m; i.boost = !!d.b; i.thr = 0; i.steer = 0;
    if (!c.alive || d.l !== c.life) return;
    const old = c.rs;
    c.rs = {
      x: num(d.x, 0, this.world.w), y: num(d.y, 0, this.world.h), a: num(d.a, -100, 100), vx: num(d.vx, -80, 80), vy: num(d.vy, -80, 80),
      z: num(d.z, -20, 160), vz: num(d.vz, -80, 80), p: num(d.p, -100, 100), b: !!d.b, w: !!d.w || !!(old && old.w), cd: num(d.cd, 0, 200) + (old ? old.cd : 0), life: d.l, t: performance.now(),
    };
  }
  // Spieler hat die Verbindung verloren -> Bot übernimmt
  dropHuman(key) {
    const c = this.cars.find(o => o.key === key);
    if (!c || !c.human) return;
    c.human = false; c.remote = false; c.bot = newBotState('attack'); c.key = 'bot' + c.id; c.rs = null; c.wasName = c.name;
    this.events.push(['rj', this.rosterEntry(c)]);
    this.log({ text: 'hat das Spiel verlassen (Bot übernimmt)', a: c, flagTeam: c.team });
  }

  // ---------------- Netzwerk (Client) ----------------
  clientUpdate(dt) {
    const me = this.player;
    this.readPlayerInput(); this.showBoard = !!Input.keys.Tab;
    const playing = this.state === 'play';
    // eigene Position + Eingaben an den Host (direkt 30x/s, über Server 12x/s)
    this.sendT = (this.sendT || 0) + 1;
    const every = typeof Net !== 'undefined' && Net.linkMode === 'relay' ? 5 : 2;
    if (this.sendT % every === 0 && typeof Net !== 'undefined' && me.alive) {
      const i = me.input;
      Net.send({ t: 'st', l: me.life, x: r2(me.x), y: r2(me.y), a: r2(me.a), vx: r1(me.vx), vy: r1(me.vy), z: r2(me.z), vz: r1(me.vz),
        tu: r2(i.aim), tp: r2(i.pitch || 0), f: i.fire ? 1 : 0, m: i.mine ? 1 : 0, b: me.boosting ? 1 : 0, w: me.sunk ? 1 : 0, cd: r1(me.crashAcc), p: r2(me.pitch || 0) });
      me.crashAcc = 0;
    }
    // eigenes Auto lokal vorhersagen
    if (me.alive && this.state !== 'over') {
      if (playing) this.weapons(me, dt); else me.input.fire = false;
      this.physics(me, dt, playing);
      for (const o of this.cars) {
        if (o === me || !o.alive || Math.abs(o.z - me.z) > 1.2) continue;
        const dx = me.x - o.x, dy = me.y - o.y, rr = me.def.radius + o.def.radius, dd = Math.hypot(dx, dy);
        if (dd >= rr || dd < 1e-4) continue;
        const nx = dx / dd, ny = dy / dd;
        me.x = o.x + nx * rr; me.y = o.y + ny * rr;
        const vn = me.vx * nx + me.vy * ny;
        if (vn < 0) { me.vx -= 1.2 * vn * nx; me.vy -= 1.2 * vn * ny; }
      }
    }
    // andere Autos glätten
    const now = performance.now();
    for (const c of this.cars) {
      if (c === me || !c.net || !c.alive) continue;
      const n = c.net, age = Math.min(0.25, (now - n.t) / 1000);
      const px = n.x + n.vx * age, py = n.y + n.vy * age;
      const k = Math.min(1, dt * 14);
      if (Math.hypot(px - c.x, py - c.y) > 12) { c.x = px; c.y = py; }
      else { c.x += (px - c.x) * k; c.y += (py - c.y) * k; }
      c.z += (n.z - c.z) * k; c.a += angNorm(n.a - c.a) * k; c.turret += angNorm(n.tu - c.turret) * k;
      c.flashT = Math.max(0, c.flashT - dt);
      if (c.boosting && Math.random() < 0.6) {
        const fx = Math.cos(c.a), fy = Math.sin(c.a);
        this.particles.add({ x: c.x - fx * c.def.len * 0.55, y: c.y - fy * c.def.len * 0.55, vx: -fx * 10 + rand(-2, 2), vy: -fy * 10 + rand(-2, 2), life: 0.25, max: 0.25, size: 0.6, grow: -1.5, color: Math.random() < 0.5 ? '#7ad7ff' : '#ffffff', add: true });
      }
      if (c.hp < c.st.hp * 0.35 && Math.random() < 0.15) this.particles.add({ x: c.x, y: c.y, zAbs: c.z + 1, vz: 2, vx: rand(-1, 1), vy: rand(-1, 1), life: 1.2, max: 1.2, size: 0.6, grow: 1.8, color: '#555', alpha: 0.55 });
    }
    this.updateBullets(dt);
    // Ping
    this.pingT = (this.pingT || 0) - dt;
    if (this.pingT <= 0 && typeof Net !== 'undefined') { this.pingT = 1; Net.send({ t: 'ping', ts: performance.now() }); }
  }
  onPong(ts) { const r = (performance.now() - ts) / 1000; this.rtt = this.rtt * 0.7 + r * 0.3; }
  applySnapshot(s) {
    const now = performance.now(), me = this.player;
    if (s.n) { if (s.n <= (this.lastSeq || 0)) return; this.lastSeq = s.n; }  // veraltete Pakete verwerfen
    const prev = this.state;
    this.time = s.tm; this.score = s.sc; this.countT = s.ct;
    if (s.st === 'countdown') {
      const c = Math.ceil(s.ct);
      if (c < this.lastCount && c > 0) { this.lastCount = c; Sound.play('countdown'); this.say(String(c), '#ffe66d', 0.9); }
    }
    if (prev === 'countdown' && s.st === 'play') { Sound.play('go'); this.say('LOS! Hol dir die Flagge!', '#7dff8a', 1.6); }
    if (s.st === 'over' && prev !== 'over') this.clientEnd(); else if (prev !== 'over') this.state = s.st;
    for (const a of s.c) {
      const c = this.byId.get(a[0]); if (!c) continue;
      const wasAlive = c.alive, oldHp = c.hp;
      c.hp = a[8]; c.alive = !!a[9]; c.flag = a[10]; c.protect = a[12] ? 1 : 0; c.respawnT = a[13];
      c.kills = a[14]; c.deaths = a[15]; c.caps = a[16]; c.returns = a[17]; c.score = a[18]; c.earned = a[19]; c.mines = a[20];
      c.killedBy = a[22] ? this.byId.get(a[22]) : null;
      c.xp = a[25] || 0;
      if (a[27] !== undefined) {
        const u = String(a[27]);
        const nu = { spd: +u[0] || 0, arm: +u[1] || 0, dmg: +u[2] || 0 };
        // eigene, gerade gewählte Upgrades nicht vom alten Stand überschreiben lassen
        const mine = c === me && (nu.spd + nu.arm + nu.dmg) < (c.ups.spd + c.ups.arm + c.ups.dmg) && now - (this.upT || 0) < 1500;
        if (!mine && (nu.spd !== c.ups.spd || nu.arm !== c.ups.arm || nu.dmg !== c.ups.dmg)) { c.ups = nu; const hp = c.hp; c.recalc(); c.hp = hp; }
        if (!mine) c.pts = a[26] || 0;
      }
      if (c.alive && c.hp < oldHp - 0.5) c.flashT = 0.08;
      if (c === me) {
        // Die eigene Position bestimmt der Spieler selbst – nur beim Neustart übernimmt er die vom Host
        if (c.alive && (a[24] !== c.life || !wasAlive)) {
          c.x = a[1]; c.y = a[2]; c.a = a[3]; c.turret = a[4]; c.z = a[5]; c.vx = a[6]; c.vy = a[7]; c.vz = a[23];
          c.life = a[24]; c.sunk = false; c.crashAcc = 0; c.boost = c.st.boost; c.steerS = 0; c.jumpCd = 0;
          this.camYaw = c.a;
        }
        if (wasAlive && !c.alive) Sound.engineStop();
        this.earned = c.earned + (this.endBonus || 0);
      } else {
        c.net = { x: a[1], y: a[2], a: a[3], tu: a[4], z: a[5], vx: a[6], vy: a[7], t: now };
        if (!wasAlive && c.alive) { c.x = a[1]; c.y = a[2]; c.a = a[3]; c.turret = a[4]; c.z = a[5]; }
        c.vx = a[6]; c.vy = a[7]; c.boosting = !!a[11]; c.pitch = a[28] || 0; c.tpitch = a[29] || 0;
      }
    }
    s.f.forEach((a, i) => { const f = this.flags[i]; f.state = a[0]; f.x = a[1]; f.y = a[2]; f.carrier = a[3] ? this.byId.get(a[3]) : null; f.dropT = a[4]; f.z = a[5] !== undefined ? a[5] : this.world.terrain(f.x, f.y); });
    for (let i = 0; i < this.props.length; i++) {
      const alive = s.pr[i] === '1', p = this.props[i];
      if (p.alive && !alive) this.breakPropFx(p, null);
      p.alive = alive;
    }
    this.pickups = s.pk.map(a => ({ x: a[0], y: a[1], z: this.world.terrain(a[0], a[1]), t: a[2], active: !!a[3] }));
    this.mines = s.m.map(a => ({ x: a[0], y: a[1], z: a[4] !== undefined ? a[4] : this.world.terrain(a[0], a[1]), team: a[2], arm: a[3] ? 0 : 1 }));
    if (s.ev) this.applyEvents(s.ev);
    if (this.state === 'over') this.earned = me.earned + (this.endBonus || 0);
  }
  applyEvents(list) {
    const me = this.player;
    for (const e of list) {
      const o = this.byId.get(e[1]);
      switch (e[0]) {
        case 's': {
          if (!o || o === me) break;
          const w = WEAPONS[e[8]];
          this.bullets.push({ x: e[2], y: e[3], z: e[4], vx: e[5], vy: e[6], vz: e[9] || 0, life: e[7], w, owner: o, team: o.team, dmg: 0, cosmetic: true });
          Sound.play(w.sound, this.vol(e[2], e[3]) * 0.7);
          this.particles.add({ x: e[2], y: e[3], vx: 0, vy: 0, life: 0.06, max: 0.06, size: w.splash ? 1.4 : 0.7, color: '#ffe9a8', add: true });
          break;
        }
        case 'b': this.boom(e[1], e[2], e[3], !!e[4]); break;
        case 'rj': { const r = e[1]; if (r && typeof r === 'object' && r.key !== this.me) this.putCar(r); break; }
        case 'l': {
          const d = e[1];
          this.log({ kind: d.kind, text: d.text, flagTeam: d.flagTeam, cap: d.cap, fx: d.fx, a: d.a ? this.byId.get(d.a) : null, b: d.b ? this.byId.get(d.b) : null });
          break;
        }
        case 'e': if (o === me) this.earnFx(e[2], e[3], e[4], e[5]); break;
        case 'p': if (o) { this.pickupFx(o, e[2]); if (o === me && e[2] === 1) me.boost = me.st.boost; } break;
        case 'h': if (o === me) { const t = this.byId.get(e[2]); if (t) this.hitFx(t, e[3]); } break;
        case 'kb': if (o === me && me.alive) { me.vx += e[2]; me.vy += e[3]; if (e[5]) me.vz = e[4]; else me.vz += e[4]; me.onGround = false; } break;
        case 'k': { const p = this.props[e[1]]; if (p && p.alive) { p.alive = false; this.breakPropFx(p, this.byId.get(e[2])); } break; }
      }
    }
  }
  clientEnd() {
    this.state = 'over';
    const me = this.player.team, s = this.score;
    const res = s[me] > s[1 - me] ? 'win' : s[me] < s[1 - me] ? 'lose' : 'draw';
    this.endBonus = REWARD[res];
    this.result = res;
    this.say(res === 'win' ? 'SIEG!' : res === 'lose' ? 'NIEDERLAGE' : 'UNENTSCHIEDEN', res === 'win' ? '#7dff8a' : res === 'lose' ? '#ff8c7f' : '#fff', 3);
    Sound.play(res === 'win' ? 'capture' : 'lost');
    setTimeout(() => { if (this.onEnd && this.running) this.onEnd(res); }, 2600);
  }

  // ---------------- KI ----------------
  think(c, dt) {
    const B = c.bot, W = this.world, inp = c.input;
    B.thinkT -= dt; B.hurtT = Math.max(0, B.hurtT - dt); B.jumpT -= dt; B.mineT -= dt;
    const diff = this.opts.difficulty;
    if (B.thinkT <= 0) {
      B.thinkT = 0.18 + Math.random() * 0.08;
      const my = this.flags[c.team], en = this.flags[1 - c.team], home = W.bases[c.team];
      let goal = null, chase = false;
      const dHome = Math.sqrt(d2(c.x, c.y, home.x, home.y));
      if (c.flag >= 0) {
        // Flaggenträger: heimfahren und dort warten, bis die eigene Flagge zurück ist
        if (my.state !== 'base' && dHome < 30) {
          B.roamT -= 0.2;
          if (!B.roam || B.roamT <= 0 || d2(c.x, c.y, B.roam.x, B.roam.y) < 16) { B.roam = W.randomFreeNear(home.x, home.y, 6, 22); B.roamT = 3; }
          goal = B.roam;
          if (my.state === 'dropped' && d2(c.x, c.y, my.x, my.y) < 60 * 60) goal = my;
        } else goal = home;
      } else if (my.state === 'dropped' && (B.role === 'defend' || d2(c.x, c.y, my.x, my.y) < 160 * 160 || en.state === 'carried')) goal = my;
      else if (my.state === 'carried' && (B.role === 'defend' || en.state === 'carried' || d2(c.x, c.y, my.x, my.y) < 120 * 120)) { goal = my.carrier; chase = true; }
      else if (B.role === 'attack') {
        if (en.state === 'carried') {
          // eskortieren oder gegnerische Verteidiger jagen
          const carrier = en.carrier;
          goal = d2(c.x, c.y, carrier.x, carrier.y) > 30 * 30 ? carrier : home;
        } else goal = en;
      } else {
        // Verteidiger: in der Nähe der Basis patrouillieren
        B.roamT -= 0.2;
        if (!B.roam || B.roamT <= 0 || d2(c.x, c.y, B.roam.x, B.roam.y) < 25) { B.roam = W.randomFreeNear(home.x, home.y, 8, 32); B.roamT = 5; }
        goal = B.roam;
        const threat = this.findTarget(c, 45);
        if (threat && d2(threat.x, threat.y, home.x, home.y) < 60 * 60) goal = threat;
      }
      B.goal = goal; B.chase = chase;
      // Weg
      const gx = goal.x, gy = goal.y;
      const dGoal = Math.sqrt(d2(c.x, c.y, gx, gy));
      if (dGoal < 14 && W.los(c.x, c.y, gx, gy, W.nav)) B.wp = { x: gx, y: gy, dist: dGoal };
      else {
        const qx = Math.round(gx / 6) * 6, qy = Math.round(gy / 6) * 6;
        const key = W.navIdx(qx, qy);
        if (key !== B.fieldKey || !B.field) {
          if ((this.fieldBudgetFrame !== this.frameNo) ) { this.fieldBudgetFrame = this.frameNo; this.fieldBudget = 1; }
          const cached = W.fields.has(W.nearestFree(key));
          if (cached || this.fieldBudget > 0) {
            if (!cached) this.fieldBudget--;
            B.field = W.field(qx, qy); B.fieldKey = key;
          }
        }
        B.wp = B.field ? W.waypoint(B.field, c.x, c.y, 10) : { x: gx, y: gy, dist: dGoal };
        if (!B.wp) B.wp = { x: gx, y: gy, dist: dGoal };
      }
      // Ziel für Waffe
      B.target = this.findTarget(c, c.range * 1.05);
      B.aimErr = (Math.random() - 0.5) * [0.35, 0.18, 0.08][diff];
    }
    // Fahren
    const wp = B.wp || { x: c.x, y: c.y, dist: 0 };
    const dx = wp.x - c.x, dy = wp.y - c.y;
    const want = Math.atan2(dy, dx);
    let da = angNorm(want - c.a);
    const dist = Math.hypot(dx, dy);
    const sp = c.speed;
    // Fühler gegen Wände
    const look = clamp(sp * 0.35, 3, 9);
    const fl = W.nav[W.navIdx(c.x + Math.cos(c.a - 0.45) * look, c.y + Math.sin(c.a - 0.45) * look)];
    const fr = W.nav[W.navIdx(c.x + Math.cos(c.a + 0.45) * look, c.y + Math.sin(c.a + 0.45) * look)];
    if (fl && !fr) da += 0.5; else if (fr && !fl) da -= 0.5;
    if (B.revT > 0) {
      B.revT -= dt;
      inp.thr = -1; inp.steer = B.revSteer;
    } else {
      inp.steer = clamp(da * 2.4, -1, 1);
      if (Math.abs(da) > 2.2 && dist < 18) { inp.thr = -0.8; inp.steer = -Math.sign(da); }
      else inp.thr = Math.abs(da) > 1.2 ? 0.45 : 1;
      if (B.goal && B.role === 'defend' && c.flag < 0 && !B.chase && B.goal === B.roam && dist < 6) inp.thr = 0.3;
      // feststecken?
      if (inp.thr > 0.3 && sp < 1.6 && this.state === 'play') { B.stuckT += dt; if (B.stuckT > 0.8) { B.stuckT = 0; B.revT = 0.7 + Math.random() * 0.4; B.revSteer = Math.random() < 0.5 ? -1 : 1; } }
      else B.stuckT = Math.max(0, B.stuckT - dt);
    }
    inp.boost = c.onGround && (c.flag >= 0 || (wp.dist > 50 && B.role === 'attack') || B.chase) && Math.abs(da) < 0.25 && c.boost > c.st.boost * 0.3 && sp > 8;
    // in der Luft Richtung Fluss: mit Nitro rübergleiten statt ins Wasser zu fallen
    if (!c.onGround && c.boost > 0.25 && (W.waterAt(c.x + c.vx * 0.9, c.y + c.vy * 0.9) !== null || W.waterAt(c.x, c.y) !== null)) inp.boost = true;
    inp.jump = false;
    if (B.jumpT <= 0 && c.onGround) {
      if ((B.hurtT > 0 && Math.random() < 0.04 * (diff + 1)) || (B.stuckT > 0.5)) {
        // nicht in Flussnähe springen (sonst landet der Bot im Wasser)
        let wet = false;
        for (let k = 0; k < 32 && !wet; k++) { const rr2 = [15, 30, 45, 60][k >> 3]; wet = W.waterAt(c.x + Math.cos(k * 0.785) * rr2, c.y + Math.sin(k * 0.785) * rr2) !== null; }
        if (!wet) { inp.jump = true; B.jumpT = 1.5; } else B.jumpT = 1;
      }
    }
    // Minen legen, wenn verfolgt
    inp.mine = false;
    if (B.mineT <= 0 && c.mines > 0 && (c.flag >= 0 || B.role === 'defend')) {
      for (const o of this.cars) if (o.alive && o.team !== c.team && d2(o.x, o.y, c.x, c.y) < 22 * 22) {
        const behind = Math.cos(Math.atan2(o.y - c.y, o.x - c.x) - c.a) < -0.5;
        if (behind && Math.random() < 0.3) { inp.mine = true; B.mineT = 3; }
        break;
      }
    }
    // Zielen
    const t = B.target;
    if (t && t.alive) {
      const tt = Math.sqrt(d2(c.x, c.y, t.x, t.y)) / c.w.speed;
      const lead = diff === 0 ? 0.3 : diff === 1 ? 0.7 : 1;
      inp.aim = Math.atan2(t.y + t.vy * tt * lead - c.y, t.x + t.vx * tt * lead - c.x) + B.aimErr;
      const dd = Math.sqrt(d2(c.x, c.y, t.x, t.y));
      inp.fire = dd < c.range * 0.95 && Math.abs(angNorm(inp.aim - c.turret)) < (c.w.splash ? 0.2 : 0.14);
      const dz = (t.z + 0.9) - (c.z + 1.1);
      inp.pitch = Math.abs(dz) > 1.8 ? clamp(Math.atan2(dz, Math.max(dd, 1)), -0.6, 0.9) : 0;
    } else { inp.aim = c.a; inp.fire = false; inp.pitch = 0; }
  }

  // ---------------- Darstellung ----------------
  render(dt) {
    if (this.r3d) return this.render3D(dt);
    this.render2D(dt);
  }
  render3D(dt) {
    this.frameNo = (this.frameNo || 0) + 1;
    const time = performance.now() / 1000;
    this.camR = { x: this.cam.x, y: this.cam.y };
    this.r3d.render(dt, time);
    const g = this.g;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // schwebende Texte (+100 Kohle)
    const D = this.dpr;
    g.textAlign = 'center'; g.font = `800 ${15 * D}px system-ui, sans-serif`; g.lineWidth = 3 * D; g.strokeStyle = 'rgba(0,0,0,0.7)';
    for (const p of this.particles.list) {
      if (p.type !== 'text') continue;
      const s = this.worldToScreen(p.x, p.y, 3 + (1.6 - p.life) * 2);
      g.globalAlpha = clamp(p.life / p.max, 0, 1); g.fillStyle = p.color;
      g.strokeText(p.text, s.x, s.y); g.fillText(p.text, s.x, s.y);
    }
    g.globalAlpha = 1;
    this.drawTags(g, 0, 0);
    if (!this.demo) this.drawHUD(g, 0, 0, time);
  }
  render2D(dt) {
    this.frameNo = (this.frameNo || 0) + 1;
    const g = this.g, cv = this.canvas, Z = this.Z, W = this.world;
    const SW = cv.width, SH = cv.height;
    const sx = (Math.random() - 0.5) * this.shake * 0.8, sy = (Math.random() - 0.5) * this.shake * 0.8;
    const cx = this.cam.x + sx, cy = this.cam.y + sy;
    this.camR = { x: cx, y: cy };
    const vw = SW / Z, vh = SH / Z;
    const left = cx - vw / 2, top = cy - vh / 2;
    this.viewRect = { x0: left, y0: top, x1: left + vw, y1: top + vh };
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = COL.outside; g.fillRect(0, 0, SW, SH);
    // Kacheln
    W.getTile(0, 0, Z);
    const T = W.tileM;
    const tx0 = Math.floor(left / T), tx1 = Math.floor((left + vw) / T);
    const ty0 = Math.floor(top / T), ty1 = Math.floor((top + vh) / T);
    g.imageSmoothingEnabled = true;
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      if ((tx + 1) * T < -60 || (ty + 1) * T < -60 || tx * T > W.w + 60 || ty * T > W.h + 60) continue;
      const tile = W.getTile(tx, ty, Z);
      g.drawImage(tile, Math.floor((tx * T - left) * Z), Math.floor((ty * T - top) * Z), TILE_PX + 1, TILE_PX + 1);
    }
    g.setTransform(Z, 0, 0, Z, -left * Z, -top * Z);
    const vis = (x, y, r) => x + r > left && x - r < left + vw && y + r > top && y - r < top + vh;
    const time = performance.now() / 1000;
    // Pickups
    for (const p of this.pickups) {
      if (!p.active || !vis(p.x, p.y, 3)) continue;
      const bob = Math.sin(time * 4 + p.x) * 0.25;
      g.fillStyle = 'rgba(0,0,0,0.3)'; g.beginPath(); g.ellipse(p.x + 0.4, p.y + 0.5, 1.1, 0.8, 0, 0, 7); g.fill();
      g.save(); g.translate(p.x, p.y - 0.6 + bob);
      if (p.t === 0) { g.fillStyle = '#fff'; g.fillRect(-1.1, -1.1, 2.2, 2.2); g.fillStyle = '#e8423a'; g.fillRect(-0.3, -0.85, 0.6, 1.7); g.fillRect(-0.85, -0.3, 1.7, 0.6); g.strokeStyle = '#333'; g.lineWidth = 0.12; g.strokeRect(-1.1, -1.1, 2.2, 2.2); }
      else if (p.t === 1) { g.fillStyle = '#2a8de0'; g.beginPath(); g.arc(0, 0, 1.1, 0, 7); g.fill(); g.fillStyle = '#fff'; g.font = 'bold 1.4px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('N₂O', 0, 0.05); }
      else { g.fillStyle = '#f5c518'; g.beginPath(); g.arc(0, 0, 1.0, 0, 7); g.fill(); g.strokeStyle = '#a77d00'; g.lineWidth = 0.18; g.stroke(); g.fillStyle = '#8a6400'; g.font = 'bold 1.3px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('€', 0, 0.05); }
      g.restore();
    }
    // Minen
    for (const m of this.mines) {
      if (!vis(m.x, m.y, 2)) continue;
      g.fillStyle = '#333'; g.beginPath(); g.arc(m.x, m.y, 0.7, 0, 7); g.fill();
      g.fillStyle = m.arm > 0 ? '#999' : (Math.sin(time * 10) > 0 ? TEAM[m.team].color : '#222');
      g.beginPath(); g.arc(m.x, m.y, 0.3, 0, 7); g.fill();
    }
    // Kisten
    for (const p of this.props) {
      if (!p.alive || !vis(p.x, p.y, 3)) continue;
      g.save(); g.translate(p.x, p.y); g.rotate(p.a);
      g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(-p.hw + 0.4, -p.hh + 0.5, p.hw * 2, p.hh * 2);
      g.fillStyle = p.col; g.fillRect(-p.hw, -p.hh, p.hw * 2, p.hh * 2);
      g.fillStyle = p.top; g.fillRect(-p.hw + 0.15, -p.hh + 0.15, p.hw * 2 - 0.3, p.hh * 2 - 0.3);
      if (p.t === 0) { g.strokeStyle = p.col; g.lineWidth = 0.15; g.beginPath(); g.moveTo(-p.hw, -p.hh); g.lineTo(p.hw, p.hh); g.moveTo(p.hw, -p.hh); g.lineTo(-p.hw, p.hh); g.stroke(); }
      if (p.t === 2) { g.fillStyle = '#d23'; for (let i = -1; i <= 1; i++) g.fillRect(i * 1 - 0.25, -p.hh + 0.15, 0.5, p.hh * 2 - 0.3); }
      if (p.t === 1) { g.strokeStyle = '#a88a3a'; g.lineWidth = 0.1; for (let i = -2; i <= 2; i++) { g.beginPath(); g.moveTo(i * 0.4, -p.hh); g.lineTo(i * 0.4, p.hh); g.stroke(); } }
      g.restore();
    }
    // Flaggen am Boden
    for (const f of this.flags) if (f.state !== 'carried') this.drawFlag(g, f.x, f.y, 0, f.team, time, f.state === 'dropped' ? f.dropT / 25 : -1);
    // Schatten + Bodenfahrzeuge
    const ground = [], air = [];
    for (const c of this.cars) if (c.alive && vis(c.x, c.y, 8)) (c.z - c.groundZ > 0.6 ? air : ground).push(c);
    for (const c of this.cars) if (c.alive && vis(c.x, c.y, 8)) this.drawShadow(g, c);
    for (const c of ground) this.drawCar(g, c, time);
    // Geschosse
    this.drawBullets(g, vis);
    // Gebäude + Bäume
    this.drawBuildings(g, cx, cy, left, top, vw, vh);
    for (const c of air) this.drawCar(g, c, time);
    // Partikel
    this.particles.draw(g, 0);
    g.globalCompositeOperation = 'lighter';
    this.particles.draw(g, 1);
    g.globalCompositeOperation = 'source-over';
    // Spieler durch Gebäude sichtbar
    const p = this.player;
    if (this.demo) { g.setTransform(1, 0, 0, 1, 0, 0); this.drawTags(g, left, top); return; }
    if (p.alive) {
      g.save(); g.globalAlpha = 0.35; g.strokeStyle = '#fff'; g.lineWidth = 0.25;
      g.translate(p.x, p.y); g.rotate(p.a); g.strokeRect(-p.def.len / 2, -p.def.wid / 2, p.def.len, p.def.wid); g.restore();
    }
    // HUD
    g.setTransform(1, 0, 0, 1, 0, 0);
    this.drawTags(g, left, top);
    this.drawHUD(g, left, top, time);
  }
  drawFlag(g, x, y, z, team, time, timer) {
    const tm = TEAM[team];
    const k = CAM_H / (CAM_H - 6 - z), cx = this.camR.x, cy = this.camR.y;
    const bx = cx + (x - cx) * (CAM_H / (CAM_H - z)), by = cy + (y - cy) * (CAM_H / (CAM_H - z));
    const tx = cx + (x - cx) * k, ty = cy + (y - cy) * k;
    g.fillStyle = 'rgba(0,0,0,0.3)'; g.beginPath(); g.ellipse(x + 0.5, y + 0.6, 1.2, 0.8, 0, 0, 7); g.fill();
    if (timer >= 0) { g.strokeStyle = tm.color; g.lineWidth = 0.35; g.beginPath(); g.arc(x, y, 2.4, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * timer); g.stroke(); }
    g.strokeStyle = '#ddd'; g.lineWidth = 0.25; g.beginPath(); g.moveTo(bx, by); g.lineTo(tx, ty); g.stroke();
    const wv = Math.sin(time * 6 + x) * 0.5;
    g.fillStyle = tm.color; g.strokeStyle = tm.dark; g.lineWidth = 0.12;
    g.beginPath(); g.moveTo(tx, ty); g.quadraticCurveTo(tx + 1.6, ty + wv, tx + 3.2, ty + 0.8 + wv * 0.5); g.quadraticCurveTo(tx + 1.6, ty + 1.8 + wv, tx + (bx - tx) * 0.3, ty + 2.2); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#fff'; g.beginPath(); g.arc(tx, ty, 0.25, 0, 7); g.fill();
  }
  drawShadow(g, c) {
    const h = c.z - c.groundZ;
    const ox = 0.3 + h * 0.32, oy = 0.35 + h * 0.38;
    g.save(); g.translate(c.x + ox, c.y + oy); g.rotate(c.a);
    g.fillStyle = `rgba(0,0,0,${clamp(0.38 - h * 0.03, 0.1, 0.38)})`;
    const L = c.def.len, Wd = c.def.wid;
    g.beginPath(); g.roundRect(-L / 2, -Wd / 2, L, Wd, 0.6); g.fill();
    g.restore();
  }
  drawCar(g, c, time) {
    const cx = this.camR.x, cy = this.camR.y;
    const zr = this.r3d ? c.z : Math.max(0, c.z - this.world.terrain(c.x, c.y));
    const k = CAM_H / (CAM_H - zr - 1);
    const x = cx + (c.x - cx) * k, y = cy + (c.y - cy) * k;
    const L = c.def.len, Wd = c.def.wid, tm = TEAM[c.team];
    g.save(); g.translate(x, y); g.scale(k, k);
    if (c.protect > 0) { g.globalAlpha = 0.5 + Math.sin(time * 20) * 0.25; }
    g.rotate(c.a);
    const body = tm.color, dark = tm.dark;
    const wheel = (wx, wy, ww, wh) => { g.fillStyle = '#151515'; g.beginPath(); g.roundRect(wx - ww / 2, wy - wh / 2, ww, wh, 0.15); g.fill(); };
    switch (c.def.shape) {
      case 'sport':
        wheel(1.3, -1.0, 1.0, 0.45); wheel(1.3, 1.0, 1.0, 0.45); wheel(-1.35, -1.02, 1.1, 0.5); wheel(-1.35, 1.02, 1.1, 0.5);
        g.fillStyle = dark; g.beginPath(); g.roundRect(-L / 2, -Wd / 2, L, Wd, 0.7); g.fill();
        g.fillStyle = body; g.beginPath(); g.moveTo(L / 2, -0.55); g.quadraticCurveTo(L / 2 + 0.1, 0, L / 2, 0.55); g.lineTo(L / 2 - 0.6, Wd / 2 - 0.05); g.lineTo(-L / 2 + 0.2, Wd / 2 - 0.1); g.lineTo(-L / 2 + 0.2, -Wd / 2 + 0.1); g.lineTo(L / 2 - 0.6, -Wd / 2 + 0.05); g.closePath(); g.fill();
        g.fillStyle = '#fff'; g.fillRect(-L / 2 + 0.3, -0.18, L - 0.4, 0.12); g.fillRect(-L / 2 + 0.3, 0.06, L - 0.4, 0.12);
        g.fillStyle = '#1c2633'; g.beginPath(); g.moveTo(1.25, -0.75); g.lineTo(1.25, 0.75); g.lineTo(0.75, 0.85); g.lineTo(0.75, -0.85); g.closePath(); g.fill();
        g.fillStyle = dark; g.fillRect(-L / 2 - 0.1, -Wd / 2 + 0.05, 0.4, Wd - 0.1);
        break;
      case 'buggy':
        wheel(1.25, -1.05, 1.1, 0.6); wheel(1.25, 1.05, 1.1, 0.6); wheel(-1.2, -1.1, 1.3, 0.7); wheel(-1.2, 1.1, 1.3, 0.7);
        g.fillStyle = '#2b2b2b'; g.fillRect(-L / 2 + 0.2, -0.7, L - 0.4, 1.4);
        g.fillStyle = body; g.beginPath(); g.moveTo(L / 2, -0.5); g.lineTo(L / 2, 0.5); g.lineTo(0.6, 0.85); g.lineTo(-1.6, 0.85); g.lineTo(-1.9, 0.5); g.lineTo(-1.9, -0.5); g.lineTo(-1.6, -0.85); g.lineTo(0.6, -0.85); g.closePath(); g.fill();
        g.strokeStyle = '#ddd'; g.lineWidth = 0.14; g.strokeRect(-0.9, -0.8, 1.9, 1.6);
        g.beginPath(); g.moveTo(-0.9, -0.8); g.lineTo(1.0, 0.8); g.stroke();
        break;
      case 'tank':
        g.fillStyle = '#1d1d1d'; g.fillRect(-L / 2, -Wd / 2, L, 0.75); g.fillRect(-L / 2, Wd / 2 - 0.75, L, 0.75);
        g.fillStyle = '#444';
        const off = (c.x * Math.cos(c.a) + c.y * Math.sin(c.a)) * 2 % 0.6;
        for (let t = -L / 2 + off; t < L / 2; t += 0.6) { g.fillRect(t, -Wd / 2, 0.2, 0.75); g.fillRect(t, Wd / 2 - 0.75, 0.2, 0.75); }
        g.fillStyle = dark; g.fillRect(-L / 2 + 0.2, -Wd / 2 + 0.6, L - 0.3, Wd - 1.2);
        g.fillStyle = body; g.beginPath(); g.moveTo(L / 2 - 0.1, -0.7); g.lineTo(L / 2 + 0.2, 0); g.lineTo(L / 2 - 0.1, 0.7); g.lineTo(-L / 2 + 0.3, 0.75); g.lineTo(-L / 2 + 0.3, -0.75); g.closePath(); g.fill();
        g.fillStyle = 'rgba(0,0,0,0.25)'; for (let i = -1; i <= 1; i++) g.fillRect(i * 1.2 - 0.05, -0.75, 0.1, 1.5);
        break;
      case 'jeep':
        wheel(1.45, -1.05, 1.1, 0.55); wheel(1.45, 1.05, 1.1, 0.55); wheel(-1.45, -1.05, 1.1, 0.55); wheel(-1.45, 1.05, 1.1, 0.55);
        g.fillStyle = dark; g.beginPath(); g.roundRect(-L / 2, -Wd / 2, L, Wd, 0.45); g.fill();
        g.fillStyle = body; g.beginPath(); g.roundRect(0, -Wd / 2 + 0.12, L / 2 - 0.1, Wd - 0.24, 0.4); g.fill();
        g.fillStyle = '#1c2633'; g.fillRect(1.25, -0.8, 0.45, 1.6);
        g.fillStyle = '#5a4a3a'; g.fillRect(-L / 2 + 0.2, -Wd / 2 + 0.2, L / 2 - 0.1, Wd - 0.4);
        g.fillStyle = body; g.fillRect(-L / 2 + 0.05, -Wd / 2 + 0.05, L / 2 + 0.05, 0.2); g.fillRect(-L / 2 + 0.05, Wd / 2 - 0.25, L / 2 + 0.05, 0.2);
        break;
      case 'truck':
        wheel(1.5, -1.15, 1.35, 0.75); wheel(1.5, 1.15, 1.35, 0.75); wheel(-1.5, -1.15, 1.35, 0.75); wheel(-1.5, 1.15, 1.35, 0.75);
        g.fillStyle = dark; g.beginPath(); g.roundRect(-L / 2 + 0.1, -Wd / 2 + 0.15, L - 0.2, Wd - 0.3, 0.35); g.fill();
        g.fillStyle = body; g.beginPath(); g.roundRect(-L / 2 + 0.3, -Wd / 2 + 0.3, L - 0.5, Wd - 0.6, 0.3); g.fill();
        g.fillStyle = '#1c2633'; g.fillRect(1.3, -0.75, 0.4, 1.5);
        g.fillStyle = '#ffe9a0'; for (let i = -1; i <= 1; i++) { g.beginPath(); g.arc(1.95, i * 0.45, 0.14, 0, 7); g.fill(); }
        g.strokeStyle = '#222'; g.lineWidth = 0.18; g.beginPath(); g.moveTo(L / 2 + 0.1, -0.9); g.lineTo(L / 2 + 0.1, 0.9); g.stroke();
        break;
    }
    // Fahrer (Gesicht durchs Schiebedach)
    const img = DRIVER_IMG[c.driver.id];
    const sh = c.shape;
    g.save();
    g.translate(sh.face, 0); g.rotate(-c.a + 0);
    g.beginPath(); g.arc(0, 0, sh.faceR, 0, 7); g.closePath();
    g.fillStyle = '#111'; g.fill();
    if (img && img.complete && img.naturalWidth) { g.save(); g.clip(); g.drawImage(img, -sh.faceR, -sh.faceR, sh.faceR * 2, sh.faceR * 2); g.restore(); }
    g.strokeStyle = tm.light; g.lineWidth = 0.14; g.stroke();
    g.restore();
    // Treffer-Blitz
    if (c.flashT > 0) { g.fillStyle = 'rgba(255,255,255,0.55)'; g.beginPath(); g.roundRect(-L / 2, -Wd / 2, L, Wd, 0.5); g.fill(); }
    // Turm
    g.translate(sh.turret, 0); g.rotate(c.turret - c.a);
    g.fillStyle = '#2a2d31'; g.strokeStyle = '#111'; g.lineWidth = 0.1;
    switch (c.def.weapon) {
      case 'mg': g.fillRect(0, -0.32, 1.9, 0.18); g.fillRect(0, 0.14, 1.9, 0.18); g.beginPath(); g.arc(0, 0, 0.55, 0, 7); g.fillStyle = '#3a3f45'; g.fill(); g.stroke(); break;
      case 'minigun': g.fillStyle = '#3a3f45'; g.fillRect(-0.4, -0.5, 0.9, 1.0); g.fillStyle = '#222'; g.fillRect(0.4, -0.3, 1.7, 0.6); g.fillStyle = '#777'; for (let i = -1; i <= 1; i++) g.fillRect(0.5, i * 0.17 - 0.05, 1.7, 0.1); break;
      case 'cannon': g.fillStyle = '#4d5359'; g.beginPath(); g.roundRect(-1.0, -0.85, 2.0, 1.7, 0.4); g.fill(); g.stroke(); g.fillStyle = '#2f3337'; g.fillRect(0.8, -0.18, 2.4, 0.36); g.fillRect(3.0, -0.26, 0.35, 0.52); g.fillStyle = TEAM[c.team].color; g.beginPath(); g.arc(-0.2, 0, 0.3, 0, 7); g.fill(); break;
      case 'rocket': g.fillStyle = '#4d5359'; g.fillRect(-0.7, -0.75, 1.6, 1.5); g.stroke(); g.fillStyle = '#1b1b1b'; for (let i = 0; i < 4; i++) { g.beginPath(); g.arc(0.85, -0.5 + i * 0.33, 0.13, 0, 7); g.fill(); } g.fillStyle = '#ff7b39'; g.fillRect(-0.7, -0.75, 0.2, 1.5); break;
      case 'shotgun': g.fillStyle = '#3a3f45'; g.beginPath(); g.arc(0, 0, 0.6, 0, 7); g.fill(); g.stroke(); g.fillStyle = '#222'; g.fillRect(0.2, -0.27, 1.4, 0.54); g.fillStyle = '#555'; g.fillRect(1.5, -0.32, 0.25, 0.64); break;
    }
    g.restore();
    // getragene Flagge
    if (c.flag >= 0) this.drawFlag(g, c.x - Math.cos(c.a) * 1.2, c.y - Math.sin(c.a) * 1.2, zr + 1, c.flag, time, -1);
  }
  drawBullets(g, vis) {
    for (const b of this.bullets) {
      if (!vis(b.x, b.y, 3)) continue;
      const w = b.w;
      if (w === WEAPONS.rocket) {
        const a = Math.atan2(b.vy, b.vx);
        g.save(); g.translate(b.x, b.y); g.rotate(a);
        g.fillStyle = '#ddd'; g.fillRect(-0.6, -0.17, 1.2, 0.34); g.fillStyle = '#e33'; g.fillRect(0.4, -0.17, 0.3, 0.34);
        g.fillStyle = '#ffb347'; g.beginPath(); g.moveTo(-0.6, -0.17); g.lineTo(-1.4 - Math.random() * 0.6, 0); g.lineTo(-0.6, 0.17); g.fill();
        g.restore();
      } else if (w === WEAPONS.cannon) {
        g.fillStyle = '#222'; g.beginPath(); g.arc(b.x, b.y, 0.45, 0, 7); g.fill();
        g.fillStyle = '#ffb347'; g.beginPath(); g.arc(b.x, b.y, 0.25, 0, 7); g.fill();
      } else {
        const sp = Math.hypot(b.vx, b.vy) || 1;
        const l = 1.6;
        g.strokeStyle = w.color; g.lineWidth = w.size * 0.8; g.lineCap = 'round';
        g.beginPath(); g.moveTo(b.x, b.y); g.lineTo(b.x - b.vx / sp * l, b.y - b.vy / sp * l); g.stroke();
      }
    }
  }
  drawBuildings(g, cx, cy, left, top, vw, vh) {
    const W = this.world;
    const m = 12;
    const list = this._blist || (this._blist = []);
    list.length = 0;
    for (const b of W.buildings) {
      const bb = b.bb;
      if (bb[2] < left - m || bb[0] > left + vw + m || bb[3] < top - m || bb[1] > top + vh + m) continue;
      b.dist = (b.cx - cx) ** 2 + (b.cy - cy) ** 2;
      list.push(b);
    }
    list.sort((a, b) => b.dist - a.dist);
    g.lineJoin = 'round';
    for (const b of list) {
      const k = CAM_H / (CAM_H - b.h);
      const p = b.p, n = p.length;
      const rp = b._rp || (b._rp = new Float32Array(n));
      for (let i = 0; i < n; i += 2) { rp[i] = cx + (p[i] - cx) * k; rp[i + 1] = cy + (p[i + 1] - cy) * k; }
      // Fläche (Orientierung)
      if (b.area === undefined) { let A = 0; for (let i = 0; i < n; i += 2) { const j = (i + 2) % n; A += p[i] * p[j + 1] - p[j] * p[i + 1]; } b.area = A; }
      // Wände
      g.fillStyle = b.wall;
      g.beginPath();
      let any = false;
      for (let i = 0; i < n; i += 2) {
        const j = (i + 2) % n;
        const cr = (p[j] - p[i]) * (cy - p[i + 1]) - (p[j + 1] - p[i + 1]) * (cx - p[i]);
        if (cr * b.area >= 0) continue;
        any = true;
        g.moveTo(p[i], p[i + 1]); g.lineTo(p[j], p[j + 1]); g.lineTo(rp[j], rp[j + 1]); g.lineTo(rp[i], rp[i + 1]); g.closePath();
      }
      if (any) {
        g.fill();
        // Schattierung: Wände nach Süden/Osten dunkler
        g.fillStyle = 'rgba(40,30,20,0.18)'; g.fill();
        g.strokeStyle = 'rgba(60,45,35,0.35)'; g.lineWidth = 0.12; g.stroke();
        // Stockwerk-Linien
        if (b.h > 5) {
          g.strokeStyle = 'rgba(70,60,50,0.22)'; g.lineWidth = 0.18;
          g.beginPath();
          for (let fl = 3.2; fl < b.h - 1; fl += 3.2) {
            const kk = CAM_H / (CAM_H - fl);
            for (let i = 0; i < n; i += 2) {
              const j = (i + 2) % n;
              const cr = (p[j] - p[i]) * (cy - p[i + 1]) - (p[j + 1] - p[i + 1]) * (cx - p[i]);
              if (cr * b.area >= 0) continue;
              g.moveTo(cx + (p[i] - cx) * kk, cy + (p[i + 1] - cy) * kk); g.lineTo(cx + (p[j] - cx) * kk, cy + (p[j + 1] - cy) * kk);
            }
          }
          g.stroke();
        }
      }
      // Dach
      g.fillStyle = b.roof;
      g.beginPath(); g.moveTo(rp[0], rp[1]);
      for (let i = 2; i < n; i += 2) g.lineTo(rp[i], rp[i + 1]);
      g.closePath(); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 0.2; g.stroke();
      if (b.ridge) {
        const kr = CAM_H / (CAM_H - b.h - 1.5);
        const r = b.ridge;
        g.strokeStyle = 'rgba(0,0,0,0.28)'; g.lineWidth = 0.35;
        g.beginPath(); g.moveTo(cx + (r[0] - cx) * kr, cy + (r[1] - cy) * kr); g.lineTo(cx + (r[2] - cx) * kr, cy + (r[3] - cy) * kr); g.stroke();
      } else {
        g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 0.4;
        g.stroke();
      }
      if (b.n && (b.bb[2] - b.bb[0]) > 14) {
        const lx = cx + (b.cx - cx) * k, ly = cy + (b.cy - cy) * k;
        g.font = 'bold 2.2px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.lineWidth = 0.45; g.strokeStyle = 'rgba(0,0,0,0.55)'; g.fillStyle = '#fff';
        g.strokeText(b.n, lx, ly); g.fillText(b.n, lx, ly);
      }
    }
    // Baumkronen
    const tc = ['#3f7a35', '#4b8a3a', '#36702f'];
    for (const t of W.trees) {
      if (t.x < left - 8 || t.x > left + vw + 8 || t.y < top - 8 || t.y > top + vh + 8) continue;
      const k = CAM_H / (CAM_H - t.h);
      const x = cx + (t.x - cx) * k, y = cy + (t.y - cy) * k;
      g.strokeStyle = '#5b4630'; g.lineWidth = 0.4; g.beginPath(); g.moveTo(t.x, t.y); g.lineTo(x, y); g.stroke();
      g.fillStyle = tc[t.hue]; g.beginPath(); g.arc(x, y, t.r * k, 0, 7); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.12)'; g.beginPath(); g.arc(x - t.r * 0.3, y - t.r * 0.3, t.r * 0.55, 0, 7); g.fill();
    }
  }
  worldToScreen(x, y, z) {
    if (z === undefined) z = this.world.terrain(x, y);
    if (this.r3d) return this.r3d.project(x, y, z);
    z = Math.max(0, z - this.world.terrain(x, y));
    const cx = this.camR.x, cy = this.camR.y, k = CAM_H / (CAM_H - z);
    const px = cx + (x - cx) * k, py = cy + (y - cy) * k;
    return { x: (px - cx) * this.Z + this.canvas.width / 2, y: (py - cy) * this.Z + this.canvas.height / 2 };
  }
  drawFace(g, id, x, y, r, ring, label) {
    const img = DRIVER_IMG[id];
    g.save(); g.beginPath(); g.arc(x, y, r, 0, 7); g.closePath();
    g.fillStyle = '#2a2f3b'; g.fill();
    if (img && img.complete && img.naturalWidth) { g.clip(); g.drawImage(img, x - r, y - r, r * 2, r * 2); }
    else if (label) { g.fillStyle = '#fff'; g.font = `800 ${Math.round(r * 1.1)}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(label.trim()[0].toUpperCase(), x, y + r * 0.05); }
    g.restore();
    if (ring) { g.strokeStyle = ring; g.lineWidth = Math.max(1.5, r * 0.16); g.beginPath(); g.arc(x, y, r, 0, 7); g.stroke(); }
  }
  drawTags(g, left, top) {
    const D = this.dpr * Math.max(0.75, this.hud);
    g.textAlign = 'left'; g.textBaseline = 'middle';
    g.font = `600 ${11 * D}px system-ui, sans-serif`;
    for (const c of this.cars) {
      if (!c.alive || c.isPlayer) continue;
      const s = this.worldToScreen(c.x, c.y, c.z + 2.6);
      if (s.behind) continue;
      if (s.x < -50 || s.y < -50 || s.x > this.canvas.width + 50 || s.y > this.canvas.height + 50) continue;
      const tm = TEAM[c.team];
      const y = s.y - 26 * D;
      const name = c.name;
      const tw = g.measureText(name).width;
      const w = tw + 26 * D;
      const x = s.x - w / 2;
      g.fillStyle = 'rgba(0,0,0,0.5)'; g.beginPath(); g.roundRect(x, y - 9 * D, w, 18 * D, 9 * D); g.fill();
      this.drawFace(g, c.driver.id, x + 9 * D, y, 8 * D, tm.color, c.name);
      g.fillStyle = tm.light; g.fillText(name, x + 21 * D, y);
      // HP
      const hw = 36 * D;
      g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(s.x - hw / 2, y + 11 * D, hw, 4 * D);
      const f = c.hp / c.st.hp;
      g.fillStyle = f > 0.5 ? '#6ee06e' : f > 0.25 ? '#f0c040' : '#ff4b3a';
      g.fillRect(s.x - hw / 2, y + 11 * D, hw * f, 4 * D);
      if (c.flag >= 0) { g.font = `${14 * D}px sans-serif`; g.fillText('🚩', s.x + w / 2 + 2 * D, y); g.font = `600 ${11 * D}px system-ui, sans-serif`; }
    }
  }
  // Minikarte unten rechts: großer Ausschnitt um den Spieler, Norden oben, Basen/Flaggen am Rand, wenn außerhalb
  drawMinimap(g, SW, SH, D, touch, p) {
    const W = this.world, mini = this.mini;
    const S = clamp(Math.min(SW, SH) * 0.36, 170 * D, 320 * D);
    const mx = touch ? 12 * D : SW - S - 14 * D, my = touch ? 62 * D : SH - S - 14 * D;
    const R = 240, k = S / (2 * R);
    const cx = p && p.alive ? p.x : this.cam.x, cy = p && p.alive ? p.y : this.cam.y;
    const X = x => mx + S / 2 + (x - cx) * k, Y = y => my + S / 2 + (y - cy) * k;
    const m = 13 * D;
    const clampPt = (x, y) => {   // auf den Rand ziehen, wenn außerhalb
      let sx = X(x), sy = Y(y), out = false;
      if (sx < mx + m || sx > mx + S - m || sy < my + m || sy > my + S - m) {
        out = true;
        const dx = sx - (mx + S / 2), dy = sy - (my + S / 2), f = (S / 2 - m) / Math.max(Math.abs(dx), Math.abs(dy));
        sx = mx + S / 2 + dx * f; sy = my + S / 2 + dy * f;
      }
      return [sx, sy, out];
    };
    g.save();
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.beginPath(); g.roundRect(mx + 3 * D, my + 4 * D, S, S, 14 * D); g.fill();
    g.beginPath(); g.roundRect(mx, my, S, S, 14 * D); g.save(); g.clip();
    g.fillStyle = '#1b1f22'; g.fillRect(mx, my, S, S);
    g.imageSmoothingEnabled = true;
    g.drawImage(mini, X(0), Y(0), W.w * k, W.h * k);
    // Blickrichtung der Kamera
    if (p && p.alive && this.camMode === 'chase') {
      const a = this.viewYaw ?? this.camYaw, r = 70 * D;
      const gr = g.createRadialGradient(X(p.x), Y(p.y), 0, X(p.x), Y(p.y), r);
      gr.addColorStop(0, 'rgba(255,255,255,0.28)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.beginPath(); g.moveTo(X(p.x), Y(p.y)); g.arc(X(p.x), Y(p.y), r, a - 0.55, a + 0.55); g.closePath(); g.fill();
    }
    const arrow = (x, y, a, s, fill, stroke, lw) => {
      g.save(); g.translate(x, y); g.rotate(a);
      g.beginPath(); g.moveTo(s, 0); g.lineTo(-s * 0.75, -s * 0.7); g.lineTo(-s * 0.35, 0); g.lineTo(-s * 0.75, s * 0.7); g.closePath();
      g.fillStyle = fill; g.fill(); g.strokeStyle = stroke; g.lineWidth = lw; g.stroke(); g.restore();
    };
    const flagIcon = (x, y, f, s) => {
      g.strokeStyle = '#111'; g.lineWidth = 2 * D; g.beginPath(); g.moveTo(x, y + s * 0.5); g.lineTo(x, y - s); g.stroke();
      g.fillStyle = TEAM[f.team].color; g.strokeStyle = '#fff'; g.lineWidth = 1.5 * D;
      g.beginPath(); g.moveTo(x, y - s); g.lineTo(x + s * 0.95, y - s * 0.62); g.lineTo(x, y - s * 0.25); g.closePath(); g.fill(); g.stroke();
    };
    // Basen
    for (let i = 0; i < 2; i++) {
      const b = W.bases[i], [sx, sy, out] = clampPt(b.x, b.y), r = (out ? 7 : 10) * D;
      g.fillStyle = TEAM[i].color; g.strokeStyle = '#fff'; g.lineWidth = 2.5 * D;
      g.beginPath(); g.arc(sx, sy, r, 0, 7); g.fill(); g.stroke();
      g.fillStyle = '#fff'; g.font = `900 ${Math.round((out ? 8 : 10) * D)}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(TEAM[i].short[0], sx, sy + 0.5 * D);
    }
    // Autos (eigenes Team immer, Gegner nur in der Nähe oder mit Flagge)
    for (const c of this.cars) {
      if (!c.alive || c.isPlayer) continue;
      const near = c.team === p.team || c.flag >= 0 || d2(c.x, c.y, p.x, p.y) < 90 * 90;
      if (!near) continue;
      const mate = c.team === p.team;
      arrow(X(c.x), Y(c.y), c.a, 7.5 * D, TEAM[c.team].color, mate ? '#ffffff' : '#111111', 1.6 * D);
    }
    // Flaggen (getragen: pulsierender Ring um den Träger)
    const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 160);
    for (const f of this.flags) {
      const fx = f.carrier ? f.carrier.x : f.x, fy = f.carrier ? f.carrier.y : f.y;
      const [sx, sy, out] = clampPt(fx, fy);
      if (f.carrier) {
        g.strokeStyle = TEAM[f.team].light; g.lineWidth = 2.5 * D; g.globalAlpha = 0.5 + 0.5 * pulse;
        g.beginPath(); g.arc(sx, sy, (11 + 4 * pulse) * D, 0, 7); g.stroke(); g.globalAlpha = 1;
      } else if (f.state !== 'base' && pulse < 0.3) continue;   // liegende Flagge blinkt
      flagIcon(sx + 2 * D, sy - 2 * D, f, (out ? 9 : 12) * D);
    }
    // eigener Pfeil obenauf
    if (p && p.alive) arrow(X(p.x), Y(p.y), p.a, 10 * D, '#ffffff', '#000000', 2 * D);
    g.restore();
    g.strokeStyle = 'rgba(255,255,255,0.75)'; g.lineWidth = 2 * D; g.beginPath(); g.roundRect(mx, my, S, S, 14 * D); g.stroke();
    g.fillStyle = '#fff'; g.font = `800 ${Math.round(11 * D)}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('N', mx + S / 2, my + 10 * D);
    g.restore();
  }
  drawHUD(g, left, top, time) {
    const D = this.dpr * this.hud, SW = this.canvas.width, SH = this.canvas.height;
    const p = this.player;
    g.textBaseline = 'middle';
    // Punktestand oben
    const cxs = SW / 2;
    g.fillStyle = 'rgba(10,12,18,0.72)'; g.beginPath(); g.roundRect(cxs - 150 * D, 8 * D, 300 * D, 58 * D, 12 * D); g.fill();
    g.font = `900 ${30 * D}px system-ui, sans-serif`; g.textAlign = 'center';
    g.fillStyle = TEAM[0].color; g.fillText(this.score[0], cxs - 45 * D, 32 * D);
    g.fillStyle = TEAM[1].color; g.fillText(this.score[1], cxs + 45 * D, 32 * D);
    g.fillStyle = '#ccc'; g.font = `700 ${16 * D}px system-ui, sans-serif`; g.fillText(':', cxs, 31 * D);
    const mm = Math.floor(this.time / 60), ss = Math.floor(this.time % 60);
    g.font = `600 ${13 * D}px system-ui, sans-serif`; g.fillStyle = this.time < 30 ? '#ff8c7f' : '#ddd';
    g.fillText(`${mm}:${String(ss).padStart(2, '0')}  ·  bis ${this.opts.capLimit}`, cxs, 55 * D);
    for (let i = 0; i < 2; i++) {
      const f = this.flags[i];
      const x = cxs + (i ? 1 : -1) * 112 * D, y = 32 * D;
      g.font = `${20 * D}px sans-serif`;
      g.globalAlpha = f.state === 'base' ? 1 : 0.35 + 0.3 * Math.sin(time * 8);
      g.fillStyle = TEAM[i].color; g.beginPath(); g.moveTo(x - 8 * D, y + 12 * D); g.lineTo(x - 8 * D, y - 13 * D); g.lineTo(x + 12 * D, y - 7 * D); g.lineTo(x - 8 * D, y - 1 * D); g.fill();
      g.strokeStyle = '#ddd'; g.lineWidth = 2 * D; g.beginPath(); g.moveTo(x - 8 * D, y + 13 * D); g.lineTo(x - 8 * D, y - 13 * D); g.stroke();
      g.globalAlpha = 1;
      g.font = `600 ${9 * D}px system-ui, sans-serif`; g.fillStyle = '#bbb';
      g.fillText(f.state === 'base' ? 'Basis' : f.state === 'carried' ? 'geklaut!' : 'liegt', x + 2 * D, y + 19 * D);
    }
    // Kohle
    g.textAlign = 'left';
    g.fillStyle = 'rgba(10,12,18,0.6)'; g.beginPath(); g.roundRect(10 * D, 10 * D, 150 * D, 30 * D, 8 * D); g.fill();
    g.fillStyle = '#ffe66d'; g.font = `700 ${14 * D}px system-ui, sans-serif`; g.fillText(`💰 +${this.earned} Kohle`, 20 * D, 25 * D);
    g.fillStyle = 'rgba(255,255,255,0.5)'; g.font = `500 ${10 * D}px system-ui, sans-serif`;
    let info = this.map.name + ' – ' + this.map.sub;
    if (this.r3d && !Input.touch.active) info += '  ·  [C] Kamera';
    if (this.isHost) info += '  ·  🌐 Host';
    if (this.isClient) info += `  ·  🌐 ${typeof Net !== 'undefined' && Net.linkMode === 'relay' ? 'über Server' : 'direkt'} · Ping ${Math.round(this.rtt * 1000)} ms`;
    g.fillText(info, 12 * D, 52 * D);
    // ---- Spieler-Anzeige: groß und mittig unten ----
    const touch = Input.touch.active;
    const bw = Math.min(460 * D, SW * (touch ? 0.36 : 0.42)), bx = (SW - bw) / 2;
    const by = SH - (touch ? 64 : 70) * D;
    const hf = p.alive ? clamp(p.hp / p.st.hp, 0, 1) : 0;
    const big = (y, h, f, c1, c2, label, right) => {
      g.fillStyle = 'rgba(8,10,14,0.78)'; g.beginPath(); g.roundRect(bx - 3 * D, y - 3 * D, bw + 6 * D, h + 6 * D, (h + 6 * D) / 2); g.fill();
      if (f > 0.002) {
        const gr = g.createLinearGradient(bx, y, bx, y + h); gr.addColorStop(0, c1); gr.addColorStop(1, c2);
        g.fillStyle = gr; g.beginPath(); g.roundRect(bx, y, Math.max(h, bw * f), h, h / 2); g.fill();
      }
      g.font = `800 ${Math.round(h * 0.62)}px system-ui, sans-serif`; g.textBaseline = 'middle';
      g.lineWidth = 3 * D; g.strokeStyle = 'rgba(0,0,0,0.6)'; g.fillStyle = '#fff';
      g.textAlign = 'left'; g.strokeText(label, bx + 10 * D, y + h / 2 + 1); g.fillText(label, bx + 10 * D, y + h / 2 + 1);
      g.textAlign = 'right'; g.strokeText(right, bx + bw - 10 * D, y + h / 2 + 1); g.fillText(right, bx + bw - 10 * D, y + h / 2 + 1);
    };
    const hc = hf > 0.5 ? ['#7dff8a', '#2fa84d'] : hf > 0.25 ? ['#ffe06b', '#d99a14'] : ['#ff8a7a', '#c9261b'];
    if (hf < 0.25 && p.alive) { g.globalAlpha = 0.6 + 0.4 * Math.sin(time * 10); }
    big(by - 6 * D, 26 * D, hf, hc[0], hc[1], '❤ PANZERUNG', `${Math.ceil(p.alive ? p.hp : 0)} / ${p.st.hp}`);
    g.globalAlpha = 1;
    const nf = clamp(p.boost / p.st.boost, 0, 1);
    big(by + 30 * D, 17 * D, nf, '#8fe3ff', '#1f8fe0', touch ? '🚀 NITRO' : '🚀 NITRO [Shift]', p.boosting ? (p.onGround === false ? 'FLIEGEN!' : 'BOOST!') : Math.round(nf * 100) + ' %');
    // XP-Leiste
    const lvlXp = p.xp % XP.perLevel, maxed = p.lvlGiven >= MATCH_UPS.length * MATCH_UP_MAX;
    const xy = by - 22 * D;
    g.fillStyle = 'rgba(8,10,14,0.6)'; g.fillRect(bx, xy, bw, 6 * D);
    g.fillStyle = '#c084fc'; g.fillRect(bx, xy, bw * (maxed ? 1 : lvlXp / XP.perLevel), 6 * D);
    g.font = `700 ${10 * D}px system-ui, sans-serif`; g.textAlign = 'left'; g.textBaseline = 'bottom';
    g.lineWidth = 3 * D; g.strokeStyle = 'rgba(0,0,0,0.6)'; g.fillStyle = '#e9d5ff';
    const xpTxt = `⭐ ${p.xp} XP · Upgrades ${p.ups.spd + p.ups.arm + p.ups.dmg}/${MATCH_UPS.length * MATCH_UP_MAX}`;
    g.strokeText(xpTxt, bx, xy - 2 * D); g.fillText(xpTxt, bx, xy - 2 * D);
    g.textBaseline = 'middle';
    // Upgrade-Auswahl
    this.upBoxes = [];
    if (p.pts > 0) {
      const w3 = Math.min(150 * D, (bw - 16 * D) / 3), h3 = 46 * D, y3 = xy - 22 * D - h3;
      const x0 = SW / 2 - (w3 * 3 + 16 * D) / 2;
      g.textAlign = 'center';
      g.font = `800 ${12 * D}px system-ui, sans-serif`; g.fillStyle = '#7dd3ff';
      g.fillText(`UPGRADE VERFÜGBAR (${p.pts})` + (touch ? ' – antippen' : ' – Taste 1 / 2 / 3'), SW / 2, y3 - 10 * D);
      MATCH_UPS.forEach((u, i) => {
        const x = x0 + i * (w3 + 8 * D), full = p.ups[u.k] >= MATCH_UP_MAX;
        g.fillStyle = full ? 'rgba(40,40,48,0.7)' : `rgba(30,70,120,${0.75 + 0.15 * Math.sin(time * 5 + i)})`;
        g.beginPath(); g.roundRect(x, y3, w3, h3, 10 * D); g.fill();
        g.strokeStyle = full ? '#555' : '#7dd3ff'; g.lineWidth = 2 * D; g.stroke();
        g.fillStyle = full ? '#888' : '#fff'; g.font = `800 ${12 * D}px system-ui, sans-serif`;
        g.fillText(`${touch ? '' : '[' + u.key + '] '}${u.icon} ${u.name}`, x + w3 / 2, y3 + 16 * D);
        g.font = `600 ${10 * D}px system-ui, sans-serif`; g.fillStyle = full ? '#777' : '#bfe6ff';
        g.fillText(full ? 'MAX' : '●'.repeat(p.ups[u.k]) + '○'.repeat(MATCH_UP_MAX - p.ups[u.k]), x + w3 / 2, y3 + 33 * D);
        this.upBoxes.push({ k: u.k, x: x / this.dpr, y: y3 / this.dpr, w: w3 / this.dpr, h: h3 / this.dpr });
      });
    }
    // Porträt + Infos links unten
    const px = 12 * D, py = SH - 76 * D;
    g.textAlign = 'left';
    g.fillStyle = 'rgba(10,12,18,0.72)'; g.beginPath(); g.roundRect(px, py, Math.min(250 * D, bx - 24 * D), 64 * D, 12 * D); g.fill();
    this.drawFace(g, p.driver.id, px + 32 * D, py + 32 * D, 24 * D, TEAM[p.team].color, p.name);
    if (bx - 24 * D > 120 * D) {
      g.fillStyle = '#fff'; g.font = `700 ${13 * D}px system-ui, sans-serif`;
      g.fillText(p.name, px + 64 * D, py + 15 * D);
      g.fillStyle = '#aaa'; g.font = `500 ${10 * D}px system-ui, sans-serif`;
      g.fillText(p.def.name + ' · ' + p.w.name, px + 64 * D, py + 30 * D);
      g.font = `600 ${9.5 * D}px system-ui, sans-serif`;
      g.fillStyle = p.jumpCd <= 0 ? '#7dff8a' : '#888';
      g.fillText(p.jumpCd <= 0 ? (touch ? '⬆ Sprung' : '⬆ Sprung [Leer]') : `⬆ ${p.jumpCd.toFixed(1)}s`, px + 64 * D, py + 46 * D);
      g.fillStyle = p.mines > 0 ? '#ffb14d' : '#888';
      g.fillText(`● Minen ${p.mines}` + (touch ? '' : ' [E]'), px + 150 * D, py + 46 * D);
      if (!touch) { g.fillStyle = p.drifting ? '#ffe66d' : '#888'; g.fillText('↯ Drift [Q]', px + 64 * D, py + 58 * D); }
    }
    // Fadenkreuz + Treffermarker
    const chase3d = this.r3d && this.camMode === 'chase';
    if (!touch && (chase3d || Input.mouse.moved) && p.alive) {
      const cr = chase3d ? this.crosshair() : Input.mouse;
      const mx = cr.x * this.dpr, my = cr.y * this.dpr;
      if (chase3d) {
        g.strokeStyle = 'rgba(0,0,0,0.35)'; g.lineWidth = 4 * D; g.beginPath();
        for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { g.moveTo(mx + ax * 15 * D, my + ay * 15 * D); g.lineTo(mx + ax * 24 * D, my + ay * 24 * D); }
        g.stroke(); g.strokeStyle = '#fff'; g.lineWidth = 2 * D; g.stroke();
        if (document.pointerLockElement !== this.canvas && this.state !== 'over') {
          g.fillStyle = 'rgba(255,255,255,0.75)'; g.font = `700 ${Math.round(11 * D)}px system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'top';
          g.fillText('Klicken = Maus-Blick (Esc gibt die Maus frei)', mx, my + 30 * D);
        }
      }
      const lock = this.aimLock && this.aimLock.alive;
      g.strokeStyle = lock ? '#ff5a4a' : 'rgba(255,255,255,0.9)'; g.lineWidth = 2 * D;
      g.beginPath(); g.arc(mx, my, (lock ? 14 : 11) * D, 0, 7); g.stroke();
      // Höhenwinkel des Turms anzeigen (▲ nach oben / ▼ nach unten)
      const tp = p.tpitch || 0;
      if (Math.abs(tp) > 0.05) { g.fillStyle = tp > 0 ? '#9fe0ff' : '#ffd28a'; g.font = `800 ${Math.round(11 * D)}px system-ui, sans-serif`; g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText((tp > 0 ? '▲ ' : '▼ ') + Math.round(Math.abs(tp) * 57.3) + '°', mx + 17 * D, my - 12 * D); }
      g.fillStyle = '#fff'; g.beginPath(); g.arc(mx, my, 2 * D, 0, 7); g.fill();
      if (this.hitT > 0) {
        g.strokeStyle = '#ff5a4a'; g.lineWidth = 3 * D; const r1_ = 7 * D, r2_ = 15 * D;
        g.beginPath();
        for (const [sx, sy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) { g.moveTo(mx + sx * r1_, my + sy * r1_); g.lineTo(mx + sx * r2_, my + sy * r2_); }
        g.stroke();
      }
      // wohin der Turm gerade zielt
      const tcp = Math.cos(p.tpitch || 0), tx = p.x + Math.cos(p.turret) * 28 * tcp, ty = p.y + Math.sin(p.turret) * 28 * tcp;
      const ts = this.worldToScreen(tx, ty, p.z + 1.2 + Math.sin(p.tpitch || 0) * 28);
      if (!ts.behind) { g.strokeStyle = 'rgba(255,230,110,0.85)'; g.lineWidth = 2 * D; g.beginPath(); g.arc(ts.x, ts.y, 5 * D, 0, 7); g.stroke(); }
    } else if (touch && this.hitT > 0) {
      g.fillStyle = '#ff5a4a'; g.font = `900 ${28 * D}px system-ui`; g.textAlign = 'center'; g.fillText('✕', SW / 2, SH / 2);
    }
    // Killfeed
    g.textAlign = 'right';
    let fy = 16 * D;
    for (const f of this.feed) {
      if (f.t <= 0) continue;
      g.globalAlpha = clamp(f.t, 0, 1);
      g.font = `600 ${11 * D}px system-ui, sans-serif`;
      let x = SW - 14 * D;
      const parts = [];
      if (f.text) {
        parts.push({ t: f.text, c: f.cap ? '#ffe66d' : '#ddd' });
        if (f.a) parts.push({ face: f.a });
        else parts.push({ t: TEAM[f.flagTeam].name + ':', c: TEAM[f.flagTeam].light });
      } else {
        parts.push({ face: f.b });
        parts.push({ t: f.kind === 'water' ? '🌊' : f.kind === 'boom' ? '💥' : f.kind === 'ram' ? '🚗💨' : f.kind === 'stomp' ? '⬇️' : f.kind === 'crash' ? '🧱' : '🔫', c: '#fff' });
        if (f.a) parts.push({ face: f.a });
      }
      const wBox = parts.reduce((s, q) => s + (q.face ? (g.measureText(q.face.name).width + 26 * D) : g.measureText(q.t).width + 8 * D), 0) + 10 * D;
      g.fillStyle = 'rgba(10,12,18,0.6)'; g.beginPath(); g.roundRect(x - wBox, fy - 11 * D, wBox + 6 * D, 22 * D, 8 * D); g.fill();
      for (const q of parts) {
        if (q.face) {
          g.fillStyle = TEAM[q.face.team].light;
          g.fillText(q.face.name, x, fy);
          x -= g.measureText(q.face.name).width + 12 * D;
          this.drawFace(g, q.face.driver.id, x, fy, 8 * D, TEAM[q.face.team].color, q.face.name);
          x -= 14 * D;
        } else { g.fillStyle = q.c; g.fillText(q.t, x, fy); x -= g.measureText(q.t).width + 8 * D; }
      }
      fy += 26 * D;
      g.globalAlpha = 1;
    }
    // Minikarte: großer Ausschnitt um den Spieler (Norden oben), kontrastreich
    this.drawMinimap(g, SW, SH, D, touch, p);
    // Pfeile zu Flaggen außerhalb des Bildes
    for (const f of this.flags) {
      if (f.carrier && f.carrier.isPlayer) continue;
      const s = this.worldToScreen(f.x, f.y);
      if (s.behind) { s.x = SW - s.x; s.y = SH * 3; }
      const mrg = 50 * D;
      if (s.x > mrg && s.y > mrg && s.x < SW - mrg && s.y < SH - mrg) continue;
      if (f.team === p.team && f.state === 'base') continue;
      const ang = Math.atan2(s.y - SH / 2, s.x - SW / 2);
      const ex = clamp(s.x, mrg, SW - mrg), ey = clamp(s.y, mrg + 40 * D, SH - 130 * D);
      g.save(); g.translate(ex, ey); g.rotate(ang);
      g.fillStyle = TEAM[f.team].color; g.strokeStyle = '#fff'; g.lineWidth = 2 * D;
      g.beginPath(); g.moveTo(18 * D, 0); g.lineTo(-6 * D, -11 * D); g.lineTo(-2 * D, 0); g.lineTo(-6 * D, 11 * D); g.closePath(); g.fill(); g.stroke();
      g.restore();
      g.font = `${14 * D}px sans-serif`; g.textAlign = 'center';
      g.fillText('🚩', ex - Math.cos(ang) * 22 * D, ey - Math.sin(ang) * 22 * D);
    }
    // Basis-Pfeil, wenn Spieler die Flagge trägt
    if (p.flag >= 0) {
      const b = this.world.bases[p.team];
      const s = this.worldToScreen(b.x, b.y);
      if (s.behind) { s.x = SW - s.x; s.y = SH * 3; }
      const ang = Math.atan2(s.y - SH / 2, s.x - SW / 2);
      const r = Math.min(SW, SH) * 0.16;
      g.save(); g.translate(SW / 2 + Math.cos(ang) * r, SH / 2 + Math.sin(ang) * r); g.rotate(ang);
      g.globalAlpha = 0.6 + 0.3 * Math.sin(time * 6);
      g.fillStyle = '#ffe66d'; g.beginPath(); g.moveTo(22 * D, 0); g.lineTo(-8 * D, -14 * D); g.lineTo(-2 * D, 0); g.lineTo(-8 * D, 14 * D); g.closePath(); g.fill();
      g.restore(); g.globalAlpha = 1;
    }
    // Meldungen
    g.textAlign = 'center';
    let my2 = SH * 0.3;
    for (const m of this.msgs) {
      const a = clamp(m.t / Math.min(0.5, m.max), 0, 1);
      g.globalAlpha = a;
      const fs = (m.big ? 34 : 20) * D;
      g.font = `900 ${fs}px system-ui, sans-serif`;
      g.lineWidth = 5 * D; g.strokeStyle = 'rgba(0,0,0,0.65)'; g.strokeText(m.text, SW / 2, my2);
      g.fillStyle = m.color; g.fillText(m.text, SW / 2, my2);
      my2 += fs * 1.25;
      g.globalAlpha = 1;
    }
    // Tod
    if (!p.alive && this.state !== 'over') {
      g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(0, SH * 0.55, SW, 90 * D);
      g.font = `800 ${22 * D}px system-ui, sans-serif`; g.fillStyle = '#fff';
      const k = p.killedBy;
      if (k) {
        const t = 'Abgeschossen von ' + k.name;
        g.fillText(t, SW / 2 + 20 * D, SH * 0.55 + 30 * D);
        this.drawFace(g, k.driver.id, SW / 2 - g.measureText(t).width / 2 - 8 * D, SH * 0.55 + 30 * D, 18 * D, TEAM[k.team].color, k.name);
      } else g.fillText('Totalschaden!', SW / 2, SH * 0.55 + 30 * D);
      g.font = `600 ${15 * D}px system-ui, sans-serif`; g.fillStyle = '#ffe66d';
      g.fillText(`Neustart in ${Math.max(0, p.respawnT).toFixed(1)} s`, SW / 2, SH * 0.55 + 64 * D);
    }
    // Touch-Steuerung
    if (Input.touch.active) this.drawTouch(g);
    if (this.showBoard || this.state === 'over') this.drawBoard(g);
  }
  drawTouch(g) {
    const D = this.dpr, T = Input.touch;
    g.lineWidth = 3 * D;
    for (const k of ['move', 'aim']) {
      const s = T[k]; if (!s) continue;
      g.strokeStyle = 'rgba(255,255,255,0.35)'; g.beginPath(); g.arc(s.ox * D, s.oy * D, 55 * D, 0, 7); g.stroke();
      g.fillStyle = k === 'aim' ? 'rgba(255,120,80,0.5)' : 'rgba(255,255,255,0.4)';
      const dx = s.x - s.ox, dy = s.y - s.oy, m = Math.hypot(dx, dy), f = m > 55 ? 55 / m : 1;
      g.beginPath(); g.arc((s.ox + dx * f) * D, (s.oy + dy * f) * D, 24 * D, 0, 7); g.fill();
    }
    g.textAlign = 'center'; g.font = `800 ${11 * D}px system-ui, sans-serif`;
    for (const b of Input.touchButtons()) {
      const on = !!T[b.id];
      g.fillStyle = on ? 'rgba(255,230,110,0.55)' : 'rgba(0,0,0,0.35)';
      g.beginPath(); g.arc(b.x * D, b.y * D, b.r * D, 0, 7); g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.5)'; g.stroke();
      g.fillStyle = '#fff'; g.fillText(b.label, b.x * D, b.y * D);
    }
    if (!T.move && !T.aim) {
      g.font = `600 ${12 * D}px system-ui, sans-serif`; g.fillStyle = 'rgba(255,255,255,0.5)';
      g.fillText('◀ links wischen: fahren', this.canvas.width * 0.25, this.canvas.height * 0.72);
      g.fillText('rechts wischen: zielen & feuern ▶', this.canvas.width * 0.62, this.canvas.height * 0.62);
    }
  }
  drawBoard(g) {
    const D = this.dpr * this.hud, SW = this.canvas.width, SH = this.canvas.height;
    const w = Math.min(SW - 20 * D, 640 * D), rowH = 26 * D;
    const rows = this.cars.length + 2;
    const h = rows * rowH + 60 * D;
    const x = (SW - w) / 2, y = Math.max(70 * D, (SH - h) / 2);
    g.fillStyle = 'rgba(10,12,18,0.85)'; g.beginPath(); g.roundRect(x, y, w, h, 14 * D); g.fill();
    g.textAlign = 'center'; g.fillStyle = '#fff'; g.font = `800 ${16 * D}px system-ui, sans-serif`;
    g.fillText('Punktetafel', SW / 2, y + 22 * D);
    const cols = [0.52, 0.64, 0.74, 0.84, 0.94];
    g.font = `600 ${10 * D}px system-ui, sans-serif`; g.fillStyle = '#999';
    ['Abschüsse', 'Tode', 'Punkte', 'Rettungen', 'Score'].forEach((t, i) => g.fillText(t, x + w * cols[i], y + 44 * D));
    let ry = y + 64 * D;
    for (let team = 0; team < 2; team++) {
      const list = this.cars.filter(c => c.team === team).sort((a, b) => b.score - a.score);
      for (const c of list) {
        if (c.isPlayer) { g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(x + 8 * D, ry - rowH / 2, w - 16 * D, rowH); }
        this.drawFace(g, c.driver.id, x + 24 * D, ry, 10 * D, TEAM[team].color, c.name);
        g.textAlign = 'left'; g.fillStyle = TEAM[team].light; g.font = `700 ${12 * D}px system-ui, sans-serif`;
        const nm = c.name + (c.isPlayer ? ' (Du)' : '');
        g.fillText(nm, x + 40 * D, ry);
        const nw = g.measureText(nm).width;
        g.fillStyle = '#888'; g.font = `500 ${9 * D}px system-ui, sans-serif`;
        if (w > 520 * D) g.fillText(c.def.name, x + 46 * D + nw, ry);
        g.textAlign = 'center'; g.fillStyle = '#eee'; g.font = `600 ${12 * D}px system-ui, sans-serif`;
        [c.kills, c.deaths, c.caps, c.returns, c.score].forEach((v, i) => g.fillText(v, x + w * cols[i], ry));
        ry += rowH;
      }
      ry += rowH * 0.5;
    }
  }
}
