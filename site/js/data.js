'use strict';
// ---------------------------------------------------------------------------
// Spieldaten: Fahrzeuge, Upgrades, Fahrer
// ---------------------------------------------------------------------------

const TEAM = [
  { name: 'Team Rot', short: 'ROT', color: '#e8423a', dark: '#8f1f19', light: '#ff8c7f' },
  { name: 'Team Blau', short: 'BLAU', color: '#3a7be8', dark: '#173f8a', light: '#8fb8ff' },
];

// Upgrade-Kategorien (je 5 Stufen)
const UPGRADES = [
  { id: 'motor', name: 'Motor', icon: '⚙️', desc: 'Höchstgeschwindigkeit & Beschleunigung' },
  { id: 'panzer', name: 'Panzerung', icon: '🛡️', desc: 'Mehr Lebenspunkte' },
  { id: 'waffe', name: 'Waffe', icon: '💥', desc: 'Mehr Schaden pro Treffer' },
  { id: 'feuer', name: 'Feuerrate', icon: '🔥', desc: 'Schneller schießen' },
  { id: 'turbo', name: 'Turbo', icon: '🚀', desc: 'Größerer Tank & schnellere Ladung' },
  { id: 'sprung', name: 'Sprungfeder', icon: '🦘', desc: 'Höher & öfter springen' },
];
const MAX_LVL = 5;
function upgradeCost(lvl) { return Math.round(150 * Math.pow(lvl + 1, 1.6) / 10) * 10; }

// Waffen
const WEAPONS = {
  mg: { name: 'Doppel-MG', speed: 125, life: 0.5, spread: 0.035, count: 1, splash: 0, size: 0.35, color: '#ffe27a', sound: 'mg' },
  minigun: { name: 'Minigun', speed: 120, life: 0.48, spread: 0.085, count: 1, splash: 0, size: 0.3, color: '#ffd04d', sound: 'mini' },
  cannon: { name: 'Kanone', speed: 72, life: 1.1, spread: 0.01, count: 1, splash: 4.5, size: 0.7, color: '#ffb347', sound: 'cannon' },
  rocket: { name: 'Raketen', speed: 42, life: 1.9, spread: 0.02, count: 1, splash: 5, size: 0.55, color: '#ff7b39', homing: 0.55, accel: 22, maxSpeed: 68, sound: 'rocket' },
  shotgun: { name: 'Schrotflinte', speed: 95, life: 0.3, spread: 0.24, count: 7, splash: 0, size: 0.3, color: '#fff1b0', sound: 'shotgun' },
};

