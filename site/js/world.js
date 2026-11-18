'use strict';
// ---------------------------------------------------------------------------
// Welt: Kartendaten aufbereiten, Kollision, Navigation, Boden-Kacheln
// Einheiten: Meter
// ---------------------------------------------------------------------------

const COL = {
  outside: '#2b2e2a',
  ground: '#a7a092',     // Stadtboden: helles Pflaster statt Rasenfläche
  paved: '#b2ab9d',
  green: '#5d8c45',
  sand: '#d9c58c',
  water: '#2f6db0',
  waterEdge: '#5b9bd8',
  sidewalk: '#aaa498',
  asphalt: '#4a4d53',
  asphaltMain: '#43464c',
  foot: '#b7ae9c',
  rail: '#6d6257',
  stream: '#3f86c9',
};
const ROOF = ['#b5533c', '#9c3f2c', '#c4623e', '#a8492f', '#8e3b2e', '#b85a3a', '#7f4a3a'];   // rote Ziegeldächer
// warme Pastelltöne wie in oberschwäbischen Altstädten (Ocker, Rosé, Salbei, Creme, Hellblau)
const WALL = ['#f3dfae', '#efc79a', '#e8b8a6', '#f5ead2', '#cfe0d6', '#f2d4c4', '#e4d7a8', '#f7e7c1', '#d8e4ea', '#f4c7b0', '#e9d2dc', '#dfe8c4', '#f0dcb8', '#e6c8a8'];

const TILE_PX = 512;       // Kachelgröße in Pixeln (Meter = TILE_PX / Zoom)
const NAV = 2;             // Navigationsraster in Metern
const STEP = 0.9;          // so hohe Kanten fährt ein Auto einfach hoch
const DECK_T = 1.2;        // Dicke einer Brückenplatte
const STEEP = 0.45;        // ab dieser Steigung ist Gelände eine Wand (für Bots)
const HASH = 8;            // Kollisions-Hash in Metern
const CAM_H = 170;         // Kamerahöhe für die Perspektive

