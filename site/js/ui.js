'use strict';
// ---------------------------------------------------------------------------
// Menüs, Garage, Speicherstand
// ---------------------------------------------------------------------------

const SAVE_KEY = 'schussental_showdown_v1';
const DEFAULT_SAVE = {
  coins: 500,
  owned: {},
  name: '',
  up: {},
  car: 'flitzer',
  driver: 'marlon',
  settings: { sound: true, autoAim: false, gfx3d: true, cam: 'chase', size: 4, diff: 1, caps: 3, time: 480, map: 'ravensburg', bots: true },
  stats: { games: 0, wins: 0, kills: 0, caps: 0 },
};
let save = loadSave();
function loadSave() {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (s && typeof s === 'object') {
      return { ...DEFAULT_SAVE, ...s, settings: { ...DEFAULT_SAVE.settings, ...(s.settings || {}) }, stats: { ...DEFAULT_SAVE.stats, ...(s.stats || {}) } };
    }
  } catch (e) { /* ignorieren */ }
  return JSON.parse(JSON.stringify(DEFAULT_SAVE));
}
// alle Fahrzeugklassen sind frei wählbar
for (const c of CARS) save.owned[c.id] = true;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const cleanName = s => String(s || '').replace(/[<>"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
function avatarHtml(id, name, cls = '') {
  const d = DRIVERS.find(x => x.id === id);
  if (d && !ADMIN_ASSETS.inactive.has(d.id)) return `<img class="${cls}" src="${esc(driverSrc(d))}" alt="">`;
  return `<div class="ava ${cls}">${esc((cleanName(name) || '?')[0].toUpperCase())}</div>`;
}
function myName() { return cleanName(save.name) || 'Spieler'; }
function writeSave() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch (e) { /* privater Modus */ } }

const $ = s => document.querySelector(s);
const canvas = $('#game');
let game = null, demo = null, lastOpts = null, garageSel = null, previewAnim = 0;

function toast(t) {
  const d = document.createElement('div'); d.className = 'toast'; d.textContent = t;
  document.body.appendChild(d); setTimeout(() => d.remove(), 1800);
}
function fmt(n) { return n.toLocaleString('de-DE'); }

function show(id) {
  document.querySelectorAll('.screen').forEach(s => { if (s.id !== 'loading') s.classList.add('hidden'); });
  if (id) $('#scr-' + id).classList.remove('hidden');
  cancelAnimationFrame(previewAnim);
  if (id === 'menu') { renderMenu(); startDemo(); }
  if (id === 'setup') renderSetup();
  if (id === 'garage') renderGarage();
  if (id === 'drivers') renderDrivers();
  if (id === 'online') renderOnline();
  if (id === 'lobby') renderLobby();
}

// ---------------- Demo im Hintergrund ----------------
function startDemo() {
  if (demo || game) return;
  Sound.quiet = true;
  const map = pick(MAPS).id;
  const act = activeDrivers();
  demo = new Game(canvas, { demo: true, three: save.settings.gfx3d !== false, mapId: map, teamSize: 4, difficulty: 1, capLimit: 3, timeLimit: 300, car: pick(CARS).id, driver: act.length ? pick(act).id : '', upgrades: {} });
  demo.onEnd = () => { stopDemo(); if (!game) startDemo(); };
}
function stopDemo() { if (demo) { demo.destroy(); demo = null; } Sound.quiet = false; }

// ---------------- Hauptmenü ----------------
function renderMenu() {
  const car = CARS.find(c => c.id === save.car) || CARS[0];
  $('#me-card').innerHTML = `${avatarHtml(save.driver, myName())}<div class="me-mid"><input id="nick" maxlength="16" placeholder="Dein Name" value="${esc(save.name)}" autocomplete="off" spellcheck="false"><div class="sub">${esc(car.name)} · ${save.stats.wins} Siege · ${save.stats.kills} Abschüsse</div></div><div class="coins">💰 ${fmt(save.coins)}</div>`;
  const nick = $('#nick');
  nick.addEventListener('keydown', e => e.stopPropagation());
  nick.addEventListener('input', () => { save.name = cleanName(nick.value); writeSave(); });
  $('#opt-sound').checked = save.settings.sound;
  $('#opt-aim').checked = save.settings.autoAim;
  $('#opt-3d').checked = save.settings.gfx3d !== false;
}

// ---------------- Setup ----------------
const miniCache = {};
function mapPreview(m) {
  if (!miniCache[m.id]) {
    const w = new World(m);
    const c = w.renderMini(420);
    const g = c.getContext('2d');
    const s = c.width / w.w;
    w.bases.forEach((b, i) => {
      g.fillStyle = TEAM[i].color; g.strokeStyle = '#fff'; g.lineWidth = 2;
      g.beginPath(); g.arc(b.x * s, b.y * s, 9, 0, 7); g.fill(); g.stroke();
    });
    miniCache[m.id] = c;
  }
  return miniCache[m.id];
}
function seg(el, items, val, onPick, disabled) {
  el.innerHTML = '';
  for (const [v, label] of items) {
    const b = document.createElement('button');
    b.textContent = label; if (v === val) b.classList.add('sel');
    if (disabled) { b.disabled = true; el.appendChild(b); continue; }
    b.onclick = () => { Sound.play('click'); onPick(v); el.querySelectorAll('button').forEach(x => x.classList.remove('sel')); b.classList.add('sel'); writeSave(); };
    el.appendChild(b);
  }
}
function renderSetup() {
  const S = save.settings;
  const wrap = $('#maps'); wrap.innerHTML = '';
  for (const m of MAPS) {
    const card = document.createElement('div');
    card.className = 'map-card' + (S.map === m.id ? ' sel' : '');
    const cv = document.createElement('canvas');
    const src = mapPreview(m); cv.width = src.width; cv.height = src.height;
    cv.getContext('2d').drawImage(src, 0, 0);
    card.appendChild(cv);
    card.insertAdjacentHTML('beforeend', `<div class="mc-t"><div class="mc-n">${m.name}</div><div class="mc-s">${m.sub}</div></div>`);
    card.onclick = () => { S.map = m.id; writeSave(); Sound.play('click'); renderSetup(); };
    wrap.appendChild(card);
  }
  seg($('#seg-size'), [[2, '2v2'], [3, '3v3'], [4, '4v4'], [5, '5v5'], [6, '6v6']], S.size, v => S.size = v);
  seg($('#seg-diff'), [[0, 'Leicht'], [1, 'Mittel'], [2, 'Schwer']], S.diff, v => S.diff = v);
  seg($('#seg-caps'), [[3, '3'], [5, '5'], [7, '7']], S.caps, v => S.caps = v);
  seg($('#seg-time'), [[300, '5 Min'], [480, '8 Min'], [720, '12 Min']], S.time, v => S.time = v);
  $('#setup-car').innerHTML = `${avatarHtml(save.driver, myName())}<div><b>${esc(myName())}</b><br>im ${esc((CARS.find(c => c.id === save.car) || CARS[0]).name)}</div>`;
  renderLoadout($('#loadout'), save.car, id => { save.car = id; writeSave(); Sound.play('click'); renderSetup(); });
}
// Fahrzeugklassen-Auswahl vor dem Match
function renderLoadout(el, sel, onPick) {
  if (!el) return;
  el.innerHTML = '';
  const bars = [['speed', 'Tempo', 42], ['hp', 'Schutz', 520], ['dps', 'Feuerkraft', 80], ['jump', 'Sprung', 13]];
  for (const car of CARS) {
    const st = carStats(car, save.up[car.id] || {});
    const val = k => k === 'dps' ? carDps(car, st) : st[k];
    const d = document.createElement('div');
    d.className = 'lo-card' + (car.id === sel ? ' sel' : '');
    d.innerHTML = `<div class="lo-n">${esc(car.name)}</div><div class="lo-r">${esc(car.role)} · ${esc(WEAPONS[car.weapon].name)}</div>` +
      bars.map(([k, n, mx]) => `<div class="lo-b"><span>${n}</span><i><b style="width:${Math.round(clamp(val(k) / mx, 0.05, 1) * 100)}%"></b></i></div>`).join('');
    d.onclick = () => onPick(car.id);
    el.appendChild(d);
  }
}
function startMatch(opts) {
  stopDemo();
  if (game) game.destroy();
  show(null);
  Sound.init();
  lastOpts = opts;
  game = new Game(canvas, opts);
  game.onEnd = res => endMatch(res);
  $('#btn-again').classList.toggle('hidden', opts.mode === 'host' || opts.mode === 'client');
  $('#btn-end-lobby').classList.toggle('hidden', !(opts.mode === 'host' || opts.mode === 'client'));
  $('#btn-end-garage').classList.toggle('hidden', opts.mode === 'host' || opts.mode === 'client');
  $('#btn-restart').classList.toggle('hidden', opts.mode === 'host' || opts.mode === 'client');
}
function matchOpts() {
  const S = save.settings;
  return {
    mapId: S.map, teamSize: S.size, difficulty: S.diff, capLimit: S.caps, timeLimit: S.time,
    three: save.settings.gfx3d !== false, camMode: save.settings.cam || 'chase',
    car: save.car, driver: save.driver, name: myName(), upgrades: save.up[save.car] || {}, autoAim: S.autoAim || ('ontouchstart' in window && navigator.maxTouchPoints > 0),
  };
}
function endMatch(res) {
  if (!game) return;
  const p = game.player;
  save.coins += game.earned;
  save.stats.games++; if (res === 'win') save.stats.wins++;
  save.stats.kills += p.kills; save.stats.caps += p.caps;
  writeSave();
  const t = { win: '🏆 SIEG!', lose: '💀 NIEDERLAGE', draw: '🤝 UNENTSCHIEDEN' }[res];
  $('#end-title').textContent = t;
  $('#end-title').style.color = res === 'win' ? '#7dff8a' : res === 'lose' ? '#ff8c7f' : '#fff';
  $('#end-score').innerHTML = `<span style="color:${TEAM[0].color}">${game.score[0]}</span> : <span style="color:${TEAM[1].color}">${game.score[1]}</span>`;
  $('#end-stats').innerHTML = [['Abschüsse', p.kills], ['Tode', p.deaths], ['Punkte', p.caps], ['Rettungen', p.returns]].map(([k, v]) => `<div><b>${v}</b><span>${k}</span></div>`).join('');
  $('#end-coins').textContent = `+${fmt(game.earned)} Kohle  (gesamt: ${fmt(save.coins)})`;
  const lb = $('#btn-end-lobby');
  if (game.isClient) { lb.disabled = true; lb.textContent = 'Warte auf den Host …'; }
  else { lb.disabled = false; lb.textContent = 'Zur Lobby'; }
  $('#scr-end').classList.remove('hidden');
}
function quitToMenu() {
  if (game) { game.destroy(); game = null; }
  if (Net.active) Net.leave();
  show('menu');
}

// ---------------- Garage ----------------
function carPreview(cv, car, angle) {
  const g = cv.getContext('2d');
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, cv.width, cv.height);
  const fake = { camR: { x: 0, y: 0 }, drawFlag() {} };
  const obj = {
    x: 0, y: 0, z: 0, a: angle, turret: angle + Math.sin(performance.now() / 900) * 0.6, def: car, shape: SHAPE[car.shape], team: 0,
    driver: driverById(save.driver), protect: 0, flashT: 0, flag: -1,
  };
  const s = Math.min(cv.width, cv.height) / 7.5;
  g.setTransform(s, 0, 0, s, cv.width / 2, cv.height / 2);
  g.fillStyle = 'rgba(0,0,0,0.35)';
  g.save(); g.translate(0.4, 0.5); g.rotate(angle); g.beginPath(); g.roundRect(-car.len / 2, -car.wid / 2, car.len, car.wid, 0.6); g.fill(); g.restore();
  Game.prototype.drawCar.call(fake, g, obj, performance.now() / 1000);
}
function renderGarage() {
  if (!garageSel) garageSel = save.car;
  $('#garage-coins').textContent = '💰 ' + fmt(save.coins);
  const list = $('#car-list'); list.innerHTML = '';
  for (const car of CARS) {
    const it = document.createElement('div');
    it.className = 'car-item' + (car.id === garageSel ? ' sel' : '');
    const owned = save.owned[car.id];
    const tag = save.car === car.id ? '<span class="ci-tag active">AKTIV</span>' : owned ? '<span class="ci-tag">Besitz</span>' : `<span class="ci-tag locked">💰 ${fmt(car.price)}</span>`;
    it.innerHTML = `<div><div class="ci-n">${car.name}</div><div class="ci-r">${car.role} · ${WEAPONS[car.weapon].name}</div></div>${tag}`;
    it.onclick = () => { garageSel = car.id; Sound.play('click'); renderGarage(); };
    list.appendChild(it);
  }
  const car = CARS.find(c => c.id === garageSel);
  const lv = save.up[car.id] || (save.up[car.id] = {});
  const st = carStats(car, lv), st0 = carStats(car, {});
  $('#car-name').textContent = car.name;
  $('#car-role').textContent = car.role + ' · ' + WEAPONS[car.weapon].name;
  $('#car-desc').textContent = car.desc;
  const owned = save.owned[car.id];
  const act = $('#car-action');
  if (!owned) {
    act.innerHTML = `<button class="btn buy big" ${save.coins < car.price ? 'disabled' : ''}>Kaufen für 💰 ${fmt(car.price)}</button>`;
    act.firstChild.onclick = () => {
      if (save.coins < car.price) return;
      save.coins -= car.price; save.owned[car.id] = true; save.car = car.id; writeSave();
      Sound.play('buy'); toast(car.name + ' gekauft!'); renderGarage();
    };
  } else if (save.car !== car.id) {
    act.innerHTML = `<button class="btn primary big">Dieses Auto fahren</button>`;
    act.firstChild.onclick = () => { save.car = car.id; writeSave(); Sound.play('click'); renderGarage(); };
  } else act.innerHTML = `<div class="hint">✅ Das ist dein aktives Auto.</div>`;
  // Werte
  const val = (s, k) => k === 'dps' ? carDps(car, s) : s[k];
  $('#car-stats').innerHTML = STAT_BARS.map(b => {
    const v = val(st, b.k), v0 = val(st0, b.k);
    const txt = b.k === 'speed' ? Math.round(v * 3.6) + ' km/h' : b.k === 'boost' ? v.toFixed(1) + ' s' : b.k === 'jump' ? (v * v / (2 * GRAV)).toFixed(1) + ' m' : b.k === 'rate' ? v.toFixed(1) + '/s' : Math.round(v);
    return `<div class="stat"><div class="sl"><span>${b.name}</span><b>${txt}</b></div><div class="sb"><i class="up" style="width:${clamp(v / b.max, 0, 1) * 100}%"></i><i style="width:${clamp(v0 / b.max, 0, 1) * 100}%"></i></div></div>`;
  }).join('');
  // Upgrades
  const up = $('#car-upgrades'); up.innerHTML = '';
  for (const u of UPGRADES) {
    const l = lv[u.id] || 0;
    const cost = upgradeCost(l);
    const d = document.createElement('div'); d.className = 'upg';
    const pips = Array.from({ length: MAX_LVL }, (_, i) => `<i class="${i < l ? 'on' : ''}"></i>`).join('');
    const can = owned && l < MAX_LVL && save.coins >= cost;
    d.innerHTML = `<div class="ui">${u.icon}</div><div><div class="un">${u.name}</div><div class="ud">${u.desc}</div><div class="pips">${pips}</div></div>` +
      (l >= MAX_LVL ? '<b style="margin-left:auto;color:#4fd06a">MAX</b>' : `<button class="btn buy" ${can ? '' : 'disabled'}>💰 ${fmt(cost)}</button>`);
    const btn = d.querySelector('button');
    if (btn) btn.onclick = () => {
      if (!owned) { toast('Kauf zuerst das Auto!'); return; }
      if (save.coins < cost) return;
      save.coins -= cost; lv[u.id] = l + 1; writeSave(); Sound.play('buy'); renderGarage();
    };
    if (!owned && btn) btn.title = 'Erst das Auto kaufen';
    up.appendChild(d);
  }
  // Vorschau animieren
  const cv = $('#car-preview');
  const t0 = performance.now();
  const anim = () => { carPreview(cv, car, -0.5 + (performance.now() - t0) / 2500); previewAnim = requestAnimationFrame(anim); };
  cancelAnimationFrame(previewAnim); anim();
}