// Fahrzeugklassen (alle frei wählbar). base = Stufe 0, per = Zuwachs pro Garagen-Upgrade
const CARS = [
  {
    id: 'flitzer', name: 'Schussen-Flitzer', role: 'Ausgewogen', price: 0, shape: 'sport', weapon: 'mg',
    desc: 'Der Allrounder: ordentliches Tempo, solide Panzerung, präzises Doppel-MG.',
    len: 4.4, wid: 2.0, radius: 1.55, mass: 1.1,
    base: { speed: 31, accel: 23, turn: 3.2, hp: 115, dmg: 7.5, rate: 6.5, boost: 2.2, jump: 9 },
    per: { speed: 1.3, accel: 1.3, hp: 12, dmg: 1.0, rate: 0.6, boost: 0.3, jump: 0.6 },
  },
  {
    id: 'hornisse', name: 'Hornisse', role: 'Schneller Buggy', price: 0, shape: 'buggy', weapon: 'minigun',
    desc: 'Leichter Buggy: das schnellste Fahrzeug, dünnes Blech, Minigun mit Dauerfeuer. Ideal zum Flaggenklauen.',
    len: 3.9, wid: 2.3, radius: 1.55, mass: 0.95,
    base: { speed: 35, accel: 27, turn: 3.4, hp: 78, dmg: 3.0, rate: 16, boost: 2.4, jump: 9 },
    per: { speed: 1.3, accel: 1.3, hp: 9, dmg: 0.4, rate: 1.4, boost: 0.3, jump: 0.6 },
  },
  {
    id: 'panzer', name: 'Mehlsack-Panzer', role: 'Schwerer Truck', price: 0, shape: 'tank', weapon: 'cannon',
    desc: 'Langsam und schwer gepanzert. Die Kanone braucht Nachladezeit, haut aber alles weg.',
    len: 5.2, wid: 2.9, radius: 2.0, mass: 2.6,
    base: { speed: 23, accel: 14, turn: 2.4, hp: 250, dmg: 42, rate: 0.85, boost: 1.8, jump: 7.5 },
    per: { speed: 1.0, accel: 0.9, hp: 26, dmg: 4, rate: 0.08, boost: 0.2, jump: 0.5 },
  },
  {
    id: 'rudi', name: 'Raketen-Rudi', role: 'Explosiv', price: 0, shape: 'jeep', weapon: 'rocket',
    desc: 'Pickup mit Zielsuch-Raketen und Flächenschaden. Stark gegen Gruppen, schwach im Nahkampf.',
    len: 4.7, wid: 2.3, radius: 1.75, mass: 1.4,
    base: { speed: 28, accel: 19, turn: 2.9, hp: 140, dmg: 28, rate: 1.4, boost: 2.0, jump: 8.5 },
    per: { speed: 1.2, accel: 1.1, hp: 15, dmg: 3, rate: 0.12, boost: 0.25, jump: 0.6 },
  },
  {
    id: 'bock', name: 'Allgäu-Bock', role: 'Springer', price: 0, shape: 'truck', weapon: 'shotgun',
    desc: 'Geländewagen mit Monster-Federung: springt am höchsten, Schrotflinte für den Nahkampf.',
    len: 4.8, wid: 2.4, radius: 1.8, mass: 1.6,
    base: { speed: 29, accel: 21, turn: 3.0, hp: 165, dmg: 5.5, rate: 1.6, boost: 2.4, jump: 11.5 },
    per: { speed: 1.2, accel: 1.2, hp: 17, dmg: 0.6, rate: 0.15, boost: 0.25, jump: 0.8 },
  },
];

// Upgrades während des Matches (mit XP freigeschaltet, gelten nur für die Runde)
const MATCH_UPS = [
  { k: 'spd', name: 'Tempo', icon: '⚡', key: '1', desc: '+7 % Tempo & Beschleunigung' },
  { k: 'arm', name: 'Panzerung', icon: '🛡️', key: '2', desc: '+15 % Lebenspunkte' },
  { k: 'dmg', name: 'Waffe', icon: '💥', key: '3', desc: '+12 % Schaden' },
];
const MATCH_UP_MAX = 3;
const XP = { kill: 100, assist: 40, pickup: 50, capture: 300, ret: 60, perLevel: 200 };

// Upgrade-Stufen -> konkrete Werte
function carStats(car, lv, ups) {
  lv = lv || {}; ups = ups || {};
  const us = 1 + 0.07 * (ups.spd || 0), ua = 1 + 0.15 * (ups.arm || 0), ud = 1 + 0.12 * (ups.dmg || 0);
  const b = car.base, p = car.per;
  const m = lv.motor || 0, a = lv.panzer || 0, w = lv.waffe || 0, f = lv.feuer || 0, t = lv.turbo || 0, s = lv.sprung || 0;
  return {
    speed: (b.speed + p.speed * m) * us,
    accel: (b.accel + p.accel * m) * us,
    turn: b.turn + 0.04 * m,
    hp: Math.round((b.hp + p.hp * a) * 1.7 * ua),
    dmg: (b.dmg + p.dmg * w) * ud,
    rate: b.rate + p.rate * f,
    boost: (b.boost + p.boost * t) * 1.5,
    boostRegen: 0.5 + 0.06 * t,
    jump: (b.jump + p.jump * s) * 1.5,   // hoch genug, um mit Nitro über Dächer zu springen
    jumpCd: Math.max(0.9, 2.2 - 0.25 * s),
  };
}