function polyBBox(p) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    const x = p[i], y = p[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}
function pointInPoly(p, x, y) {
  let inside = false;
  for (let i = 0, j = p.length - 2; i < p.length; j = i, i += 2) {
    const xi = p[i], yi = p[i + 1], xj = p[j], yj = p[j + 1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const clampW = (v, a, b) => (v < a ? a : v > b ? b : v);
const ssW = v => (v <= 0 ? 0 : v >= 1 ? 1 : v * v * (3 - 2 * v));
function hash32(n) { n = (n ^ 61) ^ (n >>> 16); n = n + (n << 3); n = n ^ (n >>> 4); n = Math.imul(n, 0x27d4eb2d); return (n ^ (n >>> 15)) >>> 0; }

class World {
  constructor(map) {
    this.map = map;
    this.w = map.w; this.h = map.h;
    this.hw = Math.ceil(this.w / HASH); this.hh = Math.ceil(this.h / HASH);
    // Höhenkarte (Dezimeter, Int16, Base64)
    this.hz = null;
    if (map.terrain) {
      const T = map.terrain, bin = atob(T.data);
      const n = T.nx * T.ny, hz = new Float32Array(n);
      for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v > 32767) v -= 65536; hz[i] = v / 10; }
      this.hz = hz; this.tres = T.res; this.tnx = T.nx; this.tny = T.ny;
    }
    const nCells = this.hw * this.hh;
    const addHash = (arr, bb, item, pad = 0) => {
      const x0 = Math.max(0, Math.floor((bb[0] - pad) / HASH)), x1 = Math.min(this.hw - 1, Math.floor((bb[2] + pad) / HASH));
      const y0 = Math.max(0, Math.floor((bb[1] - pad) / HASH)), y1 = Math.min(this.hh - 1, Math.floor((bb[3] + pad) / HASH));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) arr[y * this.hw + x].push(item);
    };
    this.water = map.water.map(w => Array.isArray(w) ? { p: w, z: -0.3, bb: polyBBox(w) } : { p: w.p, z: w.z, bb: polyBBox(w.p) });
    this.hWater = Array.from({ length: nCells }, () => []);
    this.water.forEach(w => addHash(this.hWater, w.bb, w));

    const isRW = map.id === 'schussental' || map.id === 'ravensburg' || !map.id;
    this.isRW = isRW;
    // Zusätzliche befahrbare Tunnel unter den Hügeln (Martinsberg, Kirchberg, Veitsburg)
    // Geländefolgende Profile (Bodenhöhe alle ~30 m): Portale auf Geländehöhe, im Berg ausreichend Überdeckung
    const extraTunnels = [
      { name: 'Martinsberg-Tunnel', w: 16, hgt: 8.5, p: [135,110,15.8,135,140,15.8,135,170,15.8,135,200,15.8,135,230,15.8,135,260,15.8,135,290,16.2,135,320,16.7,135,350,16.3,135,380,15.9,135,410,15.9,135,440,15.9,135,470,15.9,135,500,15.9] },
      { name: 'Kirchberg-Tunnel', w: 16, hgt: 8.5, p: [675,230,14,705,230,14.2,735,230,14.5,765,230,14.7,795,230,15,825,230,15.2,855,230,15.5,885,230,15.8,915,230,16,945,230,16.3,975,230,16.5,1005,230,16.8,1035,230,17.1] },
      { name: 'Veitsburg-Tunnel', w: 16, hgt: 8.5, p: [740,1795,0.5,770,1795,0.6,800,1795,0.7,830,1795,3.1,860,1795,5.5,890,1795,7.9,920,1795,7.2,950,1795,4.8,980,1795,2.4,1010,1795,2.2] },
    ];
    const allTunnels = (map.tunnels || []).concat(
      isRW ? extraTunnels.filter(et => !(map.tunnels || []).some(t => t.name === et.name)) : []
    );
    this.hTunFlat = Array.from({ length: nCells }, () => []);
    this.tunnels = allTunnels.map(t0 => {
      // Mindestmaße: breit und hoch genug, damit kein Fahrzeug hängen bleibt
      const t = { ...t0, w: Math.max(t0.w, 16), hgt: Math.max(t0.hgt, 8.5) };
      const segs = []; let acc = 0;
      for (let i = 0; i + 5 < t.p.length; i += 3) {
        const [ax, ay, az, bx, by, bz] = t.p.slice(i, i + 6), L = Math.hypot(bx - ax, by - ay) || 1;
        const padS = t.w / 2 + 24;
        segs.push({ ax, ay, az, bx, by, bz, L, acc0: acc, bb: [Math.min(ax, bx) - padS, Math.min(ay, by) - padS, Math.max(ax, bx) + padS, Math.max(ay, by) + padS] });
        acc += L;
      }
      const xs = t.p.filter((_, i) => i % 3 === 0), ys = t.p.filter((_, i) => i % 3 === 1);
      const pad = t.w / 2 + 48;
      const tn = { segs, w: t.w, hw: t.w / 2, hgt: t.hgt, name: t.name, p: t.p, totalLen: acc, portals: [], bb: [Math.min(...xs) - t.w, Math.min(...ys) - t.w, Math.max(...xs) + t.w, Math.max(...ys) + t.w], fbb: [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad] };
      addHash(this.hTunFlat, tn.fbb, tn);
      return tn;
    });
    // Portale (Außenrichtung o) – für Geländeeinschnitt, Flügelwände und Portalhallen
    this.portals = [];
    for (const tn of this.tunnels) {
      const s0 = tn.segs[0], s1 = tn.segs[tn.segs.length - 1];
      const p0 = { x: s0.ax, y: s0.ay, z: s0.az, ox: -(s0.bx - s0.ax) / s0.L, oy: -(s0.by - s0.ay) / s0.L, hw: tn.hw, hgt: tn.hgt, tn };
      const p1 = { x: s1.bx, y: s1.by, z: s1.bz, ox: (s1.bx - s1.ax) / s1.L, oy: (s1.by - s1.ay) / s1.L, hw: tn.hw, hgt: tn.hgt, tn };
      tn.portals.push(p0, p1);
      this.portals.push(p0, p1);
    }
    this.landmarks = map.landmarks || [];
    this.rails = (map.rails || []).map(r => ({ ax: r.p[0], ay: r.p[1], az: r.p[2], bx: r.p[3], by: r.p[4], bz: r.p[5], w: !!r.w }));

    // Bodenrampen früh initialisieren, damit Gelände-Glättung vor Gebäuden und Brücken wirkt
    const extraRamps = isRW ? [
      // Fluss-Sprungschanzen über die Schussen (mit sauberem Abstand zum Ufer)
      { x: 365, y: 844, a: Math.PI / 2, l: 9, w: 10, b: 1 },
      { x: 365, y: 891, a: -Math.PI / 2, l: 9, w: 10, b: 1 },
      { x: 485, y: 843, a: Math.PI / 2, l: 9, w: 10, b: 1 },
      { x: 485, y: 890, a: -Math.PI / 2, l: 9, w: 10, b: 1 },
      { x: 915, y: 848, a: Math.PI / 2, l: 9, w: 10, b: 1 },
      { x: 915, y: 896, a: -Math.PI / 2, l: 9, w: 10, b: 1 },
      { x: 1035, y: 847, a: Math.PI / 2, l: 9, w: 10, b: 1 },
      { x: 1035, y: 894, a: -Math.PI / 2, l: 9, w: 10, b: 1 },
      // Weingarten: Hauptachsen & Tunnelzufahrten
      { x: 545, y: 245, a: 0, l: 8, w: 6, b: 1 },
      { x: 436, y: 224, a: Math.PI / 2, l: 8, w: 6, b: 0 },
      { x: 430, y: 490, a: -Math.PI / 2, l: 8, w: 6, b: 0 },
      { x: 267, y: 316, a: 0, l: 8, w: 6, b: 1 },
      { x: 636, y: 492, a: -Math.PI / 4, l: 8, w: 6, b: 1 },
      { x: 135, y: 555, a: -Math.PI / 2, l: 8, w: 6, b: 0 },
      // Schussental & Brücken-Sprungschanzen
      { x: 295, y: 785, a: Math.PI / 2, l: 8, w: 6, b: 1 },
      { x: 292, y: 942, a: -Math.PI / 2, l: 8, w: 6, b: 1 },
      { x: 590, y: 948, a: Math.PI / 2, l: 8, w: 6, b: 0 },
      { x: 590, y: 1120, a: -Math.PI / 2, l: 8, w: 6, b: 0 },
      { x: 845, y: 780, a: Math.PI / 2, l: 8, w: 6, b: 1 },
      // Ravensburg: Marienplatz, Altstadt & Veitsburg-Zufahrt
      { x: 578, y: 1480, a: Math.PI / 2, l: 8, w: 6, b: 1 },
      { x: 595, y: 1720, a: -Math.PI / 2, l: 8, w: 6, b: 1 },
      { x: 410, y: 1610, a: 0, l: 8, w: 6, b: 1 },
      { x: 705, y: 1630, a: 0, l: 8, w: 6, b: 1 },
      { x: 700, y: 1795, a: 0, l: 8, w: 6, b: 0 },
      // Neue Flanken-Schanzen auf West- (x=55) und Ost-Flanke (x=1255)
      { x: 55, y: 360, a: Math.PI / 2, l: 9, w: 7, b: 1 },
      { x: 55, y: 690, a: Math.PI / 2, l: 9, w: 7, b: 1 },
      { x: 55, y: 1360, a: -Math.PI / 2, l: 9, w: 7, b: 1 },
      { x: 1255, y: 380, a: Math.PI / 2, l: 9, w: 7, b: 1 },
      { x: 1255, y: 690, a: Math.PI / 2, l: 9, w: 7, b: 1 },
      { x: 1255, y: 1380, a: -Math.PI / 2, l: 9, w: 7, b: 1 },
    ] : [];
    this.ramps = map.ramps.concat(extraRamps).map(r => ({
      ...r, len: r.l || 7, wid: r.w || 5, big: !!r.b,
      ca: Math.cos(r.a), sa: Math.sin(r.a), baseZ: this.rawTerrain(r.x, r.y)
    }));
    this.hFlat = Array.from({ length: nCells }, () => []);
    for (const r of this.ramps) {
      if (r.rz !== undefined || this.inWater(r.x, r.y)) continue;
      const pad = Math.max(r.len, r.wid) * 0.6 + 6;
      addHash(this.hFlat, [r.x - pad, r.y - pad, r.x + pad, r.y + pad], r);
    }

    // Freizuhaltende Korridore (Tunnelportale & linke/rechte Außenflanken)
    const inApron = (x, y) => this.portals.some(p => {
      const d = (x - p.x) * p.ox + (y - p.y) * p.oy;
      const lat = Math.abs(-(x - p.x) * p.oy + (y - p.y) * p.ox);
      return d >= -10 && d <= 26 && lat <= p.hw + 5;
    });
    const inFlankCorridor = (x, y) => {
      if (!isRW) return false;
      if (x >= 42 && x <= 68 && y >= 55 && y <= 1815) return true;
      if (x >= 1242 && x <= 1268 && y >= 55 && y <= 1815) return true;
      if (x >= 45 && x <= 145 && ((y >= 82 && y <= 108) || (y >= 507 && y <= 533))) return true;
      if (x >= 45 && x <= 150 && y >= 1782 && y <= 1808) return true;
      if (x >= 1060 && x <= 1265 && y >= 152 && y <= 178) return true;
      if (x >= 1210 && x <= 1265 && y >= 287 && y <= 313) return true;
      if (x >= 1045 && x <= 1265 && y >= 1307 && y <= 1333) return true;
      if (x >= 1005 && x <= 1265 && y >= 1782 && y <= 1808) return true;
      return false;
    };
    const polyClearZone = (p, bb) => {
      for (let i = 0; i < p.length; i += 2) if (inApron(p[i], p[i + 1]) || inFlankCorridor(p[i], p[i + 1])) return true;
      const cx = (bb[0] + bb[2]) * 0.5, cy = (bb[1] + bb[3]) * 0.5;
      if (inApron(cx, cy) || inFlankCorridor(cx, cy)) return true;
      // Auch lange Gebäude quer über den x=55 / x=1255 Korridor prüfen
      if (isRW && bb[3] >= 55 && bb[1] <= 1815 && ((bb[0] <= 66 && bb[2] >= 44) || (bb[0] <= 1266 && bb[2] >= 1244))) return true;
      return false;
    };
    // Flachdach-Netzwerke (Weingarten West/Ost, Schussental Nord/Süd, Ravensburg Altstadt)
    const skyRoofPts = isRW ? [
      [394.8, 274.3], [400.3, 237.5], [400, 212], [428.8, 209], [430, 173.5],
      [1122.5, 378.9], [1152.8, 347.1], [1128.8, 321.8], [1088.1, 289.2],
      [1046.8, 738.4], [1014.4, 741.3], [978.1, 775], [945.6, 792.7], [906.5, 793],
      [1003.7, 983.3], [1047.2, 994.5], [1064.5, 973.9], [1081.9, 940.2], [1062.2, 926.1],
      [509.8, 1546.8], [510.4, 1594.6], [484.8, 1640.6], [521.2, 1668.3], [513.1, 1686.4],
    ] : [];

    this.buildings = map.buildings.filter(b => {
      if (b.lm) return true;
      const bb = polyBBox(b.p);
      return !polyClearZone(b.p, bb);
    }).map((b, i) => {
      const bb = polyBBox(b.p);
      let cx = 0, cy = 0; const n = b.p.length / 2;
      for (let k = 0; k < b.p.length; k += 2) { cx += b.p[k]; cy += b.p[k + 1]; }
      cx /= n; cy /= n;
      // längste Kante -> Firstrichtung
      let best = 0, ang = 0;
      for (let k = 0; k < b.p.length; k += 2) {
        const k2 = (k + 2) % b.p.length;
        const dx = b.p[k2] - b.p[k], dy = b.p[k2 + 1] - b.p[k + 1];
        const l = dx * dx + dy * dy;
        if (l > best) { best = l; ang = Math.atan2(dy, dx); }
      }
      // Ausdehnung entlang der Firstachse
      const ca = Math.cos(ang), sa = Math.sin(ang);
      let mn = Infinity, mx = -Infinity, mn2 = Infinity, mx2 = -Infinity;
      for (let k = 0; k < b.p.length; k += 2) {
        const u = (b.p[k] - cx) * ca + (b.p[k + 1] - cy) * sa;
        const v = -(b.p[k] - cx) * sa + (b.p[k + 1] - cy) * ca;
        if (u < mn) mn = u; if (u > mx) mx = u; if (v < mn2) mn2 = v; if (v > mx2) mx2 = v;
      }
      const hsh = hash32(i * 7919 + 13);
      const isSkyRoof = skyRoofPts.some(([rx, ry]) => Math.hypot(cx - rx, cy - ry) < 1.5);
      const flat = b.c === 4 || b.h < 4 || isSkyRoof;
      // auf Hängen: Sockel am tiefsten Punkt, Dach über dem höchsten
      let tmin = Infinity, tmax = -Infinity;
      for (let k = 0; k < b.p.length; k += 2) { const t = this.terrain(b.p[k], b.p[k + 1]); if (t < tmin) tmin = t; if (t > tmax) tmax = t; }
      return {
        p: b.p, h: b.h, c: b.c, n: b.n, bb, cx, cy, ang, flat, isSkyRoof, lm: !!b.lm,
        base: tmin - 0.5, top: tmax + b.h,
        ridge: flat ? null : [cx + ca * (mn * 0.72), cy + sa * (mn * 0.72), cx + ca * (mx * 0.72), cy + sa * (mx * 0.72)],
        wall: WALL[hsh % WALL.length], roof: ROOF[b.c] || ROOF[0], dist: 0,
      };
    });
    for (const b of this.buildings) b.rf = b.lm || b.flat ? null : roofShape(b);

    // Zusätzliche Dach-Sprungschanzen auf großen Flachdächern
    if (isRW) {
      for (const [rx, ry, ra, cx, cy] of [
        [1134, 384, 0.78, 1122.5, 378.9],
        [478, 1633, -2.75, 484.8, 1640.6],
      ]) {
        const rb = this.buildings.find(q => Math.hypot(q.cx - cx, q.cy - cy) < 1.5);
        if (rb) this.ramps.push({ x: rx, y: ry, a: ra, l: 7, w: 5, b: 1, len: 7, wid: 5, big: true, rz: rb.top, ca: Math.cos(ra), sa: Math.sin(ra), baseZ: rb.top });
      }
    }

    // Brücken, Flankenbrücken & begehbare Dach-Skybridges
    const extraDecks = isRW ? [
      // Breite Flussbrücken für West- (x=55) und Ost-Flanke (x=1255)
      { p: [55, 852, this.terrain(55, 852) + 0.02, 55, 895, this.terrain(55, 895) + 0.02], w: 16 },
      { p: [1255, 850, this.terrain(1255, 850) + 0.02, 1255, 891, this.terrain(1255, 891) + 0.02], w: 16 },
      // Dach-Netzwerk Weingarten West
      { p: [377.6, 338.6, 12.03, 392.1, 284.5, 20.92], w: 8, sky: 1, acc: 1 },
      { p: [396.4, 263.9, 20.92, 399.9, 239.9, 20.75], w: 8, sky: 1 },
      { p: [400, 215.5, 20.64, 400.2, 235, 20.75], w: 8, sky: 1 },
      { p: [403.5, 211.6, 20.64, 423.3, 209.6, 20.17], w: 8, sky: 1 },
      { p: [426.0, 200.0, 20.17, 429.9, 175, 20.2], w: 8, sky: 1 },
      { p: [400.8, 122.8, 11.6, 428.8, 171.3, 20.2], w: 8, sky: 1, acc: 1 },
      // Dach-Netzwerk Weingarten Ost
      { p: [1088.2, 319.6, 12.9, 1116.2, 368.1, 25.45], w: 8, sky: 1, acc: 1 },
      { p: [1128.3, 372.8, 25.45, 1151.1, 348.9, 23.93], w: 8, sky: 1 },
      { p: [1149.7, 343.8, 23.93, 1131.9, 325.1, 25.87], w: 8, sky: 1 },
      { p: [1100.2, 298.9, 24.83, 1125.3, 319, 25.87], w: 8, sky: 1 },
      { p: [1095, 224, 13.45, 1088.1, 278.0, 24.83], w: 8, sky: 1, acc: 1 },
      // Dach-Netzwerk Schussental Nord
      { p: [1076.6, 686.9, 6.3, 1048.6, 735.4, 14.42], w: 8, sky: 1, acc: 1 },
      { p: [1018.9, 740.9, 13.65, 1043.3, 738.8, 14.42], w: 8, sky: 1 },
      { p: [1011.1, 744.3, 13.65, 982.1, 771.2, 15.9], w: 8, sky: 1 },
      { p: [973.3, 777.6, 15.9, 949.5, 790.5, 15.24], w: 8, sky: 1 },
      { p: [911, 793, 15.62, 941.1, 792.7, 15.24], w: 8, sky: 1 },
      { p: [921.9, 735.5, 5.61, 907.4, 789.6, 15.62], w: 8, sky: 1, acc: 1 },
      // Dach-Netzwerk Schussental Süd
      { p: [1057, 952.5, 0.54, 1009.5, 980.2, 13.6], w: 8, sky: 1, acc: 1 },
      { p: [1012.5, 985.5, 13.6, 1043.8, 993.7, 12.42], w: 8, sky: 1 },
      { p: [1061.6, 977.3, 9.55, 1050.1, 991.1, 12.42], w: 8, sky: 1 },
      { p: [1079.4, 945.1, 8.3, 1066.6, 969.9, 9.55], w: 8, sky: 1 },
      { p: [1065.1, 928.1, 11.25, 1079.1, 938.2, 8.3], w: 8, sky: 1 },
      { p: [1114.6, 895.8, 1.47, 1066.1, 923.8, 11.25], w: 8, sky: 1, acc: 1 },
      // Dach-Netzwerk Ravensburg Altstadt
      { p: [569.3, 1546.8, 0, 513.3, 1546.8, 10.8], w: 8, sky: 1, acc: 1 },
      { p: [509.8, 1550.3, 10.8, 510.2, 1583.2, 12.1], w: 8, sky: 1 },
      { p: [505.8, 1603, 12.1, 488.9, 1633.2, 13.1], w: 8, sky: 1 },
      { p: [518.4, 1666.2, 9.6, 494.8, 1648.2, 13.1], w: 8, sky: 1 },
      { p: [514.5, 1683.2, 11.3, 519.8, 1671.5, 9.6], w: 8, sky: 1 },
      { p: [555.9, 1729.2, 0, 516.3, 1689.6, 11.3], w: 8, sky: 1, acc: 1 },
    ] : [];
    this.decks = (map.decks || []).concat(extraDecks).map(d => {
      let [ax, ay, az, bx, by, bz] = d.p;
      if (d.acc) az = this.terrain(ax, ay) + 0.02;
      const L = Math.hypot(bx - ax, by - ay) || 1;
      return { ax, ay, az, bx, by, bz, w: d.w, sky: !!d.sky, acc: !!d.acc, L, ux: (bx - ax) / L, uy: (by - ay) / L, bb: [Math.min(ax, bx) - d.w, Math.min(ay, by) - d.w, Math.max(ax, bx) + d.w, Math.max(ay, by) + d.w] };
    });

    const extraRoads = isRW ? [
      // Breite Tunnel-Anschlussstraßen
      { k: 1, w: 14, p: [135, 76, 135, 110.5] },
      { k: 1, w: 14, p: [135, 499.5, 135, 540] },
      { k: 1, w: 14, p: [640, 230, 675.5, 230] },
      { k: 1, w: 14, p: [1034.5, 230, 1068, 230] },
      { k: 1, w: 14, p: [702, 1795, 740.5, 1795] },
      // Durchgehende West-Flanke (x=55) & Querverbindungen
      { k: 0, w: 16, p: [55, 65, 55, 854] },
      { k: 0, w: 16, p: [55, 893, 55, 1805] },
      { k: 1, w: 14, p: [55, 95, 135, 95] },
      { k: 1, w: 14, p: [55, 520, 135, 520] },
      { k: 1, w: 14, p: [55, 1795, 140, 1795] },
      // Durchgehende Ost-Flanke (x=1255) & Querverbindungen
      { k: 0, w: 16, p: [1255, 65, 1255, 852] },
      { k: 0, w: 16, p: [1255, 889, 1255, 1805] },
      { k: 1, w: 14, p: [1065, 165, 1255, 165] },
      { k: 1, w: 14, p: [1215, 300, 1255, 300] },
      { k: 1, w: 14, p: [1050, 1320, 1255, 1320] },
      { k: 1, w: 14, p: [1009.5, 1795, 1255, 1795] },
    ] : [];
    this.roads = map.roads.concat(extraRoads).map(r => ({ ...r, bb: polyBBox(r.p) }));
    this.areas = map.areas.map(a => ({ ...a, bb: polyBBox(a.p) }));
    this.trees = [];
    for (let i = 0; i < map.trees.length; i += 2) {
      const tx = map.trees[i], ty = map.trees[i + 1];
      if (inApron(tx, ty) || inFlankCorridor(tx, ty)) continue;
      if (this.ramps.some(r => r.rz === undefined && Math.hypot(tx - r.x, ty - r.y) < Math.max(r.len, r.wid) + 4)) continue;
      if (this.decks.some(d => {
        if (!d.acc) return false;
        const rx = tx - d.ax, ry = ty - d.ay, t = clampW(rx * d.ux + ry * d.uy, 0, d.L);
        return Math.hypot(rx - d.ux * t, ry - d.uy * t) < d.w * 0.5 + 3.5;
      })) continue;
      const h = hash32(i);
      this.trees.push({ x: tx, y: ty, r: 2.2 + (h % 100) / 60, h: 7 + (h % 5), hue: h % 3 });
    }
    const extraLabels = isRW ? [
      { x: 135, y: 305, t: 'Martinsberg-Tunnel', k: 1, a: -Math.PI / 2 },
      { x: 855, y: 230, t: 'Kirchberg-Tunnel', k: 1, a: 0 },
      { x: 890, y: 1795, t: 'Veitsburg-Tunnel', k: 1, a: 0 },
      { x: 55, y: 650, t: 'West-Flanke', k: 0, a: -Math.PI / 2 },
      { x: 1255, y: 650, t: 'Ost-Flanke', k: 0, a: -Math.PI / 2 },
    ] : [];
    this.labels = (map.labels || []).concat(extraLabels);
    this.bases = map.bases;
    this.buildHash();
    // Sicherstellen, dass keine zusätzliche Boden-Rampe in einem Gebäude liegt
    for (const r of this.ramps) {
      if (r.rz !== undefined) continue;
      if (this.buildingAt(r.x, r.y)) {
        for (let d = 3; d <= 18; d += 3) {
          let found = false;
          for (let a = 0; a < Math.PI * 2; a += Math.PI / 4) {
            const nx = r.x + Math.cos(a) * d, ny = r.y + Math.sin(a) * d;
            if (!this.buildingAt(nx, ny) && !this.inWater(nx, ny)) { r.x = nx; r.y = ny; r.baseZ = this.rawTerrain(nx, ny); found = true; break; }
          }
          if (found) break;
        }
      }
    }
    this.buildNav();
    this.tiles = new Map();
    this.tileZ = 0;
  }

  // ---------------- Kollisions-Hash ----------------
  buildHash() {
    const n = this.hw * this.hh;
    this.hEdges = Array.from({ length: n }, () => []);
    this.hBld = Array.from({ length: n }, () => []);
    this.hTrees = Array.from({ length: n }, () => []);
    const add = (arr, bb, item, pad = 0) => {
      const x0 = Math.max(0, Math.floor((bb[0] - pad) / HASH)), x1 = Math.min(this.hw - 1, Math.floor((bb[2] + pad) / HASH));
      const y0 = Math.max(0, Math.floor((bb[1] - pad) / HASH)), y1 = Math.min(this.hh - 1, Math.floor((bb[3] + pad) / HASH));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) arr[y * this.hw + x].push(item);
    };
    this.buildings.forEach((b) => {
      add(this.hBld, b.bb, b);
      const p = b.p;
      for (let k = 0; k < p.length; k += 2) {
        const k2 = (k + 2) % p.length;
        const e = { ax: p[k], ay: p[k + 1], bx: p[k2], by: p[k2 + 1], b };
        add(this.hEdges, [Math.min(e.ax, e.bx), Math.min(e.ay, e.by), Math.max(e.ax, e.bx), Math.max(e.ay, e.by)], e);
      }
    });
    this.hDeck = Array.from({ length: n }, () => []);
    this.hTun = Array.from({ length: n }, () => []);
    // Leitplanken an Dämmen (kollidieren wie Wände in ihrem Höhenbereich)
    for (const r of this.rails) {
      const e = { ax: r.ax, ay: r.ay, bx: r.bx, by: r.by, isSurface: true, b: { top: Math.max(r.az, r.bz) + (r.w ? 0.9 : 1.1), base: Math.min(r.az, r.bz) - (r.w ? 12 : 2.5), p: null } };
      add(this.hEdges, [Math.min(e.ax, e.bx), Math.min(e.ay, e.by), Math.max(e.ax, e.bx), Math.max(e.ay, e.by)], e);
    }
    this.decks.forEach(d => {
      add(this.hDeck, d.bb, d);
      // Geländer an beiden Seiten der Brücke (bei Skybridges an den Dachrändern zurückgesetzt und bei Steigung unterteilt)
      const px = -d.uy * d.w / 2, py = d.ux * d.w / 2;
      const t0 = d.sky ? (d.acc ? 0 : Math.min(0.22, 2.3 / d.L)) : 0;
      const t1 = d.sky ? 1 - Math.min(0.22, 2.3 / d.L) : 1;
      const segs = Math.abs(d.bz - d.az) > 1.5 ? 4 : 1;
      for (let i = 0; i < segs; i++) {
        const a = t0 + (t1 - t0) * i / segs, b = t0 + (t1 - t0) * (i + 1) / segs;
        const za = d.az + (d.bz - d.az) * a, zb = d.az + (d.bz - d.az) * b;
        const rail = { top: Math.max(za, zb) + 1.1, base: Math.min(za, zb) - 0.4, p: null };
        for (const s of [1, -1]) {
          const e = { ax: d.ax + d.ux * d.L * a + px * s, ay: d.ay + d.uy * d.L * a + py * s, bx: d.ax + d.ux * d.L * b + px * s, by: d.ay + d.uy * d.L * b + py * s, b: rail };
          add(this.hEdges, [Math.min(e.ax, e.bx), Math.min(e.ay, e.by), Math.max(e.ax, e.bx), Math.max(e.ay, e.by)], e);
        }
      }
    });
    this.tunnels.forEach(t => {
      add(this.hTun, t.bb, t, 3);
      // Seitenwände im Inneren des Tunnels für sauberes Entlanggleiten
      for (const sg of t.segs) {
        const ux = (sg.bx - sg.ax) / sg.L, uy = (sg.by - sg.ay) / sg.L;
        const px = -uy * (t.w / 2), py = ux * (t.w / 2);
        const wallB = { top: Math.max(sg.az, sg.bz) + t.hgt, base: Math.min(sg.az, sg.bz) - 1.0, p: null };
        for (const s of [1, -1]) {
          const e = { ax: sg.ax + px * s, ay: sg.ay + py * s, bx: sg.bx + px * s, by: sg.by + py * s, b: wallB, isTunnelWall: true };
          add(this.hEdges, [Math.min(e.ax, e.bx), Math.min(e.ay, e.by), Math.max(e.ax, e.bx), Math.max(e.ay, e.by)], e);
        }
      }
    });
    // Abgeschrägte trichterförmige Flügelwände an allen Tunnelportalen (verhindern Hängenbleiben an Ecken)
    for (const p of this.portals) {
      const lx = -p.oy, ly = p.ox;
      const wingB = { top: p.z + p.hgt + 0.5, base: p.z - 1.5, p: null };
      for (const s of [1, -1]) {
        const ax = p.x + lx * p.hw * s, ay = p.y + ly * p.hw * s;
        const bx = p.x + p.ox * 12 + lx * (p.hw + 5.5) * s, by = p.y + p.oy * 12 + ly * (p.hw + 5.5) * s;
        const e = { ax, ay, bx, by, b: wingB };
        add(this.hEdges, [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)], e);
      }
    }
    this.trees.forEach(t => add(this.hTrees, [t.x, t.y, t.x, t.y], t, 1));
  }
  cell(x, y) {
    const cx = Math.floor(x / HASH), cy = Math.floor(y / HASH);
    if (cx < 0 || cy < 0 || cx >= this.hw || cy >= this.hh) return -1;
    return cy * this.hw + cx;
  }
  buildingAt(x, y) {
    const c = this.cell(x, y); if (c < 0) return null;
    let best = null;
    for (const b of this.hBld[c]) {
      if (x < b.bb[0] || x > b.bb[2] || y < b.bb[1] || y > b.bb[3]) continue;
      if (pointInPoly(b.p, x, y) && (!best || b.top > best.top)) best = b;
    }
    return best;
  }
  // Wasserspiegel an dieser Stelle (oder null)
  waterAt(x, y) {
    const c = this.cell(x, y); if (c < 0) return null;
    for (const w of this.hWater[c]) {
      if (x < w.bb[0] || x > w.bb[2] || y < w.bb[1] || y > w.bb[3]) continue;
      if (pointInPoly(w.p, x, y)) return w.z;
    }
    return null;
  }
  inWater(x, y) { return this.waterAt(x, y) !== null; }

  // ---------------- Gelände, Brücken, Tunnel ----------------
  rawTerrain(x, y) {
    if (!this.hz) return 0;
    const fx = clampW(x / this.tres, 0, this.tnx - 1.001), fy = clampW(y / this.tres, 0, this.tny - 1.001);
    const ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy, n = this.tnx, i = iy * n + ix, h = this.hz;
    return h[i] * (1 - tx) * (1 - ty) + h[i + 1] * tx * (1 - ty) + h[i + n] * (1 - tx) * ty + h[i + n + 1] * tx * ty;
  }
  terrain(x, y) {
    if (!this.hz) return 0;
    let z = this.rawTerrain(x, y);
    // Ost-Flanke (x=1255): Querneigung am Hang zwischen y=920 und y=1240 sanft einebnen
    if (this.isRW && x > 1235 && x < 1275 && y > 920 && y < 1240) {
      const fxR = Math.abs(x - 1255);
      const wx = fxR <= 8.5 ? 1 : 1 - ssW((fxR - 8.5) / 11.5);
      const wy = ssW(Math.min((y - 920) / 30, (1240 - y) / 30));
      if (wx * wy > 0) z += (this.rawTerrain(1255, y) - z) * wx * wy;
    }
    const c = this.cell(x, y);
    if (c >= 0) {
      // Rampen-Untergrund sanft auf Rampen-Basishöhe angleichen (kein Hängenbleiben an Kanten)
      const flats = this.hFlat[c];
      if (flats && flats.length && !this.inWater(x, y)) {
        let bestW = 0, bestZ = z;
        for (const r of flats) {
          const dx = x - r.x, dy = y - r.y;
          const u = dx * r.ca + dy * r.sa, v = -dx * r.sa + dy * r.ca;
          const hu = r.len * 0.5 + 1.0, hv = r.wid * 0.5 + 0.8;
          const du = Math.max(0, Math.abs(u) - hu), dv = Math.max(0, Math.abs(v) - hv);
          const d = Math.hypot(du, dv);
          if (d >= 5) continue;
          const w = 1 - ssW(d / 5);
          if (w > bestW) { bestW = w; bestZ = r.baseZ; }
        }
        if (bestW > 0) z += (bestZ - z) * bestW;
      }
      // Tunnel-Zufahrten ausheben & saubere Geländedecke über der Röhre garantieren
      const tuns = this.hTunFlat[c];
      if (tuns && tuns.length) {
        const seenT = this._seenT || (this._seenT = new Set());
        seenT.clear();
        for (const tn of tuns) {
          if (seenT.has(tn) || x < tn.fbb[0] || x > tn.fbb[2] || y < tn.fbb[1] || y > tn.fbb[3]) continue;
          seenT.add(tn);
          for (const p of tn.portals) {
            const d = (x - p.x) * p.ox + (y - p.y) * p.oy;
            const lat = Math.abs(-(x - p.x) * p.oy + (y - p.y) * p.ox);
            if (d >= -7.5 && d <= 48 && lat <= p.hw + 22) {
              const fd = d <= 14 ? (d >= -2.5 ? 1 : 1 - ssW((-2.5 - d) / 5)) : 1 - ssW((d - 14) / 34);
              const fl = lat <= p.hw + 3 ? 1 : 1 - ssW((lat - (p.hw + 3)) / 19);
              z += (p.z - z) * fd * fl;
            }
          }
          let bestD2 = 1e9, bestFloor = 0, bestAcc = 0;
          for (const sg of tn.segs) {
            if (x < sg.bb[0] || x > sg.bb[2] || y < sg.bb[1] || y > sg.bb[3]) continue;
            const dx = sg.bx - sg.ax, dy = sg.by - sg.ay;
            const t = clampW(((x - sg.ax) * dx + (y - sg.ay) * dy) / (sg.L * sg.L), 0, 1);
            const px = sg.ax + dx * t, py = sg.ay + dy * t;
            const dd2 = (x - px) ** 2 + (y - py) ** 2;
            if (dd2 < bestD2) { bestD2 = dd2; bestFloor = sg.az + (sg.bz - sg.az) * t; bestAcc = sg.acc0 + t * sg.L; }
          }
          const lat = Math.sqrt(bestD2);
          if (lat <= tn.hw + 22) {
            const dIn = Math.min(bestAcc, tn.totalLen - bestAcc);
            if (dIn > 4.0) {
              const fa = ssW((dIn - 4.0) / 3.5);
              const fl = lat <= tn.hw + 2 ? 1 : 1 - ssW((lat - (tn.hw + 2)) / 20);
              const need = bestFloor + tn.hgt + 1.3;
              if (need > z) z += (need - z) * fa * fl;
            }
          }
        }
      }
    }
    return z;
  }
  // Brückenplatten, die diesen Punkt überdecken: Höhe der Oberseite
  decksAt(x, y, out) {
    out.length = 0;
    const c = this.cell(x, y); if (c < 0) return out;
    for (const d of this.hDeck[c]) {
      const rx = x - d.ax, ry = y - d.ay, t = rx * d.ux + ry * d.uy;
      if (t < 0 || t > d.L || Math.abs(-rx * d.uy + ry * d.ux) > d.w / 2) continue;
      out.push(d.az + (d.bz - d.az) * t / d.L);
    }
    return out;
  }
  // Tunnel an dieser Stelle: Boden und Decke (oder null); pad erlaubt Puffer beim Wandgleiten
  tunnelAt(x, y, pad = 0) {
    const c = this.cell(x, y); if (c < 0) return null;
    for (const tn of this.hTun[c]) {
      const lim = tn.hw + pad;
      for (const sg of tn.segs) {
        const dx = sg.bx - sg.ax, dy = sg.by - sg.ay;
        let t = ((x - sg.ax) * dx + (y - sg.ay) * dy) / (sg.L * sg.L);
        const ext = 0.8 / sg.L;
        if (t < -ext || t > 1 + ext) continue;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = sg.ax + dx * t, py = sg.ay + dy * t;
        if ((x - px) ** 2 + (y - py) ** 2 > lim * lim) continue;
        const floor = sg.az + (sg.bz - sg.az) * t;
        const s = (sg.bz - sg.az) / sg.L;
        return { floor, ceil: floor + tn.hgt, tn, sx: (dx / sg.L) * s, sy: (dy / sg.L) * s };
      }
    }
    return null;
  }
  // Öffnung im Geländenetz / Oberflächen-Asphaltband an Tunnelportalen
  isPortalHole(x, y) {
    for (const p of this.portals) {
      const dIn = -(x - p.x) * p.ox - (y - p.y) * p.oy;
      if (dIn < -0.5 || dIn > 10.5) continue;
      const lat = Math.abs(-(x - p.x) * p.oy + (y - p.y) * p.ox);
      if (lat <= p.hw + 2.0) return true;
    }
    return false;
  }
  // Rampenhöhe und -steigung an (x, y), falls innerhalb einer Schanze (mit sanftem Einlauf)
  rampAt(x, y) {
    for (const r of this.ramps) {
      const dx = x - r.x, dy = y - r.y, L = r.len, Wd = r.wid;
      if (dx * dx + dy * dy > (L * L + Wd * Wd) * 0.35 + 4) continue;
      const ca = r.ca, sa = r.sa;
      const u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
      if (u < -L / 2 - 0.8 || u > L / 2 + 0.35 || Math.abs(v) > Wd / 2 + 0.25) continue;
      const tRaw = clampW((u + L / 2) / L, 0, 1);
      // Sanfter Einlauf an der Unterkante (kein Hängenbleiben an der Rampe)
      const t = tRaw < 0.22 ? (tRaw * tRaw) / 0.22 * 0.8 + tRaw * 0.2 : tRaw;
      const dtdU = (tRaw < 0.22 ? (2 * tRaw / 0.22 * 0.8 + 0.2) : 1) / L;
      const H = r.big ? 2.2 : 1.5;
      const baseZ = r.rz !== undefined ? r.rz : this.terrain(r.x, r.y);
      return { z: baseZ + H * t, sx: ca * H * dtdU, sy: sa * H * dtdU, r, t: tRaw, alongX: ca, alongY: sa };
    }
    return null;
  }
  // Fahrbare Oberfläche unter einem Objekt in Höhe z (Gelände, Tunnelboden, Brücke, Dach, Schanze)
  // prevZ verhindert Durchfallen durch Böden/Dächer bei hoher Fallgeschwindigkeit
  groundAt(x, y, z, prevZ) {
    const zTop = prevZ !== undefined && prevZ > z ? prevZ : z;
    const tn = this.tunnelAt(x, y);
    let g, kind = 'terrain';
    if (tn && zTop < tn.ceil - 0.45) { g = tn.floor; kind = 'tunnel'; }
    else g = this.terrain(x, y);
    const ds = this.decksAt(x, y, this._dk || (this._dk = []));
    for (const dz of ds) if (dz <= zTop + STEP + 0.45 && dz > g) { g = dz; kind = 'deck'; }
    const b = this.buildingAt(x, y);
    if (b && kind !== 'tunnel' && b.top > g) {
      const rz = b.rf ? roofZ(b, x, y) : b.top;
      if (b.top <= zTop + 1.05 || rz <= zTop + 0.95) { g = rz; kind = 'roof'; }
    }
    const rp = kind !== 'tunnel' ? this.rampAt(x, y) : null;
    if (rp && rp.z <= zTop + STEP + 0.65 && (rp.z > g || (rp.r.rz !== undefined && rp.z >= g - 0.05))) {
      g = Math.max(g, rp.z); kind = 'ramp';
    }
    this.groundKind = kind;
    return g;
  }
  // Ist der Platz für eine Karosserie (z .. z+1.6) durch Gelände, Tunneldecke oder Brückenplatte versperrt?
  blockedAt(x, y, z, step = STEP, inTun = false) {
    if (x < 1 || y < 1 || x > this.w - 1 || y > this.h - 1) return true;
    const tn = this.tunnelAt(x, y, 0);
    if (!tn && inTun) {
      const tp = this.tunnelAt(x, y, 2.8);
      if (tp && z < tp.ceil - 0.45) return false;
    }
    if (tn && z < tn.ceil - 0.5) { if (z + 1.6 > tn.ceil || tn.floor > z + step) return true; }
    else if (this.terrain(x, y) > z + step) return true;
    const ds = this.decksAt(x, y, this._dk2 || (this._dk2 = []));
    for (const dz of ds) if (dz > z + step && dz - DECK_T < z + 1.6) return true;
    return false;
  }
  // Unterseite der nächsten Decke über z (Tunneldecke, Brückenplatte) oder null
  ceilingAt(x, y, z) {
    let best = null;
    const tn = this.tunnelAt(x, y);
    if (tn && z < tn.ceil - 0.5 && z > tn.floor - 1.5) best = tn.ceil;
    const ds = this.decksAt(x, y, this._dk4 || (this._dk4 = []));
    for (const dz of ds) { const bot = dz - DECK_T; if (bot > z + 0.3 && (best === null || bot < best)) best = bot; }
    return best;
  }
  // Steigung (dz/dx, dz/dy) der Oberfläche ohne Kanten-Artefakte an Brücken/Dächern
  slopeAt(x, y, z) {
    const savedKind = this.groundKind;
    if (savedKind === 'tunnel') {
      const tn = this.tunnelAt(x, y);
      if (tn) { this.groundKind = savedKind; return [tn.sx || 0, tn.sy || 0]; }
    }
    const rp = this.rampAt(x, y);
    if (rp && Math.abs(z - rp.z) < 1.2) { this.groundKind = savedKind; return [rp.sx, rp.sy]; }
    if (savedKind === 'deck') {
      const c = this.cell(x, y);
      if (c >= 0) for (const d of this.hDeck[c]) {
        const rx = x - d.ax, ry = y - d.ay, t = rx * d.ux + ry * d.uy;
        if (t >= 0 && t <= d.L && Math.abs(-rx * d.uy + ry * d.ux) <= d.w / 2) {
          const s = (d.bz - d.az) / d.L;
          this.groundKind = savedKind;
          return [d.ux * s, d.uy * s];
        }
      }
    }
    if (savedKind === 'roof') {
      const b = this.buildingAt(x, y);
      if (!b || !b.rf) { this.groundKind = savedKind; return [0, 0]; }
      const e = 0.45;
      const zc = roofZ(b, x, y);
      const zx1 = pointInPoly(b.p, x + e, y) ? roofZ(b, x + e, y) : zc;
      const zx0 = pointInPoly(b.p, x - e, y) ? roofZ(b, x - e, y) : zc;
      const zy1 = pointInPoly(b.p, x, y + e) ? roofZ(b, x, y + e) : zc;
      const zy0 = pointInPoly(b.p, x, y - e) ? roofZ(b, x, y - e) : zc;
      this.groundKind = savedKind;
      return [clampW((zx1 - zx0) / (2 * e), -0.65, 0.65), clampW((zy1 - zy0) / (2 * e), -0.65, 0.65)];
    }
    const e = 0.9;
    const sx = clampW((this.terrain(x + e, y) - this.terrain(x - e, y)) / (2 * e), -0.75, 0.75);
    const sy = clampW((this.terrain(x, y + e) - this.terrain(x, y - e)) / (2 * e), -0.75, 0.75);
    this.groundKind = savedKind;
    return [sx, sy];
  }
  // Oberflächennormale (nx, ny, nz) am Bodenpunkt
  normalAt(x, y, z) {
    const [sx, sy] = this.slopeAt(x, y, z);
    const il = 1 / Math.hypot(sx, sy, 1);
    return [-sx * il, -sy * il, il];
  }
  // Kreis gegen statische Geometrie auflösen. Rückgabe: stärkste Normale oder null
  collideCircle(o, r, z, vz) {
    let hit = null;
    const tn = this.tunnelAt(o.x, o.y);
    const inTun = !!(tn && z < tn.ceil - 0.5);
    const x0 = Math.max(0, Math.floor((o.x - r) / HASH)), x1 = Math.min(this.hw - 1, Math.floor((o.x + r) / HASH));
    const y0 = Math.max(0, Math.floor((o.y - r) / HASH)), y1 = Math.min(this.hh - 1, Math.floor((o.y + r) / HASH));
    const seen = this._seen || (this._seen = new Set()); seen.clear();
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
      const ci = cy * this.hw + cx;
      for (const e of this.hEdges[ci]) {
        if (e.isTunnelWall) { if (!inTun) continue; }
        else if (inTun && (e.b.p || e.isSurface)) continue;
        // Sanfter Übergang auf Dachkanten: wer knapp unterhalb der Traufe fliegt, gleitet aufs Dach statt an einer unsichtbaren Kante abzuprallen
        const roofGrace = e.b.p && (vz === undefined || vz >= -5.5) ? 0.85 : 0.32;
        if (e.b.top <= z + roofGrace || e.b.base - 1 > z + 1.6 || seen.has(e)) continue;
        seen.add(e);
        const dx = e.bx - e.ax, dy = e.by - e.ay;
        const l2 = dx * dx + dy * dy || 1;
        let t = ((o.x - e.ax) * dx + (o.y - e.ay) * dy) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const px = e.ax + dx * t, py = e.ay + dy * t;
        let nx = o.x - px, ny = o.y - py;
        const d2 = nx * nx + ny * ny;
        if (d2 < r * r) {
          const d = Math.sqrt(d2) || 0.0001;
          nx /= d; ny /= d;
          // falls Mittelpunkt im Gebäude: Normale umdrehen
          if (e.b.p && pointInPoly(e.b.p, o.x, o.y)) { nx = -nx; ny = -ny; o.x = px + nx * r; o.y = py + ny * r; }
          else { o.x += nx * (r - d); o.y += ny * (r - d); }
          if (!hit || (r - d) > hit.pen) hit = { nx, ny, pen: r - d, kind: 'b', top: e.b.top };
        }
      }
      // Bäume sind nur Deko (keine Kollision mehr)
      if (false) for (const t of this.hTrees[ci]) {
        if (t.h <= z || seen.has(t)) continue;
        seen.add(t);
        const tr = 0.6;
        let nx = o.x - t.x, ny = o.y - t.y;
        const d = Math.hypot(nx, ny);
        if (d < r + tr) {
          nx /= d || 1; ny /= d || 1;
          o.x = t.x + nx * (r + tr); o.y = t.y + ny * (r + tr);
          if (!hit) hit = { nx, ny, pen: r + tr - d, kind: 't' };
        }
      }
    }
    // Kartenrand
    const m = 1;
    if (o.x < r + m) { o.x = r + m; hit = hit || { nx: 1, ny: 0, pen: 0.1, kind: 'w' }; }
    if (o.y < r + m) { o.y = r + m; hit = hit || { nx: 0, ny: 1, pen: 0.1, kind: 'w' }; }
    if (o.x > this.w - r - m) { o.x = this.w - r - m; hit = hit || { nx: -1, ny: 0, pen: 0.1, kind: 'w' }; }
    if (o.y > this.h - r - m) { o.y = this.h - r - m; hit = hit || { nx: 0, ny: -1, pen: 0.1, kind: 'w' }; }
    return hit;
  }
  // Punkt-Test für Geschosse
  solidAt(x, y, z) {
    if (x < 0 || y < 0 || x > this.w || y > this.h) return true;
    const tn = this.tunnelAt(x, y);
    if (tn && z > tn.floor - 0.2 && z < tn.ceil) return false;
    else if (z < this.terrain(x, y) - 0.2) return true;
    const ds = this.decksAt(x, y, this._dk3 || (this._dk3 = []));
    for (const dz of ds) if (z <= dz && z > dz - DECK_T) return true;
    const b = this.buildingAt(x, y);
    if (b && z < b.top && z > b.base - 1) return true;
    return false;
  }

  // ---------------- Navigation ----------------
  buildNav() {
    const gw = this.gw = Math.ceil(this.w / NAV), gh = this.gh = Math.ceil(this.h / NAV);
    const cv = document.createElement('canvas'); cv.width = gw; cv.height = gh;
    const g = cv.getContext('2d', { willReadFrequently: true });
    const draw = (inflate) => {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.fillStyle = '#000'; g.fillRect(0, 0, gw, gh);
      g.setTransform(1 / NAV, 0, 0, 1 / NAV, 0, 0);
      g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.lineJoin = 'round';
      g.lineWidth = inflate * 2;
      const polys = this.buildings.map(b => b.p).concat(this.water.map(w => w.p));
      for (const p of polys) {
        g.beginPath(); g.moveTo(p[0], p[1]);
        for (let i = 2; i < p.length; i += 2) g.lineTo(p[i], p[i + 1]);
        g.closePath(); g.fill(); if (inflate > 0) g.stroke();
      }
      // Leitplanken sind Wände
      g.lineWidth = 1 + inflate * 2;
      for (const r of this.rails) { g.beginPath(); g.moveTo(r.ax, r.ay); g.lineTo(r.bx, r.by); g.stroke(); }
      // Flussbrücken: Ufer direkt neben/unter der Brücke sperren, damit Bots nur über die Rampen auffahren
      for (const dk of this.decks) {
        if (this.waterAt((dk.ax + dk.bx) / 2, (dk.ay + dk.by) / 2) === null) continue;
        const px = -dk.uy, py = dk.ux;
        g.lineWidth = 4 + inflate * 2; g.lineCap = 'butt';
        for (const sgn of [1, -1]) {
          const o = (dk.w / 2 + 2) * sgn;
          g.beginPath(); g.moveTo(dk.ax - dk.ux * 12 + px * o, dk.ay - dk.uy * 12 + py * o); g.lineTo(dk.bx + dk.ux * 12 + px * o, dk.by + dk.uy * 12 + py * o); g.stroke();
        }
        g.lineCap = 'round';
      }
      for (const c of this.map.crates) if (c.t === 2) {
        g.save(); g.translate(c.x, c.y); g.rotate(c.a); g.fillRect(-1.6 - inflate, -0.5 - inflate, 3.2 + inflate * 2, 1 + inflate * 2); g.restore();
      }
      const d = g.getImageData(0, 0, gw, gh).data;
      const out = new Uint8Array(gw * gh);
      for (let i = 0; i < out.length; i++) out[i] = d[i * 4] > 110 ? 1 : 0;
      // steile Hänge sind Wände, Brücken und Tunnel dagegen befahrbar
      if (this.hz) {
        const pass = this.passMask || (this.passMask = this.drawPassMask(g, gw, gh));
        for (let cy = 0; cy < gh; cy++) for (let cx = 0; cx < gw; cx++) {
          const i = cy * gw + cx;
          if (pass[i]) { out[i] = 0; continue; }
          const x = (cx + 0.5) * NAV, y = (cy + 0.5) * NAV;
          const sx = (this.terrain(x + 1.5, y) - this.terrain(x - 1.5, y)) / 3, sy = (this.terrain(x, y + 1.5) - this.terrain(x, y - 1.5)) / 3;
          if (sx * sx + sy * sy > STEEP * STEEP) out[i] = 1;
        }
      }
      for (let x = 0; x < gw; x++) { out[x] = 1; out[(gh - 1) * gw + x] = 1; }
      for (let y = 0; y < gh; y++) { out[y * gw] = 1; out[y * gw + gw - 1] = 1; }
      return out;
    };
    this.solid = draw(0);
    this.nav = draw(1.25);
    // Ränder wieder sperren
    for (const grid of [this.solid, this.nav]) {
      for (let x = 0; x < gw; x++) { grid[x] = 1; grid[(gh - 1) * gw + x] = 1; }
      for (let y = 0; y < gh; y++) { grid[y * gw] = 1; grid[y * gw + gw - 1] = 1; }
    }
    this.fields = new Map();
    this.q = new Int32Array(gw * gh);
  }
  // Raster der Brücken (+ Anschluss) und Tunnel: immer befahrbar (Skybridges überspringen, damit Bots nicht durch Häuser fahren)
  drawPassMask(g, gw, gh) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#000'; g.fillRect(0, 0, gw, gh);
    g.setTransform(1 / NAV, 0, 0, 1 / NAV, 0, 0);
    g.strokeStyle = '#fff'; g.lineCap = 'butt'; g.lineJoin = 'round';
    for (const d of this.decks) {
      if (d.sky) continue;
      g.lineWidth = d.w - 2;
      g.beginPath(); g.moveTo(d.ax - d.ux * 10, d.ay - d.uy * 10); g.lineTo(d.bx + d.ux * 10, d.by + d.uy * 10); g.stroke();
    }
    for (const t of this.tunnels) {
      g.lineWidth = t.w - 1.5;
      g.beginPath(); g.moveTo(t.p[0], t.p[1]);
      for (let i = 3; i < t.p.length; i += 3) g.lineTo(t.p[i], t.p[i + 1]);
      g.stroke();
    }
    const d = g.getImageData(0, 0, gw, gh).data, out = new Uint8Array(gw * gh);
    for (let i = 0; i < out.length; i++) out[i] = d[i * 4] > 110 ? 1 : 0;
    return out;
  }
  navIdx(x, y) {
    const cx = Math.max(0, Math.min(this.gw - 1, Math.floor(x / NAV)));
    const cy = Math.max(0, Math.min(this.gh - 1, Math.floor(y / NAV)));
    return cy * this.gw + cx;
  }
  nearestFree(idx, grid = this.nav, maxR = 8) {
    if (!grid[idx]) return idx;
    const gw = this.gw, cx = idx % gw, cy = (idx / gw) | 0;
    for (let r = 1; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= gw || y >= this.gh) continue;
        const i = y * gw + x;
        if (!grid[i]) return i;
      }
    }
    return idx;
  }
  // BFS-Distanzfeld zu einem Ziel (gecacht nach Zielzelle)
  field(x, y) {
    let idx = this.nearestFree(this.navIdx(x, y));
    const key = idx;
    let f = this.fields.get(key);
    if (f) { f.used = performance.now(); return f.d; }
    const gw = this.gw, gh = this.gh, nav = this.nav;
    const d = new Uint16Array(gw * gh).fill(65535);
    const q = this.q; let h = 0, t = 0;
    d[idx] = 0; q[t++] = idx;
    while (h < t) {
      const i = q[h++], nd = d[i] + 1;
      const x = i % gw;
      if (x > 0 && !nav[i - 1] && d[i - 1] > nd) { d[i - 1] = nd; q[t++] = i - 1; }
      if (x < gw - 1 && !nav[i + 1] && d[i + 1] > nd) { d[i + 1] = nd; q[t++] = i + 1; }
      if (i >= gw && !nav[i - gw] && d[i - gw] > nd) { d[i - gw] = nd; q[t++] = i - gw; }
      if (i < gw * (gh - 1) && !nav[i + gw] && d[i + gw] > nd) { d[i + gw] = nd; q[t++] = i + gw; }
    }
    this.fields.set(key, { d, used: performance.now() });
    if (this.fields.size > 14) {
      let oldK = null, oldT = Infinity;
      for (const [k, v] of this.fields) if (v.used < oldT) { oldT = v.used; oldK = k; }
      this.fields.delete(oldK);
    }
    return d;
  }
  // Wegpunkt entlang des Feldes ermitteln
  waypoint(d, x, y, steps = 9) {
    const gw = this.gw;
    let i = this.navIdx(x, y);
    if (this.nav[i] || d[i] === 65535) i = this.nearestFree(i);
    if (d[i] === 65535) return null;
    const pts = [];
    for (let s = 0; s < steps; s++) {
      let bi = i, bd = d[i];
      const cx = i % gw;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        if ((cx === 0 && dx < 0) || (cx === gw - 1 && dx > 0)) continue;
        const j = i + dy * gw + dx;
        if (j < 0 || j >= d.length) continue;
        const v = d[j] + (dx && dy ? 0.4 : 0);
        if (v < bd) { bd = v; bi = j; }
      }
      if (bi === i) break;
      i = bi; pts.push(i);
    }
    // weitesten sichtbaren Punkt wählen
    for (let k = pts.length - 1; k >= 0; k--) {
      const px = (pts[k] % gw + 0.5) * NAV, py = (((pts[k] / gw) | 0) + 0.5) * NAV;
      if (k === 0 || this.los(x, y, px, py, this.nav)) return { x: px, y: py, dist: d[i] * NAV };
    }
    return { x, y, dist: 0 };
  }
  los(x0, y0, x1, y1, grid = this.solid) {
    const dx = x1 - x0, dy = y1 - y0;
    const n = Math.ceil(Math.hypot(dx, dy) / (NAV * 0.6));
    for (let s = 1; s < n; s++) {
      const x = x0 + dx * s / n, y = y0 + dy * s / n;
      if (grid[this.navIdx(x, y)]) return false;
    }
    return true;
  }
  randomFreeNear(x, y, rMin, rMax, rnd = Math.random) {
    for (let k = 0; k < 60; k++) {
      const a = rnd() * Math.PI * 2, r = rMin + rnd() * (rMax - rMin);
      const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
      if (px < 3 || py < 3 || px > this.w - 3 || py > this.h - 3) continue;
      const i = this.navIdx(px, py);
      if (!this.nav[i]) {
        const base = this.field(x, y);
        if (base[i] !== 65535) return { x: px, y: py };
      }
    }
    return { x, y };
  }

  // ---------------- Kacheln ----------------
  getTile(tx, ty, Z) {
    if (Z !== this.tileZ) { this.tiles.clear(); this.tileZ = Z; this.tileM = TILE_PX / Z; }
    const key = tx + ',' + ty;
    let t = this.tiles.get(key);
    if (t) { this.tiles.delete(key); this.tiles.set(key, t); return t; }
    t = this.renderTile(tx, ty, Z);
    this.tiles.set(key, t);
    if (this.tiles.size > 90) this.tiles.delete(this.tiles.keys().next().value);
    return t;
  }
  // opts.px: Kachelgröße in Pixeln, opts.flat3d: ohne gemalte Schatten/Rampen (für die 3D-Ansicht)
  renderTile(tx, ty, Z, opts = {}) {
    const px = opts.px || TILE_PX;
    const TILE = px / Z;
    const c = document.createElement('canvas'); c.width = c.height = px;
    const g = c.getContext('2d');
    const x0 = tx * TILE, y0 = ty * TILE, x1 = x0 + TILE, y1 = y0 + TILE;
    g.setTransform(Z, 0, 0, Z, -x0 * Z, -y0 * Z);
    g.fillStyle = COL.outside; g.fillRect(x0, y0, TILE, TILE);
    g.fillStyle = COL.ground; g.fillRect(Math.max(0, x0), Math.max(0, y0), Math.min(this.w, x1) - Math.max(0, x0), Math.min(this.h, y1) - Math.max(0, y0));
    const vis = bb => !(bb[2] < x0 - 8 || bb[0] > x1 + 8 || bb[3] < y0 - 8 || bb[1] > y1 + 8);
    const path = (p, close) => {
      g.beginPath(); g.moveTo(p[0], p[1]);
      for (let i = 2; i < p.length; i += 2) g.lineTo(p[i], p[i + 1]);
      if (close) g.closePath();
    };
    // Kopfsteinpflaster als Muster (2 m Kachel)
    const rs = hash32(tx * 92821 + ty * 68917);
    const cob = cobblePattern(g, false), cob2 = cobblePattern(g, true);
    if (cob) { g.fillStyle = cob; g.fillRect(Math.max(0, x0), Math.max(0, y0), Math.min(this.w, x1) - Math.max(0, x0), Math.min(this.h, y1) - Math.max(0, y0)); }
    const grass = grassPattern(g);
    for (const a of this.areas) if (a.t === 'green' && vis(a.bb)) { g.fillStyle = COL.green; path(a.p, true); g.fill(); if (grass) { g.fillStyle = grass; g.fill(); } }
    for (const a of this.areas) if (a.t === 'sand' && vis(a.bb)) { g.fillStyle = COL.sand; path(a.p, true); g.fill(); }
    for (const a of this.areas) if (a.t === 'paved' && vis(a.bb)) {
      g.fillStyle = COL.paved; path(a.p, true); g.fill();
      if (a.cob ? cob2 : cob) { g.fillStyle = a.cob ? cob2 : cob; g.fill(); }
      g.strokeStyle = 'rgba(0,0,0,0.12)'; g.lineWidth = 0.4; g.stroke();
    }
    g.lineCap = 'round'; g.lineJoin = 'round';
    const roads = this.roads.filter(r => vis(r.bb));
    const asphPat = asphaltPattern(g);
    // Gehwege / Bordstein
    for (const r of roads) if (r.k <= 1) { g.strokeStyle = COL.sidewalk; g.lineWidth = r.w + 3.4; path(r.p); g.stroke(); }
    for (const r of roads) if (r.k === 2) { g.strokeStyle = COL.foot; g.lineWidth = r.w; path(r.p); g.stroke(); }
    for (const r of roads) if (r.k <= 1) { g.strokeStyle = 'rgba(0,0,0,0.32)'; g.lineWidth = r.w + 0.7; path(r.p); g.stroke(); }
    for (const r of roads) if (r.k <= 1) {
      g.strokeStyle = r.k === 0 ? COL.asphaltMain : COL.asphalt; g.lineWidth = r.w; path(r.p); g.stroke();
      if (asphPat) { g.strokeStyle = asphPat; g.lineWidth = r.w - 0.3; path(r.p); g.stroke(); }
    }
    // Rand- und Mittellinien
    for (const r of roads) if (r.k === 0) {
      g.strokeStyle = 'rgba(235,235,225,0.45)'; g.lineWidth = Math.max(0.2, r.w - 1.2); path(r.p); g.stroke();
      g.strokeStyle = COL.asphaltMain; g.lineWidth = Math.max(0.1, r.w - 1.65); path(r.p); g.stroke();
      if (asphPat) { g.strokeStyle = asphPat; g.lineWidth = Math.max(0.1, r.w - 1.65); path(r.p); g.stroke(); }
    }
    g.setLineDash([3.2, 3.8]);
    for (const r of roads) if (r.k === 0 || r.w >= 9) { g.strokeStyle = 'rgba(245,244,234,0.82)'; g.lineWidth = 0.26; path(r.p); g.stroke(); }
    g.setLineDash([]);
    // Bahn
    for (const r of roads) if (r.k === 3) {
      g.strokeStyle = '#8a8378'; g.lineWidth = 3.2; path(r.p); g.stroke();
      g.setLineDash([0.4, 0.8]); g.strokeStyle = COL.rail; g.lineWidth = 2.6; path(r.p); g.stroke(); g.setLineDash([]);
      g.strokeStyle = '#3d3d40'; g.lineWidth = 1.6; path(r.p); g.stroke();
      g.strokeStyle = '#8a8378'; g.lineWidth = 1.2; path(r.p); g.stroke();
    }
    // Wasser
    for (const w of this.water) if (vis(w.bb)) {
      g.fillStyle = COL.water; path(w.p, true); g.fill();
      g.strokeStyle = COL.waterEdge; g.lineWidth = 0.8; g.stroke();
    }
    for (const r of roads) if (r.k === 4) { g.strokeStyle = COL.stream; g.lineWidth = r.w; path(r.p); g.stroke(); }
    if (this.water.some(w => vis(w.bb))) {
      g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = 0.25;
      for (let i = 0; i < 30; i++) {
        const h = hash32(rs + 500 + i);
        const x = x0 + (h % 1000) / 1000 * TILE, y = y0 + ((h >>> 10) % 1000) / 1000 * TILE;
        if (this.inWater(x, y)) { g.beginPath(); g.moveTo(x - 1.2, y); g.quadraticCurveTo(x, y - 0.6, x + 1.2, y); g.stroke(); }
      }
    }
    // Schatten der Gebäude (Sonne von links oben) – in 3D macht das die Grafikkarte
    g.fillStyle = 'rgba(20,25,30,0.28)';
    if (!opts.flat3d) for (const b of this.buildings) {
      if (!vis([b.bb[0], b.bb[1], b.bb[2] + b.h * 0.5, b.bb[3] + b.h * 0.6])) continue;
      const ox = Math.min(8, b.h * 0.32), oy = Math.min(9, b.h * 0.38);
      path(b.p, true); g.fill();
      g.save(); g.translate(ox, oy); path(b.p, true); g.fill(); g.restore();
      // Verbindung (Schattenkörper)
      g.beginPath();
      for (let k = 0; k < b.p.length; k += 2) {
        const k2 = (k + 2) % b.p.length;
        g.moveTo(b.p[k], b.p[k + 1]); g.lineTo(b.p[k2], b.p[k2 + 1]); g.lineTo(b.p[k2] + ox, b.p[k2 + 1] + oy); g.lineTo(b.p[k] + ox, b.p[k + 1] + oy); g.closePath();
      }
      g.fill();
    }
    // Baumschatten
    if (!opts.flat3d) for (const t of this.trees) if (vis([t.x - 5, t.y - 5, t.x + 8, t.y + 8])) {
      g.beginPath(); g.arc(t.x + 2.2, t.y + 2.6, t.r, 0, 7); g.fill();
    }
    // Rampen
    if (!opts.flat3d) for (const r of this.ramps) if (vis([r.x - 8, r.y - 8, r.x + 8, r.y + 8])) drawRamp(g, r);
    // Basen
    this.bases.forEach((b, i) => {
      if (!vis([b.x - 14, b.y - 14, b.x + 14, b.y + 14])) return;
      const tm = TEAM[i];
      g.fillStyle = tm.color + '40'; g.beginPath(); g.arc(b.x, b.y, 11, 0, 7); g.fill();
      g.strokeStyle = tm.color; g.lineWidth = 0.8; g.setLineDash([2, 1.2]); g.stroke(); g.setLineDash([]);
      g.lineWidth = 0.35; g.beginPath(); g.arc(b.x, b.y, 7, 0, 7); g.stroke();
      g.save(); g.translate(b.x, b.y + 9); g.fillStyle = tm.color; g.font = 'bold 2.4px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('BASIS ' + tm.short, 0, 0); g.restore();
    });
    // Straßennamen & POIs
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const l of this.labels) {
      const R = l.t.length * 1.2 + 4;
      if (l.x + R < x0 || l.x - R > x1 || l.y + R < y0 || l.y - R > y1) continue;
      g.save(); g.translate(l.x, l.y); g.rotate(l.a || 0);
      if (l.k === 0) {
        g.font = '600 2.1px sans-serif'; g.fillStyle = 'rgba(255,255,255,0.55)';
        g.fillText(l.t, 0, 0);
      } else if (l.k === 1) {
        g.font = 'italic 700 2.4px sans-serif'; g.lineWidth = 0.5; g.strokeStyle = 'rgba(0,0,0,0.5)'; g.fillStyle = '#fff6d8';
        g.strokeText(l.t, 0, 0); g.fillText(l.t, 0, 0);
      }
      g.restore();
    }
    return c;
  }
  // Dekal (Reifenspuren, Brandflecken) direkt auf vorhandene Kacheln malen
  decal(x, y, r, fn) {
    const Z = this.tileZ; if (!Z) return;
    const TILE = this.tileM;
    const tx0 = Math.floor((x - r) / TILE), tx1 = Math.floor((x + r) / TILE);
    const ty0 = Math.floor((y - r) / TILE), ty1 = Math.floor((y + r) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const t = this.tiles.get(tx + ',' + ty); if (!t) continue;
      const g = t.getContext('2d');
      g.setTransform(Z, 0, 0, Z, -tx * TILE * Z, -ty * TILE * Z);
      fn(g);
      if (this.onDecal) this.onDecal(tx, ty);
    }
  }
  // Minikarte
  renderMini(size) {
    const s = size / Math.max(this.w, this.h);
    const c = document.createElement('canvas'); c.width = Math.ceil(this.w * s); c.height = Math.ceil(this.h * s);
    const g = c.getContext('2d');
    g.setTransform(s, 0, 0, s, 0, 0);
    // kontrastreich: dunkler Grund, helle Straßen, gedämpfte Häuser
    g.fillStyle = '#2b3030'; g.fillRect(0, 0, this.w, this.h);
    const path = (p, close) => { g.beginPath(); g.moveTo(p[0], p[1]); for (let i = 2; i < p.length; i += 2) g.lineTo(p[i], p[i + 1]); if (close) g.closePath(); };
    for (const a of this.areas) { g.fillStyle = a.t === 'green' ? '#2f4a33' : a.t === 'sand' ? '#5e5640' : '#3b3f42'; path(a.p, true); g.fill(); }
    for (const w of this.water) { g.fillStyle = '#2f7fd8'; path(w.p, true); g.fill(); }
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const r of this.roads) if (r.k === 1) { g.strokeStyle = '#b9bcbf'; g.lineWidth = r.w + 1.5; path(r.p); g.stroke(); }
    for (const r of this.roads) if (r.k === 0) { g.strokeStyle = '#ffffff'; g.lineWidth = r.w + 3; path(r.p); g.stroke(); }
    for (const d of this.decks) { g.strokeStyle = '#ffffff'; g.lineWidth = d.w; g.beginPath(); g.moveTo(d.ax, d.ay); g.lineTo(d.bx, d.by); g.stroke(); }
    for (const t of this.tunnels) { g.strokeStyle = '#8a8f96'; g.setLineDash([6, 4]); g.lineWidth = t.w * 0.7; g.beginPath(); for (let i = 0; i < t.p.length; i += 3) (i ? g.lineTo : g.moveTo).call(g, t.p[i], t.p[i + 1]); g.stroke(); g.setLineDash([]); }
    for (const b of this.buildings) { g.fillStyle = b.lm ? '#7b6a55' : '#45474d'; path(b.p, true); g.fill(); }
    return c;
  }
}

