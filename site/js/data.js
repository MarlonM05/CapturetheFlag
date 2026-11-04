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
  rocket: { name: 'Raketen', speed: 48, life: 1.7, spread: 0.02, count: 1, splash: 5, size: 0.55, color: '#ff7b39', homing: 2.2, accel: 40, sound: 'rocket' },
  shotgun: { name: 'Schrotflinte', speed: 95, life: 0.3, spread: 0.24, count: 7, splash: 0, size: 0.3, color: '#fff1b0', sound: 'shotgun' },
};

// Fahrzeuge. base = Stufe 0, per = Zuwachs pro Upgrade-Stufe
const CARS = [
  {
    id: 'flitzer', name: 'Schussen-Flitzer', role: 'Schnell', price: 0, shape: 'sport', weapon: 'mg',
    desc: 'Der schnellste Wagen im Schussental. Perfekt zum Flaggenklauen – hält aber kaum etwas aus.',
    len: 4.4, wid: 2.0, radius: 1.55, mass: 1.0,
    base: { speed: 34, accel: 25, turn: 3.4, hp: 85, dmg: 7, rate: 7, boost: 2.6, jump: 9 },
    per: { speed: 1.5, accel: 1.4, hp: 10, dmg: 1.0, rate: 0.7, boost: 0.3, jump: 0.6 },
  },
  {
    id: 'hornisse', name: 'Hornisse', role: 'Schnelles Feuer', price: 1200, shape: 'buggy', weapon: 'minigun',
    desc: 'Offener Buggy mit Minigun. Spuckt Kugeln wie ein Rasensprenger.',
    len: 3.9, wid: 2.3, radius: 1.55, mass: 1.1,
    base: { speed: 30, accel: 22, turn: 3.3, hp: 105, dmg: 3.3, rate: 17, boost: 2.0, jump: 8.5 },
    per: { speed: 1.2, accel: 1.2, hp: 12, dmg: 0.45, rate: 1.6, boost: 0.25, jump: 0.6 },
  },
  {
    id: 'panzer', name: 'Mehlsack-Panzer', role: 'Guter Schutz', price: 2500, shape: 'tank', weapon: 'cannon',
    desc: 'Schwer wie der Mehlsack-Turm. Langsam, aber die Kanone haut alles weg.',
    len: 5.2, wid: 2.9, radius: 2.0, mass: 2.6,
    base: { speed: 21, accel: 13, turn: 2.3, hp: 280, dmg: 38, rate: 1.0, boost: 1.6, jump: 7 },
    per: { speed: 1.0, accel: 0.9, hp: 30, dmg: 4, rate: 0.1, boost: 0.2, jump: 0.5 },
  },
  {
    id: 'rudi', name: 'Raketen-Rudi', role: 'Explosiv', price: 3200, shape: 'jeep', weapon: 'rocket',
    desc: 'Pickup mit Zielsuch-Raketen. Flächenschaden für Kreuzungs-Chaos.',
    len: 4.7, wid: 2.3, radius: 1.75, mass: 1.4,
    base: { speed: 27, accel: 18, turn: 2.8, hp: 140, dmg: 26, rate: 1.5, boost: 2.0, jump: 8 },
    per: { speed: 1.2, accel: 1.1, hp: 16, dmg: 3, rate: 0.15, boost: 0.25, jump: 0.6 },
  },
  {
    id: 'bock', name: 'Allgäu-Bock', role: 'Springer', price: 0, shape: 'truck', weapon: 'shotgun',
    desc: 'Geländewagen mit Monster-Federung und Schrotflinte. Springt über alles.',
    len: 4.8, wid: 2.4, radius: 1.8, mass: 1.6,
    base: { speed: 28, accel: 20, turn: 3.0, hp: 160, dmg: 5.2, rate: 1.6, boost: 2.2, jump: 11.5 },
    per: { speed: 1.2, accel: 1.2, hp: 18, dmg: 0.6, rate: 0.16, boost: 0.25, jump: 0.8 },
  },
];

// Upgrade-Stufen -> konkrete Werte
function carStats(car, lv) {
  lv = lv || {};
  const b = car.base, p = car.per;
  const m = lv.motor || 0, a = lv.panzer || 0, w = lv.waffe || 0, f = lv.feuer || 0, t = lv.turbo || 0, s = lv.sprung || 0;
  return {
    speed: b.speed + p.speed * m,
    accel: b.accel + p.accel * m,
    turn: b.turn + 0.04 * m,
    hp: Math.round((b.hp + p.hp * a) * 1.7),
    dmg: b.dmg + p.dmg * w,
    rate: b.rate + p.rate * f,
    boost: b.boost + p.boost * t,
    boostRegen: 0.22 + 0.04 * t,
    jump: b.jump + p.jump * s,
    jumpCd: Math.max(0.9, 2.2 - 0.25 * s),
  };
}

// Für die Balken in der Garage
const STAT_BARS = [
  { k: 'speed', name: 'Tempo', max: 42 },
  { k: 'hp', name: 'Schutz', max: 740 },
  { k: 'dps', name: 'Feuerkraft', max: 90 },
  { k: 'rate', name: 'Feuerrate', max: 26 },
  { k: 'boost', name: 'Turbo', max: 4.2 },
  { k: 'jump', name: 'Sprung', max: 16 },
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
const DRIVER_IMG = {};
function loadDriverImages(done) {
  let left = DRIVERS.length;
  for (const d of DRIVERS) {
    const im = new Image();
    im.onload = im.onerror = () => { if (--left === 0 && done) done(); };
    im.src = 'img/fahrer/' + d.id + '.jpg';
    DRIVER_IMG[d.id] = im;
  }
}
function driverById(id) { return DRIVERS.find(d => d.id === id) || DRIVERS[0]; }

// Belohnungen (Kohle)
const REWARD = { kill: 100, assist: 40, pickup: 50, capture: 400, ret: 75, win: 600, lose: 200, draw: 350 };