// Für die Balken in der Garage
const STAT_BARS = [
  { k: 'speed', name: 'Tempo', max: 42 },
  { k: 'hp', name: 'Schutz', max: 740 },
  { k: 'dps', name: 'Feuerkraft', max: 90 },
  { k: 'rate', name: 'Feuerrate', max: 26 },
  { k: 'boost', name: 'Nitro', max: 6.5 },
  { k: 'jump', name: 'Sprung', max: 24 },
];
function carDps(car, st) {
  const w = WEAPONS[car.weapon];
  return st.dmg * st.rate * w.count * (w.splash ? 1.25 : 1) * (w.count > 1 ? 0.75 : 1);
}

// Fahrer aus dem Drive-Ordner "Fette Bilder"
const DRIVERS = [
  { id: 'marlon', name: 'Marlon Müllermilch' },
  { id: 'benjamin', name: 'Benjamin Keindiät' },
  { id: 'joos', name: 'Joos Tomek Butter' },
  { id: 'eric', name: 'Eric Fressloch' },
  { id: 'nick', name: 'Nick Speckard' },
  { id: 'luca', name: 'Luca Justus Kalorius' },
  { id: 'mampfius', name: 'Mampfius Fuchs' },
  { id: 'alexandru', name: 'Alexandru Marzipan' },
  { id: 'michael', name: 'Michael Bäuchle' },
  { id: 'marco', name: 'Marco Knödelmauer' },
  { id: 'dean', name: 'Dean Sorgfett' },
  { id: 'tim', name: 'Tim Knabber' },
  { id: 'quarktin', name: 'Quarktin Skittles' },
  { id: 'kalorientin', name: 'Kalorientin Weixler' },
];
// Welche Bilder aktiv sind, legt der Admin fest (Supabase-Tabelle ctf_images, siehe admin.html).
// Ohne Verbindung sind alle eingebauten Bilder aktiv.
const DRIVER_IMG = {};
const ADMIN_ASSETS = { loaded: false, inactive: new Set() };
function driverSrc(d) { return d.url || ('img/fahrer/' + d.id + '.jpg'); }
function activeDrivers() { return DRIVERS.filter(d => !ADMIN_ASSETS.inactive.has(d.id)); }
function loadDriverImages(done) {
  let left = DRIVERS.length;
  if (!left && done) done();
  for (const d of DRIVERS) {
    const im = new Image();
    if (d.url) im.crossOrigin = 'anonymous';
    im.onload = im.onerror = () => { if (--left === 0 && done) done(); };
    im.src = driverSrc(d);
    DRIVER_IMG[d.id] = im;
  }
}
function driverById(id) { return DRIVERS.find(d => d.id === id) || { id: '', name: 'Bot' }; }
// Liste vom Server holen (öffentlich lesbar, schreiben nur über die Admin-Funktion)
async function loadAdminAssets() {
  try {
    if (!window.supabase || typeof SUPA_URL === 'undefined') return;
    const sb = window.supabase.createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    const res = await Promise.race([sb.from('ctf_images').select('id,name,file,bundled,active'), new Promise(r => setTimeout(() => r({ error: 'timeout' }), 5000))]);
    if (res.error || !Array.isArray(res.data)) return;
    for (const row of res.data) {
      if (!row.active) ADMIN_ASSETS.inactive.add(row.id);
      if (!row.bundled && row.file && !DRIVERS.some(d => d.id === row.id)) {
        DRIVERS.push({ id: row.id, name: row.name, url: SUPA_URL + '/storage/v1/object/public/ctf-images/' + row.file });
      } else {
        const d = DRIVERS.find(x => x.id === row.id);
        if (d && row.name) d.name = row.name;
      }
    }
    ADMIN_ASSETS.loaded = true;
  } catch (e) { /* offline: alles bleibt aktiv */ }
}

// Belohnungen (Kohle)
const REWARD = { kill: 100, assist: 40, pickup: 50, capture: 400, ret: 75, win: 600, lose: 200, draw: 350 };