// ---------------- Fahrer ----------------
function renderDrivers() {
  const wrap = $('#drivers'); wrap.innerHTML = '';
  const none = document.createElement('div');
  none.className = 'drv' + (!activeDrivers().some(d => d.id === save.driver) ? ' sel' : '');
  none.innerHTML = `${avatarHtml('', myName())}<div class="dn">Kein Foto</div>`;
  none.onclick = () => { save.driver = ''; writeSave(); Sound.play('click'); renderDrivers(); };
  wrap.appendChild(none);
  for (const d of activeDrivers()) {
    const el = document.createElement('div');
    el.className = 'drv' + (save.driver === d.id ? ' sel' : '');
    el.innerHTML = `<img src="${esc(driverSrc(d))}" alt=""><div class="dn">${esc(d.name)}</div>`;
    el.onclick = () => { save.driver = d.id; writeSave(); Sound.init(); Sound.play('click'); renderDrivers(); };
    wrap.appendChild(el);
  }
}

// ---------------- Verdrahtung ----------------
document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => { Sound.init(); Sound.play('click'); show(b.dataset.go); }));
$('#btn-start').onclick = () => startMatch(matchOpts());
$('#btn-resume').onclick = () => togglePause(false);
$('#btn-end-lobby').onclick = () => {
  if (!Net.active || Net.role !== 'host') return;
  if (game) { game.destroy(); game = null; }
  $('#scr-end').classList.add('hidden');
  Net.backToLobby();
  show('lobby');
};
$('#btn-restart').onclick = () => { $('#scr-pause').classList.add('hidden'); startMatch(matchOpts()); };
$('#btn-quit').onclick = () => quitToMenu();
$('#btn-again').onclick = () => startMatch(matchOpts());
$('#btn-end-garage').onclick = () => { if (game) { game.destroy(); game = null; } garageSel = save.car; show('garage'); startDemo(); };
$('#btn-end-menu').onclick = () => quitToMenu();
$('#opt-sound').onchange = e => { save.settings.sound = e.target.checked; Sound.setMuted(!e.target.checked); writeSave(); };
$('#opt-aim').onchange = e => { save.settings.autoAim = e.target.checked; writeSave(); };
$('#opt-3d').onchange = e => { save.settings.gfx3d = e.target.checked; writeSave(); stopDemo(); startDemo(); };