// Dachform wie im 3D-Modell (Satteldach bei 4 Ecken, Zeltdach bei kleinen konvexen Grundrissen)
function roofShape(b) {
  const p = b.p, n = p.length / 2;
  if (n === 4) {
    const len = i => Math.hypot(p[((i + 1) % 4) * 2] - p[i * 2], p[((i + 1) % 4) * 2 + 1] - p[i * 2 + 1]);
    const k = len(1) > len(0) ? 1 : 0;
    const P = i => [p[((i + k) % 4) * 2], p[((i + k) % 4) * 2 + 1]];
    const half = len((k + 1) % 4) / 2, rise = Math.min(8.5, half * 0.95);   // steile Satteldächer (~45°)
    const a = P(0), d = P(3), bb = P(1), cc = P(2);
    return { t: 1, half, rise, r: [(a[0] + d[0]) / 2, (a[1] + d[1]) / 2, (bb[0] + cc[0]) / 2, (bb[1] + cc[1]) / 2] };
  }
  const mans = () => {   // verwinkelter Grundriss: umlaufend geneigtes (Mansard-)Dach
    const sg = [];
    for (let i = 0; i < n; i++) { const j = (i + 1) % n; sg.push([p[i * 2], p[i * 2 + 1], p[j * 2], p[j * 2 + 1]]); }
    return { t: 3, rise: 3.4, d: 3.0, sg };
  };
  if (n > 10) return mans();
  let sign = 0;
  for (let i = 0; i < n; i++) {
    const a = i * 2, c1 = ((i + 1) % n) * 2, c2 = ((i + 2) % n) * 2;
    const cr = (p[c1] - p[a]) * (p[c2 + 1] - p[c1 + 1]) - (p[c1 + 1] - p[a + 1]) * (p[c2] - p[c1]);
    if (Math.abs(cr) < 1e-6) continue;
    if (sign && Math.sign(cr) !== sign) return mans();
    sign = Math.sign(cr);
  }
  let A = 0; for (let i = 0; i < n; i++) { const j = (i + 1) % n; A += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1]; }
  const rise = Math.min(7, Math.sqrt(Math.abs(A / 2)) * 0.3 + 1.5), ed = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, ax = p[i * 2], ay = p[i * 2 + 1], L = Math.hypot(p[j * 2] - ax, p[j * 2 + 1] - ay) || 1;
    const nx = -(p[j * 2 + 1] - ay) / L, ny = (p[j * 2] - ax) / L;
    ed.push([ax, ay, nx, ny, Math.abs((b.cx - ax) * nx + (b.cy - ay) * ny) || 1]);
  }
  return { t: 2, rise, ed };
}
function roofZ(b, x, y) {
  const f = b.rf;
  if (f.t === 1) {
    const [ax, ay, bx, by] = f.r, dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    const d = Math.hypot(x - ax - dx * t, y - ay - dy * t);
    return b.top + f.rise * Math.max(0, 1 - d / f.half);
  }
  if (f.t === 3) {
    let dm = f.d;
    for (const [ax, ay, bx, by] of f.sg) {
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
      dm = Math.min(dm, Math.hypot(x - ax - dx * t, y - ay - dy * t));
    }
    return b.top + f.rise * dm / f.d;
  }
  let m = 1;
  for (const [ax, ay, nx, ny, da] of f.ed) m = Math.min(m, Math.abs((x - ax) * nx + (y - ay) * ny) / da);
  return b.top + f.rise * m;
}