function togglePause(v) {
  if (!game || game.state === 'over') return;
  const el = $('#scr-pause');
  if (game.mode !== 'local') {
    // online wird nicht angehalten – nur das Menü einblenden
    const open = v === undefined ? el.classList.contains('hidden') : v;
    el.classList.toggle('hidden', !open);
    $('#scr-pause h2').textContent = open ? 'Menü (Spiel läuft weiter)' : 'Pause';
    return;
  }
  game.paused = v === undefined ? !game.paused : v;
  $('#scr-pause h2').textContent = 'Pause';
  el.classList.toggle('hidden', !game.paused);
  if (game.paused) Sound.engineStop();
}
Input.init(canvas);
Input.onKey = code => {
  if (code === 'Escape' || code === 'KeyP') togglePause();
  if (code === 'KeyC' && game && game.r3d && !game.demo) { save.settings.cam = game.toggleCam(); writeSave(); }
  if (game && !game.demo && /^Digit[123]$/.test(code)) game.requestUp(MATCH_UPS[+code.slice(5) - 1].k);
  if (code === 'KeyM') { save.settings.sound = !save.settings.sound; Sound.setMuted(!save.settings.sound); writeSave(); toast(save.settings.sound ? 'Sound an' : 'Sound aus'); }
};
Input.onWheel = dir => { if (game) game.zoom(dir); };
Input.onTouchUi = (x, y) => !!(game && !game.demo && game.tapUp(x, y));
document.addEventListener('visibilitychange', () => { if (document.hidden && game && game.mode === 'local' && !game.paused && game.state !== 'over') togglePause(true); });

// ---------------- Online ----------------
function netStatus(t, err) { const el = $('#net-status'); if (!el) return; el.textContent = t || ''; el.classList.toggle('err', !!err); }
function renderOnline() {
  netStatus(Net.available() ? '' : 'Online-Modul konnte nicht geladen werden. Internetverbindung prüfen und Seite neu laden.', !Net.available());
}
function roomLink() { return location.origin + location.pathname + '?raum=' + Net.code; }
const SEGS = {
  map: () => MAPS.map(m => [m.id, m.name]),
  size: () => [[2, '2v2'], [3, '3v3'], [4, '4v4'], [5, '5v5'], [6, '6v6']],
  diff: () => [[0, 'Leicht'], [1, 'Mittel'], [2, 'Schwer']],
  caps: () => [[3, '3'], [5, '5'], [7, '7']],
  time: () => [[300, '5 Min'], [480, '8 Min'], [720, '12 Min']],
  bots: () => [[true, 'Bots an'], [false, 'Bots aus']],
};
function renderLobby() {
  if (!Net.active) return;
  renderLobbyCar();
  const isHost = Net.role === 'host';
  $('#lobby-code').textContent = Net.code || '…';
  const S = Net.settings || {};
  for (const k of Object.keys(SEGS)) {
    seg($('#lseg-' + k), SEGS[k](), S[k], v => { save.settings[k] = v; Net.setSetting(k, v); }, !isHost);
  }
  $('#lobby-hostnote').textContent = isHost ? '' : '(legt der Host fest)';
  $('#btn-lobby-start').classList.toggle('hidden', !isHost);
  const humans = Net.players.length;
  $('#lobby-wait').textContent = isHost
    ? `${humans} Spieler im Raum. ${S.bots === false ? 'Ohne Bots – nur echte Spieler.' : 'Freie Plätze werden mit Bots aufgefüllt.'} Teile den Link oder Code mit deinen Freunden!`
    : 'Warte, bis der Host das Match startet …';
  for (let t = 0; t < 2; t++) {
    const el = $('#team-' + t); el.innerHTML = '';
    const list = Net.players.filter(p => p.team === t);
    for (const p of list) {
      const car = CARS.find(c => c.id === p.car) || CARS[0];
      const mine = p.pid === Net.myId;
      const row = document.createElement('div');
      row.className = 'pl' + (mine ? ' me' : '');
      const link = p.pid === 'host' ? '👑 Host' : p.link === 'rtc' ? '🟢 direkt verbunden' : p.link === 'relay' ? '🟡 über Server' : '⏳ verbindet …';
      row.innerHTML = `${avatarHtml(p.driver, p.name)}<div><div class="pn">${esc(p.name || 'Spieler')}${mine ? ' (Du)' : ''}</div><div class="pc">${esc(car.name)} · ${link}</div></div>`;
      if (mine || isHost) {
        const b = document.createElement('button'); b.className = 'btn'; b.textContent = t ? '← Rot' : 'Blau →';
        b.onclick = () => { Sound.play('click'); Net.setTeam(p.pid, t ? 0 : 1); };
        row.appendChild(b);
      }
      el.appendChild(row);
    }
    const size = S.bots === false ? 0 : (S.size || 4);
    for (let i = list.length; i < size; i++) {
      el.insertAdjacentHTML('beforeend', `<div class="pl bot"><div style="width:36px;height:36px;border-radius:50%;background:#333a48;display:grid;place-items:center">🤖</div><div><div class="pn">Bot</div><div class="pc">füllt auf</div></div></div>`);
    }
  }
}
Net.onLobby = () => { if (!$('#scr-lobby').classList.contains('hidden')) renderLobby(); };
// eigenes Fahrzeug in der Lobby wählen
function renderLobbyCar() {
  const me = Net.players.find(p => p.pid === Net.myId);
  renderLoadout($('#lobby-loadout'), me ? me.car : save.car, id => { save.car = id; writeSave(); Sound.play('click'); Net.setCar(id); });
}
Net.onError = msg => {
  if (game && game.mode !== 'local') { game.destroy(); game = null; $('#scr-end').classList.add('hidden'); $('#scr-pause').classList.add('hidden'); }
  show('online');
  netStatus(msg, true);
  toast(msg);
};
Net.onStart = opts => {
  opts.three = save.settings.gfx3d !== false; opts.camMode = save.settings.cam || 'chase';
  opts.autoAim = save.settings.autoAim || ('ontouchstart' in window && navigator.maxTouchPoints > 0);
  startMatch(opts);
};
Net.onSnapshot = snap => { if (game && game.isClient) game.applySnapshot(snap); };
Net.onEvents = ev => { if (game && game.isClient && Array.isArray(ev)) game.applyEvents(ev); };
Net.onPong = ts => { if (game && game.isClient) game.onPong(ts); };
Net.onInput = (pid, d) => { if (game && game.isHost) game.remoteInput(pid, d); };
Net.onDrop = pid => { if (game && game.isHost) game.dropHuman(pid); };
Net.onToLobby = () => {
  if (game) { game.destroy(); game = null; }
  $('#scr-end').classList.add('hidden'); $('#scr-pause').classList.add('hidden');
  show('lobby');
};
$('#btn-host').onclick = () => {
  if (!Net.available() || needName()) return;
  Sound.init(); netStatus('Erstelle Raum …');
  stopDemo();
  Net.host(() => { netStatus(''); show('lobby'); });
};
function needName() {
  if (cleanName(save.name)) return false;
  netStatus('Bitte gib zuerst im Hauptmenü deinen Namen ein.', true);
  const n = prompt('Wie heißt du? (Name für das Spiel)', '');
  if (n && cleanName(n)) { save.name = cleanName(n); writeSave(); return false; }
  return true;
}
function doJoin() {
  if (needName()) return;
  const code = $('#join-code').value.trim().toUpperCase();
  if (code.length < 5) { netStatus('Bitte den 5-stelligen Code eingeben.', true); return; }
  if (!Net.available()) return;
  Sound.init(); netStatus('Verbinde mit Raum ' + code + ' …');
  stopDemo();
  Net.join(code, () => { netStatus(''); show('lobby'); });
}
$('#btn-join').onclick = doJoin;
$('#join-code').addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') doJoin(); });
$('#join-code').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
$('#btn-lobby-leave').onclick = () => { Net.leave(); show('online'); };
$('#btn-lobby-start').onclick = () => {
  if (Net.role !== 'host') return;
  const opts = Net.startMatch();
  opts.three = save.settings.gfx3d !== false; opts.camMode = save.settings.cam || 'chase';
  opts.autoAim = save.settings.autoAim || ('ontouchstart' in window && navigator.maxTouchPoints > 0);
  startMatch(opts);
};
$('#btn-copy').onclick = async () => {
  const link = roomLink();
  try { await navigator.clipboard.writeText(link); toast('Link kopiert!'); }
  catch (e) { prompt('Diesen Link an deine Freunde schicken:', link); }
};
// Online-Seiten nicht in den Menü-Hintergrund-Demo wechseln
const _show = show;
show = function (id) {
  if (id === 'menu' && Net.active) Net.leave();
  _show(id);
  if ((id === 'online' || id === 'lobby') && demo) { /* Demo darf weiterlaufen */ }
};

Sound.setMuted(!save.settings.sound);
loadAdminAssets().finally(() => loadDriverImages(() => {
  $('#loading').remove();
  const code = new URLSearchParams(location.search).get('raum');
  if (code) {
    show('online');
    $('#join-code').value = code.toUpperCase().slice(0, 5);
    history.replaceState(null, '', location.pathname);
    doJoin();
  } else show('menu');
}));