// Gras: feine helle/dunkle Halme, Wildblumen-Tupfer und natürliche Schattierungen (4 m Kachel)
let _grass = null;
function grassPattern(g) {
  if (!_grass) {
    const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d');
    let h = 12345; const r = () => ((h = (h * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 12; i++) { const gx = r() * 128, gy = r() * 128, rr = 18 + r() * 34, gr = x.createRadialGradient(gx, gy, 0, gx, gy, rr); gr.addColorStop(0, r() < 0.5 ? 'rgba(28,58,12,0.12)' : 'rgba(185,220,115,0.09)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = gr; x.fillRect(0, 0, 128, 128); }
    for (let i = 0; i < 1100; i++) { x.strokeStyle = r() < 0.5 ? 'rgba(22,52,14,0.19)' : 'rgba(170,212,108,0.17)'; x.lineWidth = 1; const px = r() * 128, py = r() * 128; x.beginPath(); x.moveTo(px, py); x.lineTo(px + (r() - 0.5) * 2.2, py - 2 - r() * 3.2); x.stroke(); }
    for (let i = 0; i < 24; i++) { x.fillStyle = r() < 0.65 ? 'rgba(255,235,120,0.22)' : 'rgba(255,255,255,0.20)'; x.fillRect(r() * 128, r() * 128, 1.5, 1.5); }
    _grass = c;
  }
  try {
    const pt = g.createPattern(_grass, 'repeat');
    if (!pt || !pt.setTransform || typeof DOMMatrix === 'undefined') return null;
    pt.setTransform(new DOMMatrix().scale(4 / 128));
    return pt;
  } catch (e) { return null; }
}
// Kopfsteinpflaster-Muster mit Stein-Variationen (gecacht); fan = Fächerpflaster für Plätze
const _cob = {};
function cobblePattern(g, fan) {
  const key = fan ? 'f' : 'n';
  if (!_cob[key]) {
    const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
    let h = fan ? 54321 : 98765; const r = () => ((h = (h * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    x.strokeStyle = fan ? 'rgba(65,55,45,0.24)' : 'rgba(55,50,45,0.15)'; x.lineWidth = 1.3;
    if (fan) {
      for (let cy = 0; cy <= 64; cy += 32) for (let cx = 0; cx <= 64; cx += 32) for (let rad = 6; rad <= 30; rad += 6) { x.beginPath(); x.arc(cx, cy + 16, rad, Math.PI * 1.15, Math.PI * 1.85); x.stroke(); }
    } else {
      for (let y = 0; y < 64; y += 8) {
        x.beginPath(); x.moveTo(0, y); x.lineTo(64, y); x.stroke();
        for (let xx = (y / 8) % 2 ? 4 : 0; xx < 64; xx += 8) {
          x.fillStyle = r() < 0.5 ? 'rgba(0,0,0,0.035)' : 'rgba(255,255,255,0.04)';
          x.fillRect(xx + 1, y + 1, 6, 6);
          x.beginPath(); x.moveTo(xx, y); x.lineTo(xx, y + 8); x.stroke();
        }
      }
    }
    _cob[key] = c;
  }
  try {
    const pt = g.createPattern(_cob[key], 'repeat');
    if (!pt || !pt.setTransform || typeof DOMMatrix === 'undefined') return null;
    pt.setTransform(new DOMMatrix().scale(2 / 64));
    return pt;
  } catch (e) { return null; }
}
// Subtiles Asphalt-Korn für 2D/3D-Kacheln
let _asph = null;
function asphaltPattern(g) {
  if (!_asph) {
    const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d');
    let h = 24680; const r = () => ((h = (h * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 8; i++) {
      const gx = r() * 128, gy = r() * 128, rr = 18 + r() * 28, gr = x.createRadialGradient(gx, gy, 0, gx, gy, rr);
      gr.addColorStop(0, r() < 0.5 ? 'rgba(0,0,0,0.07)' : 'rgba(255,255,255,0.045)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = gr; x.fillRect(0, 0, 128, 128);
    }
    for (let i = 0; i < 650; i++) {
      x.fillStyle = r() < 0.52 ? 'rgba(0,0,0,0.09)' : 'rgba(235,240,250,0.07)';
      x.fillRect(r() * 128, r() * 128, 1 + r() * 1.2, 1 + r() * 1.2);
    }
    _asph = c;
  }
  try {
    const pt = g.createPattern(_asph, 'repeat');
    if (!pt || !pt.setTransform || typeof DOMMatrix === 'undefined') return null;
    pt.setTransform(new DOMMatrix().scale(6 / 128));
    return pt;
  } catch (e) { return null; }
}

function drawRamp(g, r) {
  g.save(); g.translate(r.x, r.y); g.rotate(r.a);
  const L = r.len, Wd = r.wid;
  const gr = g.createLinearGradient(-L / 2, 0, L / 2, 0);
  gr.addColorStop(0, '#6b5a3a'); gr.addColorStop(1, '#d9b45a');
  g.fillStyle = gr; g.fillRect(-L / 2, -Wd / 2, L, Wd);
  g.fillStyle = '#222';
  for (let i = 0; i < 5; i++) g.fillRect(-L / 2 + i * L / 5 + 0.3, -Wd / 2, L / 10, Wd);
  g.fillStyle = 'rgba(255,220,60,0.9)';
  g.beginPath(); g.moveTo(L / 2 - 0.4, 0); g.lineTo(L / 2 - 2.2, -1.4); g.lineTo(L / 2 - 2.2, 1.4); g.closePath(); g.fill();
  g.strokeStyle = '#2a2014'; g.lineWidth = 0.3; g.strokeRect(-L / 2, -Wd / 2, L, Wd);
  g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(L / 2, -Wd / 2, 1.2, Wd);
  g.restore();
}
