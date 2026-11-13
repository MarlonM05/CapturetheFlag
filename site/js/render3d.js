'use strict';
// ---------------------------------------------------------------------------
// 3D-Ansicht mit Three.js. Spiel-Logik bleibt unverändert in Metern:
// Welt (x, y, Höhe z)  ->  Three.js (x, z, y)
// ---------------------------------------------------------------------------

const R3 = {
  gl: null,
  supported() {
    if (typeof THREE === 'undefined') return false;
    try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; }
  },
  renderer(canvas) {
    if (!this.gl) {
      this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
      this.gl.shadowMap.enabled = true;
      this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    }
    return this.gl;
  },
  colors: new Map(),
  col(css) {
    let c = this.colors.get(css);
    if (!c) { c = new THREE.Color(); try { c.setStyle(css); } catch (e) { c.set('#888'); } this.colors.set(css, c); }
    return c;
  },
  faceTex: new Map(),
  face(id, label) {
    const key = id || ('#' + (label || '?'));
    let t = this.faceTex.get(key);
    if (!t) {
      const img = DRIVER_IMG[id];
      if (img && img.complete && img.naturalWidth) { t = new THREE.Texture(img); t.needsUpdate = true; }
      else {
        const c = document.createElement('canvas'); c.width = c.height = 64;
        const g = c.getContext('2d'); g.fillStyle = '#2a2f3b'; g.fillRect(0, 0, 64, 64);
        g.fillStyle = '#fff'; g.font = '800 40px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(((label || '?').trim()[0] || '?').toUpperCase(), 32, 34);
        t = new THREE.CanvasTexture(c);
      }
      this.faceTex.set(key, t);
    }
    return t;
  },
};

// Abgerundete Box (weiche Kanten statt Klötzchen-Look)
function roundBox(w, h, d, r) {
  const g = new THREE.BoxGeometry(w, h, d, 3, 3, 3), p = g.attributes.position, hx = w / 2 - r, hy = h / 2 - r, hz = d / 2 - r;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const cx = Math.max(-hx, Math.min(hx, x)), cy = Math.max(-hy, Math.min(hy, y)), cz = Math.max(-hz, Math.min(hz, z));
    let dx = x - cx, dy = y - cy, dz = z - cz; const l = Math.hypot(dx, dy, dz) || 1;
    p.setXYZ(i, cx + dx / l * r, cy + dy / l * r, cz + dz / l * r);
  }
  g.computeVertexNormals();
  return g;
}
const CAR_H = { sport: 1.15, buggy: 1.3, tank: 1.55, jeep: 1.6, truck: 1.85 };

class Renderer3D {
  constructor(game, canvas) {
    this.game = game; this.canvas = canvas;
    this.gl = R3.renderer(canvas);
    canvas.style.display = 'block';
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#a9cbe6');
    this.scene.fog = new THREE.Fog('#b7d3ea', 150, 460);
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.5, 1800);
    this.pitch = 1.1;    // ~63° von oben – weniger Verdeckung durch Häuser
    this.camDist = 125;
    this.ray = new THREE.Raycaster();
    this.tmpV = new THREE.Vector3();
    this.dummy = new THREE.Object3D();
    this.disposables = [];
    this.buildLights();
    this.buildGround();
    this.buildBuildings();
    this.buildTrees();
    this.buildStatic();
    this.buildDynamic();
    this.cars = new Map();
    for (const c of game.cars) this.cars.set(c, this.makeCar(c));
    this.resize();
  }
  track(x) { this.disposables.push(x); return x; }
  mat(o, type = 'Lambert') { return this.track(new THREE['Mesh' + type + 'Material'](o)); }

  // ---------------- Licht ----------------
  buildLights() {
    const s = this.scene;
    s.add(new THREE.HemisphereLight('#f6f9ff', '#8a7f62', 0.74));
    const sun = this.sun = new THREE.DirectionalLight('#fff3dc', 0.85);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -95; sc.right = 95; sc.top = 95; sc.bottom = -95; sc.near = 10; sc.far = 400;
    sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.04;
    s.add(sun); s.add(sun.target);
  }

  // ---------------- Boden: Geländenetz mit den 2D-Kacheln als Textur ----------------
  buildGround() {
    const W = this.game.world;
    const T = Math.ceil(Math.max(W.w / 2, W.h / 3)) + 2;      // höchstens 2 × 3 Kacheln
    const PX = 1536, Z = PX / T;
    W.tiles = new Map(); W.tileZ = Z; W.tileM = T;
    this.groundTex = new Map(); this.dirty = new Set(); this.lastUpload = 0;
    const aniso = this.gl.capabilities.getMaxAnisotropy();
    const SEG = W.tres || 4;   // Gitterweite = Raster der Höhenkarte
    // Löcher im Gelände an den Tunnelportalen (sonst sähe man nicht hinein)
    const portals = [];
    for (const tn of W.tunnels) { const q = tn.p; portals.push([q[0], q[1]], [q[q.length - 3], q[q.length - 2]]); }
    const hole = (x, y) => {
      if (!portals.length) return false;
      const t = W.tunnelAt(x, y);
      if (!t) return false;
      if (W.terrain(x, y) < t.floor + 1.5) return false;
      return portals.some(([px, py]) => (x - px) ** 2 + (y - py) ** 2 < 26 * 26);
    };
    for (let ty = 0; ty * T < W.h; ty++) for (let tx = 0; tx * T < W.w; tx++) {
      const cv = W.renderTile(tx, ty, Z, { px: PX, flat3d: true });
      W.tiles.set(tx + ',' + ty, cv);
      const tex = this.track(new THREE.CanvasTexture(cv));
      tex.anisotropy = aniso;
      this.groundTex.set(tx + ',' + ty, tex);
      const n = Math.ceil(T / SEG), x0 = tx * T, y0 = ty * T;
      const pos = new Float32Array((n + 1) * (n + 1) * 3), uv = new Float32Array((n + 1) * (n + 1) * 2);
      for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
        const k = j * (n + 1) + i, x = x0 + i * T / n, y = y0 + j * T / n;
        pos[k * 3] = x; pos[k * 3 + 1] = W.terrain(x, y); pos[k * 3 + 2] = y;
        uv[k * 2] = i / n; uv[k * 2 + 1] = 1 - j / n;
      }
      const idx = [];
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
        if (hole(x0 + (i + 0.5) * T / n, y0 + (j + 0.5) * T / n)) continue;
        idx.push(a, c, b, b, c, d);
      }
      const g = this.track(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, this.mat({ map: tex }));
      m.receiveShadow = true; m.castShadow = true;
      this.scene.add(m);
    }
    W.onDecal = (tx, ty) => this.dirty.add(tx + ',' + ty);
    // Umland
    const out = new THREE.Mesh(this.track(new THREE.PlaneGeometry(5000, 5000)), this.mat({ color: '#4c5a3d' }));
    out.rotation.x = -Math.PI / 2; out.position.set(W.w / 2, -2.5, W.h / 2);
    this.scene.add(out);
    // Wasser als glänzende Fläche in Höhe des Wasserspiegels
    for (const w of W.water) {
      const geo = this.polyGeo(w.p, w.z + 0.05);
      if (!geo) continue;
      const m = new THREE.Mesh(geo, this.mat({ color: '#2f6db0', specular: '#cfe6ff', shininess: 90, transparent: true, opacity: 0.85 }, 'Phong'));
      m.receiveShadow = true;
      this.scene.add(m);
    }
  }
  polyGeo(p, y) {
    const pts = [];
    for (let i = 0; i < p.length; i += 2) pts.push(new THREE.Vector2(p[i], p[i + 1]));
    let tris;
    try { tris = THREE.ShapeUtils.triangulateShape(pts, []); } catch (e) { return null; }
    if (!tris.length) return null;
    const pos = [];
    for (const t of tris) for (const k of [t[0], t[2], t[1]]) pos.push(pts[k].x, y, pts[k].y);
    const g = this.track(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    return g;
  }

  // ---------------- Texturen (Fassade, Dach, Asphalt …) ----------------
  canvasTex(w, h, draw, repeat = true) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = this.track(new THREE.CanvasTexture(c));
    if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
    t.anisotropy = this.gl.capabilities.getMaxAnisotropy();
    return t;
  }
  noise(g, w, h, n, a, b) {
    for (let i = 0; i < n; i++) { g.fillStyle = Math.random() < 0.5 ? a : b; g.fillRect(Math.random() * w, Math.random() * h, 1 + Math.random() * 2, 1 + Math.random() * 2); }
  }
  makeTextures() {
    if (this.tex) return this.tex;
    // Fassade: 2 Fenster × 2 Stockwerke = 6 m × 6,4 m, graustufig (wird mit der Wandfarbe eingefärbt)
    const facade = this.canvasTex(256, 256, (g, w, h) => {
      g.fillStyle = '#f4f4f4'; g.fillRect(0, 0, w, h);
      this.noise(g, w, h, 900, 'rgba(0,0,0,0.05)', 'rgba(255,255,255,0.08)');
      for (let fy = 0; fy < 2; fy++) {
        g.fillStyle = 'rgba(0,0,0,0.10)'; g.fillRect(0, fy * 128 + 124, w, 4);
        for (let fx = 0; fx < 2; fx++) {
          const x = fx * 128 + 38, y = fy * 128 + 30;
          g.fillStyle = '#5c5c5c'; g.fillRect(x - 14, y - 2, 12, 66); g.fillRect(x + 54, y - 2, 12, 66); // Fensterläden
          g.fillStyle = '#d8d8d8'; g.fillRect(x - 3, y - 3, 58, 68);
          const gr = g.createLinearGradient(x, y, x + 52, y + 62);
          gr.addColorStop(0, '#5d6f80'); gr.addColorStop(0.5, '#2c3946'); gr.addColorStop(1, '#46566a');
          g.fillStyle = gr; g.fillRect(x, y, 52, 62);
          g.fillStyle = '#d8d8d8'; g.fillRect(x + 24, y, 4, 62); g.fillRect(x, y + 26, 52, 4);
          g.fillStyle = '#c4c4c4'; g.fillRect(x - 6, y + 64, 64, 6);
        }
      }
    });
    // Dachziegel
    const roof = this.canvasTex(128, 128, (g, w, h) => {
      g.fillStyle = '#ececec'; g.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 16) {
        g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(0, y + 13, w, 3);
        for (let x = (y / 16) % 2 ? 8 : 0; x < w; x += 16) { g.fillStyle = 'rgba(0,0,0,0.12)'; g.fillRect(x, y, 2, 14); }
      }
      this.noise(g, w, h, 300, 'rgba(0,0,0,0.08)', 'rgba(255,255,255,0.1)');
    });
    const asphalt = this.canvasTex(256, 256, (g, w, h) => {
      g.fillStyle = '#4b4e54'; g.fillRect(0, 0, w, h);
      this.noise(g, w, h, 4000, 'rgba(0,0,0,0.18)', 'rgba(255,255,255,0.07)');
      g.strokeStyle = 'rgba(20,20,20,0.25)'; g.lineWidth = 2; g.beginPath(); g.moveTo(30, 0); g.bezierCurveTo(60, 80, 10, 150, 50, 256); g.stroke();
    });
    const pavers = (base) => this.canvasTex(128, 128, (g, w, h) => {
      g.fillStyle = base; g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = 2;
      for (let y = 0; y <= h; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
      for (let y = 0; y < h; y += 32) for (let x = (y / 32) % 2 ? 16 : 0; x <= w; x += 32) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 32); g.stroke(); }
      this.noise(g, w, h, 500, 'rgba(0,0,0,0.06)', 'rgba(255,255,255,0.08)');
    });
    // zweite Fassade: Rundbogen-Fenster und Arkaden im Erdgeschoss
    const arches = this.canvasTex(256, 256, (g, w, h) => {
      g.fillStyle = '#f4f4f4'; g.fillRect(0, 0, w, h);
      this.noise(g, w, h, 900, 'rgba(0,0,0,0.05)', 'rgba(255,255,255,0.08)');
      const arch = (x, y, ww, hh, fill) => { g.beginPath(); g.moveTo(x, y + hh); g.lineTo(x, y + ww / 2); g.arc(x + ww / 2, y + ww / 2, ww / 2, Math.PI, 0); g.lineTo(x + ww, y + hh); g.closePath(); g.fillStyle = fill; g.fill(); };
      g.fillStyle = 'rgba(0,0,0,0.10)'; g.fillRect(0, 124, w, 4);
      for (let fx = 0; fx < 2; fx++) {
        const x = fx * 128 + 36;
        arch(x - 4, 22, 64, 74, '#d6d6d6');
        const gr = g.createLinearGradient(x, 26, x + 56, 96); gr.addColorStop(0, '#5d6f80'); gr.addColorStop(1, '#2f3c4a');
        arch(x, 26, 56, 70, gr);
        g.fillStyle = '#d6d6d6'; g.fillRect(x + 26, 40, 4, 56);
        arch(fx * 128 + 18, 150, 92, 106, '#cfcfcf'); arch(fx * 128 + 26, 160, 76, 96, '#3a3530');   // Arkadenbogen
      }
    });
    const dash = this.canvasTex(64, 16, (g, w, h) => { g.clearRect(0, 0, w, h); g.fillStyle = '#f2f2ea'; g.fillRect(0, 0, w * 0.55, h); });
    this.tex = { facade, arches, roof, asphalt, sidewalk: pavers('#a6a296'), foot: pavers('#ada28c'), dash };
    return this.tex;
  }

  // ---------------- Gebäude: Fassaden mit Fenstern, Ziegeldächer ----------------
  buildBuildings() {
    const T = this.makeTextures();
    const wallA = { pos: [], col: [], uv: [] }, wallB = { pos: [], col: [], uv: [] }, roofB = { pos: [], col: [], uv: [] };
    const towers = [];   // runde Ecktürme mit Kegeldach: [x, y, r, z0, h, Wandfarbe, Dachfarbe]
    let bi = 0;
    const put = (B, v, c, u) => { B.pos.push(v[0], v[1], v[2]); B.col.push(c.r, c.g, c.b); B.uv.push(u[0], u[1]); };
    const tri = (B, a, b, c, col, ua, ub, uc) => { put(B, a, col, ua); put(B, b, col, ub); put(B, c, col, uc); };
    const FW = 6, FH = 6.4;  // Fassaden-Kachel in Metern
    for (const b of this.game.world.buildings) {
      if (b.lm) continue;   // Wahrzeichen haben eigene Modelle
      const p = b.p, n = p.length / 2, h = b.top, z0 = b.base;
      const wc = R3.col(b.wall), rc = R3.col(b.roof);
      const hsh = (bi++ * 2654435761) >>> 0;
      const wall = b.c !== 4 && hsh % 10 < 3 ? wallB : wallA;
      // Wände
      let run = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = p[i * 2], ay = p[i * 2 + 1], bx = p[j * 2], by = p[j * 2 + 1];
        const L = Math.hypot(bx - ax, by - ay);
        const u0 = run / FW, u1 = (run + L) / FW, v0 = 0, v1 = (h - z0) / FH;
        run += L;
        tri(wall, [ax, z0, ay], [bx, z0, by], [bx, h, by], wc, [u0, v0], [u1, v0], [u1, v1]);
        tri(wall, [ax, z0, ay], [bx, h, by], [ax, h, ay], wc, [u0, v0], [u1, v1], [u0, v1]);
      }
      // Dach
      if (!b.flat && n === 4) {
        let k = 0;
        const len = i => Math.hypot(p[((i + 1) % 4) * 2] - p[i * 2], p[((i + 1) % 4) * 2 + 1] - p[i * 2 + 1]);
        if (len(1) > len(0)) k = 1;
        const P = i => [p[((i + k) % 4) * 2], p[((i + k) % 4) * 2 + 1]];
        const [p0, p1, p2, p3] = [P(0), P(1), P(2), P(3)];
        const half = len((k + 1) % 4) / 2, rise = Math.min(4.5, half * 0.85);
        const rh = h + rise, slope = Math.hypot(half, rise) / 3, ridge = len(k) / 3;
        const r0 = [(p0[0] + p3[0]) / 2, rh, (p0[1] + p3[1]) / 2], r1 = [(p1[0] + p2[0]) / 2, rh, (p1[1] + p2[1]) / 2];
        const q = v => [v[0], h, v[1]];
        const dark = rc.clone().multiplyScalar(0.84);
        tri(roofB, q(p0), q(p1), r1, rc, [0, 0], [ridge, 0], [ridge, slope]); tri(roofB, q(p0), r1, r0, rc, [0, 0], [ridge, slope], [0, slope]);
        tri(roofB, q(p2), q(p3), r0, dark, [0, 0], [ridge, 0], [ridge, slope]); tri(roofB, q(p2), r0, r1, dark, [0, 0], [ridge, slope], [0, slope]);
        // Giebel (Wandfarbe, ohne Fenster)
        const gv = (h - z0) / FH, gt = (rh - z0) / FH;
        tri(wall, q(p3), q(p0), r0, wc, [0.02, gv], [0.03, gv], [0.025, Math.min(gt, gv + 0.12)]);
        tri(wall, q(p1), q(p2), r1, wc, [0.02, gv], [0.03, gv], [0.025, Math.min(gt, gv + 0.12)]);
        // manche Eckhäuser bekommen einen runden Turm mit spitzem Kegeldach
        const sh = Math.min(len(0), len(1));
        if (hsh % 9 === 0 && sh > 9 && h - z0 > 7) {
          const tr = Math.min(3.2, sh * 0.28), c0 = p0, ex = [p1[0] - p0[0], p1[1] - p0[1]], ey = [p3[0] - p0[0], p3[1] - p0[1]];
          const lx = Math.hypot(ex[0], ex[1]), ly = Math.hypot(ey[0], ey[1]);
          const tx = c0[0] + ex[0] / lx * tr * 1.05 + ey[0] / ly * tr * 1.05, ty = c0[1] + ex[1] / lx * tr * 1.05 + ey[1] / ly * tr * 1.05;
          towers.push([tx, ty, tr, z0, h - z0 + rise + 1.5, wc, rc]);
        }
      } else if (!b.flat && n <= 10 && this.convex(p)) {
        let A = 0; for (let i = 0; i < n; i++) { const j = (i + 1) % n; A += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1]; }
        const rh = h + Math.min(4, Math.sqrt(Math.abs(A / 2)) * 0.22 + 1.2);
        const apex = [b.cx, rh, b.cy];
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const ax = p[i * 2], ay = p[i * 2 + 1], bx = p[j * 2], by = p[j * 2 + 1];
          const L = Math.hypot(bx - ax, by - ay) || 1;
          // Abstand der Spitze zur Kante -> v
          const dist = Math.abs((bx - ax) * (ay - b.cy) - (ax - b.cx) * (by - ay)) / L;
          const tproj = ((b.cx - ax) * (bx - ax) + (b.cy - ay) * (by - ay)) / L;
          const sl = Math.hypot(dist, rh - h) / 3;
          tri(roofB, [ax, h, ay], [bx, h, by], apex, i % 2 ? rc : rc.clone().multiplyScalar(0.86), [0, 0], [L / 3, 0], [tproj / 3, sl]);
        }
      } else {
        const pts = [];
        for (let i = 0; i < n; i++) pts.push(new THREE.Vector2(p[i * 2], p[i * 2 + 1]));
        let tris = [];
        try { tris = THREE.ShapeUtils.triangulateShape(pts, []); } catch (e) { /* egal */ }
        const fc = b.c === 4 ? R3.col('#8f9396') : rc.clone().multiplyScalar(0.8);
        for (const t of tris) {
          const A = pts[t[0]], B = pts[t[2]], C = pts[t[1]];
          tri(roofB, [A.x, h, A.y], [B.x, h, B.y], [C.x, h, C.y], fc, [A.x / 6, A.y / 6], [B.x / 6, B.y / 6], [C.x / 6, C.y / 6]);
        }
      }
    }
    const mk = (B, map) => {
      const g = this.track(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(B.col, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(B.uv, 2));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, this.mat({ vertexColors: true, map, side: THREE.DoubleSide }));
      m.castShadow = true; m.receiveShadow = true;
      this.scene.add(m);
    };
    mk(wallA, T.facade); mk(wallB, T.arches); mk(roofB, T.roof);
    if (towers.length) {
      const cyl = new THREE.InstancedMesh(this.track(new THREE.CylinderGeometry(1, 1, 1, 16)), this.mat({ map: T.facade }), towers.length);
      const cone = new THREE.InstancedMesh(this.track(new THREE.ConeGeometry(1.18, 1, 16)), this.mat({ map: T.roof }), towers.length);
      const d = new THREE.Object3D();
      towers.forEach(([x, y, r, z0, hh, wc, rc], i) => {
        d.position.set(x, z0 + hh / 2, y); d.scale.set(r, hh, r); d.updateMatrix(); cyl.setMatrixAt(i, d.matrix); cyl.setColorAt(i, wc);
        d.position.set(x, z0 + hh + r * 0.9, y); d.scale.set(r, r * 1.8, r); d.updateMatrix(); cone.setMatrixAt(i, d.matrix); cone.setColorAt(i, rc);
      });
      cyl.geometry.attributes.uv.array.forEach((v, i, a) => { if (i % 2 === 0) a[i] = v * 2; });
      for (const m of [cyl, cone]) { m.castShadow = true; m.receiveShadow = true; this.scene.add(m); }
    }
    this.buildRoads();
    this.buildDecks();
    this.buildRails();
    this.buildTunnels();
    this.buildLandmarks();
  }

  // ---------------- Straßen als echte Bänder (scharf auch aus der Nähe) ----------------
  ribbon(B, flat0, w, y, uScale, offset = 0) {
    // Polylinie verdichten, damit das Band dem Gelände folgt
    const flat = [];
    for (let i = 0; i + 1 < flat0.length; i += 2) {
      const x = flat0[i], yy = flat0[i + 1];
      if (i + 3 < flat0.length) {
        const nx = flat0[i + 2], ny = flat0[i + 3], L = Math.hypot(nx - x, ny - yy), k = Math.max(1, Math.ceil(L / 5));
        for (let s = 0; s < k; s++) flat.push(x + (nx - x) * s / k, yy + (ny - yy) * s / k);
      } else flat.push(x, yy);
    }
    const n = flat.length / 2;
    if (n < 2) return;
    const W = this.game.world;
    const P = i => [flat[i * 2], flat[i * 2 + 1]];
    const norms = [];
    for (let i = 0; i < n; i++) {
      const a = P(Math.max(0, i - 1)), b = P(i), c = P(Math.min(n - 1, i + 1));
      let n1x = 0, n1y = 0;
      if (i > 0) { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; n1x += -dy / l; n1y += dx / l; }
      if (i < n - 1) { const dx = c[0] - b[0], dy = c[1] - b[1], l = Math.hypot(dx, dy) || 1; n1x += -dy / l; n1y += dx / l; }
      const l = Math.hypot(n1x, n1y) || 1;
      let nx = n1x / l, ny = n1y / l;
      // Gehrung begrenzen
      if (i > 0 && i < n - 1) {
        const dx = c[0] - b[0], dy = c[1] - b[1], ll = Math.hypot(dx, dy) || 1;
        const cos = nx * (-dy / ll) + ny * (dx / ll);
        const f = 1 / Math.max(0.5, cos); nx *= f; ny *= f;
      }
      norms.push([nx, ny]);
    }
    let u = 0;
    for (let i = 0; i < n - 1; i++) {
      const a = P(i), b = P(i + 1), na = norms[i], nb = norms[i + 1];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const off = (pt, nn, s) => { const x = pt[0] + nn[0] * (offset + s * w / 2), z = pt[1] + nn[1] * (offset + s * w / 2); return [x, W.terrain(x, z) + y, z]; };
      const al = off(a, na, 1), ar = off(a, na, -1), bl = off(b, nb, 1), br = off(b, nb, -1);
      const u0 = u / uScale, u1 = (u + L) / uScale;
      B.pos.push(...al, ...ar, ...br, ...al, ...br, ...bl);
      B.uv.push(u0, 1, u0, 0, u1, 0, u0, 1, u1, 0, u1, 1);
      u += L;
    }
  }
  buildRoads() {
    const T = this.makeTextures(), W = this.game.world;
    const L = { side: { pos: [], uv: [] }, foot: { pos: [], uv: [] }, asph: { pos: [], uv: [] }, curb: { pos: [], uv: [] }, line: { pos: [], uv: [] }, edge: { pos: [], uv: [] } };
    const lamps = [];
    for (const r of W.roads) {
      if (r.k > 2) continue;
      if (r.k === 2) { this.ribbon(L.foot, r.p, Math.min(r.w, 5), 0.035, 2.2); continue; }
      // Gehwege als zwei schmale Streifen (folgen dem Gelände sauber, auch in Einschnitten)
      this.ribbon(L.side, r.p, 1.8, 0.03, 2.2, r.w / 2 + 0.85);
      this.ribbon(L.side, r.p, 1.8, 0.03, 2.2, -r.w / 2 - 0.85);
      this.ribbon(L.asph, r.p, r.w, 0.07, 8);
      this.ribbon(L.curb, r.p, 0.3, 0.1, 2, r.w / 2 + 0.1);
      this.ribbon(L.curb, r.p, 0.3, 0.1, 2, -r.w / 2 - 0.1);
      if (r.k === 0 || r.w >= 9) this.ribbon(L.line, r.p, 0.22, 0.085, 6);
      if (r.k === 0) for (const sg of [1, -1]) this.ribbon(L.edge, r.p, 0.2, 0.085, 6, sg * (r.w / 2 - 0.7));
      // Laternen
      let acc = 12, side = 1;
      for (let i = 0; i + 3 < r.p.length; i += 2) {
        const ax = r.p[i], ay = r.p[i + 1], bx = r.p[i + 2], by = r.p[i + 3];
        const seg = Math.hypot(bx - ax, by - ay); if (!seg) continue;
        const nx = -(by - ay) / seg, ny = (bx - ax) / seg;
        for (let d = 30 - acc; d < seg; d += 30) {
          const x = ax + (bx - ax) * d / seg + nx * side * (r.w / 2 + 1.3), y = ay + (by - ay) * d / seg + ny * side * (r.w / 2 + 1.3);
          if (x > 2 && y > 2 && x < W.w - 2 && y < W.h - 2 && !W.buildingAt(x, y) && !W.inWater(x, y)) lamps.push([x, y, Math.atan2(-ny * side, -nx * side)]);
          side = -side;
        }
        acc = (acc + seg) % 30;
      }
    }
    const mk = (B, mat, ro) => {
      if (!B.pos.length) return;
      const g = this.track(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(B.uv, 2));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true; m.renderOrder = ro;
      this.scene.add(m);
    };
    const po = (o, f) => Object.assign(o, { polygonOffset: true, polygonOffsetFactor: f, polygonOffsetUnits: f, side: THREE.DoubleSide });
    mk(L.foot, this.mat(po({ map: T.foot }, -1)), 1);
    mk(L.side, this.mat(po({ map: T.sidewalk }, -1)), 1);
    mk(L.asph, this.mat(po({ map: T.asphalt }, -2)), 2);
    mk(L.curb, this.mat(po({ color: '#c9c5bc' }, -3)), 3);
    mk(L.line, this.mat(po({ map: T.dash, transparent: true, alphaTest: 0.3 }, -4)), 4);
    mk(L.edge, this.mat(po({ color: '#ecebe2' }, -4)), 4);
    // Straßenlaternen
    if (lamps.length) {
      const pole = new THREE.InstancedMesh(this.track(new THREE.CylinderGeometry(0.09, 0.13, 5.5, 6)), this.mat({ color: '#3c4046' }), lamps.length);
      const head = new THREE.InstancedMesh(this.track(new THREE.BoxGeometry(1.2, 0.25, 0.45)), this.mat({ color: '#fff6d0', emissive: '#8a7d40' }), lamps.length);
      const d = this.dummy;
      lamps.forEach(([x, y, a], i) => {
        const gz = W.terrain(x, y);
        d.position.set(x, gz + 2.75, y); d.rotation.set(0, 0, 0); d.scale.set(1, 1, 1); d.updateMatrix(); pole.setMatrixAt(i, d.matrix);
        d.position.set(x + Math.cos(a) * 0.5, gz + 5.5, y + Math.sin(a) * 0.5); d.rotation.set(0, -a, 0); d.updateMatrix(); head.setMatrixAt(i, d.matrix);
      });
      pole.castShadow = true;
      this.scene.add(pole, head);
    }
  }
  // ---------------- Brücken mit Geländer und Pfeilern ----------------
  buildDecks() {
    const W = this.game.world, T = this.makeTextures();
    const concrete = this.mat({ color: '#b9b5ad' }), rail = this.mat({ color: '#d0d3d6' }), asph = this.mat({ map: T.asphalt, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    for (const d of W.decks) {
      const ang = Math.atan2(d.uy, d.ux), z = Math.max(d.az, d.bz), mx = (d.ax + d.bx) / 2, my = (d.ay + d.by) / 2;
      const grp = new THREE.Group(); grp.position.set(mx, z, my); grp.rotation.y = -ang;
      const slab = new THREE.Mesh(this.track(new THREE.BoxGeometry(d.L + 0.6, 1.2, d.w)), concrete); slab.position.y = -0.6; grp.add(slab);
      const road = new THREE.Mesh(this.track(new THREE.PlaneGeometry(d.L, d.w - 2.2)), asph); road.rotation.x = -Math.PI / 2; road.position.y = 0.04; grp.add(road);
      road.geometry.attributes.uv.array.forEach((v, i, a) => { if (i % 2 === 0) a[i] = v * d.L / 8; });
      for (const sgn of [1, -1]) {
        const r = new THREE.Mesh(this.track(new THREE.BoxGeometry(d.L, 1.1, 0.3)), rail); r.position.set(0, 0.55, sgn * (d.w / 2 - 0.15)); grp.add(r);
        const curb = new THREE.Mesh(this.track(new THREE.BoxGeometry(d.L, 0.25, 1.0)), concrete); curb.position.set(0, 0.12, sgn * (d.w / 2 - 0.6)); grp.add(curb);
        // Pfeiler an beiden Enden
        for (const t of [-0.42, 0.42]) {
          const px = mx + d.ux * d.L * t + -d.uy * sgn * (d.w / 2 - 1.2), py = my + d.uy * d.L * t + d.ux * sgn * (d.w / 2 - 1.2);
          const gz = W.terrain(px, py), hgt = z - 1.2 - gz + 1;
          if (hgt < 0.5) continue;
          const pil = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.7, 0.8, hgt, 10)), concrete);
          pil.position.set(d.L * t, -1.2 - hgt / 2 + 0.5, sgn * (d.w / 2 - 1.2)); grp.add(pil);
        }
      }
      grp.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.scene.add(grp);
    }
  }

  // ---------------- Leitplanken an den Brückendämmen ----------------
  buildRails() {
    const W = this.game.world, m = this.mat({ color: '#d0d3d6' }), post = this.mat({ color: '#8a8d90' });
    for (const r of W.rails) {
      const L = Math.hypot(r.bx - r.ax, r.by - r.ay); if (L < 1) continue;
      const g = new THREE.Mesh(this.track(new THREE.BoxGeometry(L, 0.35, 0.18)), m);
      g.position.set((r.ax + r.bx) / 2, (r.az + r.bz) / 2 + 0.8, (r.ay + r.by) / 2);
      g.rotation.order = 'YZX'; g.rotation.y = -Math.atan2(r.by - r.ay, r.bx - r.ax); g.rotation.z = Math.atan2(r.bz - r.az, L);
      g.castShadow = true; this.scene.add(g);
      for (let d = 0; d <= L; d += 4) {
        const t = d / L, p = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.15, 0.9, 0.15)), post);
        p.position.set(r.ax + (r.bx - r.ax) * t, r.az + (r.bz - r.az) * t + 0.45, r.ay + (r.by - r.ay) * t); this.scene.add(p);
      }
    }
  }

  // ---------------- Tunnel: Röhre mit Licht und Portalen ----------------
  buildTunnels() {
    const W = this.game.world, T = this.makeTextures();
    const wallM = this.mat({ color: '#8f8a80', emissive: '#2e2b26', side: THREE.DoubleSide });
    const ceilM = this.mat({ color: '#6c6862', emissive: '#1e1c19', side: THREE.DoubleSide });
    const roadM = this.mat({ map: T.asphalt, emissive: '#1a1a1a' });
    const lampM = this.mat({ color: '#fff3c4', emissive: '#ffe08a' });
    const rockM = this.mat({ color: '#6f6a5c' });
    for (const tn of W.tunnels) {
      const wall = [], ceil = [], road = [], ruv = [];
      const hw = tn.w / 2, H = tn.hgt;
      let acc = 0;
      for (const sg of tn.segs) {
        const ux = (sg.bx - sg.ax) / sg.L, uy = (sg.by - sg.ay) / sg.L, nx = -uy * hw, ny = ux * hw;
        const A = [sg.ax, sg.az, sg.ay], B = [sg.bx, sg.bz, sg.by];
        const P = (pt, s, h) => [pt[0] + nx * s, pt[1] + h, pt[2] + ny * s];
        for (const s of [1, -1]) {
          const a0 = P(A, s, 0), b0 = P(B, s, 0), a1 = P(A, s, H), b1 = P(B, s, H);
          wall.push(...a0, ...b0, ...b1, ...a0, ...b1, ...a1);
        }
        const l0 = P(A, 1, H), r0 = P(A, -1, H), l1 = P(B, 1, H), r1 = P(B, -1, H);
        ceil.push(...l0, ...l1, ...r1, ...l0, ...r1, ...r0);
        const fl0 = P(A, 0.86, 0.06), fr0 = P(A, -0.86, 0.06), fl1 = P(B, 0.86, 0.06), fr1 = P(B, -0.86, 0.06);
        road.push(...fl0, ...fr0, ...fr1, ...fl0, ...fr1, ...fl1);
        const u0 = acc / 8, u1 = (acc + sg.L) / 8; acc += sg.L;
        ruv.push(u0, 1, u0, 0, u1, 0, u0, 1, u1, 0, u1, 1);
        // Lampen an der Decke
        for (let d = 6; d < sg.L; d += 14) {
          const lamp = new THREE.Mesh(this.track(new THREE.BoxGeometry(2.4, 0.2, 0.5)), lampM);
          lamp.position.set(sg.ax + ux * d, sg.az + (sg.bz - sg.az) * d / sg.L + H - 0.15, sg.ay + uy * d);
          lamp.rotation.y = -Math.atan2(uy, ux);
          this.scene.add(lamp);
        }
      }
      const mk = (arr, m, uvs) => {
        const g = this.track(new THREE.BufferGeometry());
        g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
        if (uvs) g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        g.computeVertexNormals();
        const mesh = new THREE.Mesh(g, m); mesh.receiveShadow = true; this.scene.add(mesh); return mesh;
      };
      mk(wall, wallM); mk(ceil, ceilM).castShadow = true; mk(road, roadM, ruv);
      // Portale: Betonrahmen und Stützmauer bis zum Hang
      const ends = [[tn.segs[0].ax, tn.segs[0].ay, tn.segs[0].az, tn.segs[0]], [tn.segs[tn.segs.length - 1].bx, tn.segs[tn.segs.length - 1].by, tn.segs[tn.segs.length - 1].bz, tn.segs[tn.segs.length - 1]]];
      for (const [x, y, z, sg] of ends) {
        const ang = Math.atan2(sg.by - sg.ay, sg.bx - sg.ax);
        const grp = new THREE.Group(); grp.position.set(x, z, y); grp.rotation.y = -ang;
        const top = Math.max(H + 2, W.terrain(x, y) - z + 2, 12);
        const lintel = new THREE.Mesh(this.track(new THREE.BoxGeometry(1.6, top - H, tn.w + 3)), rockM); lintel.position.set(0, H + (top - H) / 2, 0); grp.add(lintel);
        for (const sgn of [1, -1]) {
          const side = new THREE.Mesh(this.track(new THREE.BoxGeometry(1.6, top, 9)), rockM); side.position.set(0, top / 2, sgn * (hw + 4.5)); grp.add(side);
        }
        const frame = new THREE.Mesh(this.track(new THREE.BoxGeometry(1.8, 1.2, tn.w + 1)), this.mat({ color: '#d8d2c4' })); frame.position.set(0, H + 0.4, 0); grp.add(frame);
        grp.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        this.scene.add(grp);
      }
    }
  }

  // ---------------- Wahrzeichen (einfache, erkennbare Formen) ----------------
  buildLandmarks() {
    const W = this.game.world;
    const M = c => this.mat({ color: c });
    const white = M('#f4f0e6'), cream = M('#ece0c4'), sand = M('#e2d2ae'), copper = M('#5f9e8a'), roofRed = M('#9a4a36'), roofDark = M('#6b5248'), stone = M('#a59d8c');
    const box = (g, w, h, d, m, x, y, z) => { const o = new THREE.Mesh(this.track(new THREE.BoxGeometry(w, h, d)), m); o.position.set(x, y + h / 2, z); g.add(o); return o; };
    const cyl = (g, r1, r2, h, seg, m, x, y, z) => { const o = new THREE.Mesh(this.track(new THREE.CylinderGeometry(r1, r2, h, seg)), m); o.position.set(x, y + h / 2, z); g.add(o); return o; };
    const dome = (g, r, m, x, y, z, sy = 1) => { const o = new THREE.Mesh(this.track(new THREE.SphereGeometry(r, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2)), m); o.position.set(x, y, z); o.scale.y = sy; g.add(o); return o; };
    const prism = (g, L, w, h, m, x, y, z) => {   // Satteldach entlang x
      const geo = this.track(new THREE.BufferGeometry());
      const a = L / 2, b = w / 2;
      const v = [-a, 0, -b, a, 0, -b, a, h, 0, -a, 0, -b, a, h, 0, -a, h, 0, -a, 0, b, -a, h, 0, a, h, 0, -a, 0, b, a, h, 0, a, 0, b, -a, 0, -b, -a, h, 0, -a, 0, b, a, 0, -b, a, 0, b, a, h, 0];
      geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); geo.computeVertexNormals();
      const o = new THREE.Mesh(geo, m); o.material.side = THREE.DoubleSide; o.position.set(x, y, z); g.add(o); return o;
    };
    for (const lm of W.landmarks) {
      const g = new THREE.Group();
      g.position.set(lm.x, W.terrain(lm.x, lm.y) - 0.5, lm.y); g.rotation.y = -lm.a;
      if (lm.t === 'basilika') {
        // Basilika St. Martin: weiße Barockfassade, Doppeltürme, Kuppel über der Vierung
        box(g, 100, 24.5, 26, white, 0, 0, 0); prism(g, 100, 26, 9, roofDark, 0, 24.5, 0);
        box(g, 24, 24.5, 46, white, 12, 0, 0);
        const tr = prism(g, 46, 24, 8.5, roofDark, 12, 24.5, 0); tr.rotation.y = Math.PI / 2;
        cyl(g, 8.5, 8.5, 9, 16, white, 12, 26, 0); dome(g, 8.6, copper, 12, 35, 0, 1.15);
        cyl(g, 1.8, 1.8, 4, 8, white, 12, 44.5, 0); cyl(g, 0, 1.9, 3, 8, copper, 12, 48.5, 0);
        for (const zz of [-14, 14]) {
          box(g, 11, 44, 11, white, -46, 0, zz); box(g, 9, 7, 9, cream, -46, 44, zz);
          dome(g, 4.8, copper, -46, 51, zz, 1.4); cyl(g, 0.9, 0.9, 3, 8, copper, -46, 57.5, zz); cyl(g, 0, 1.1, 2.5, 8, copper, -46, 60.5, zz);
        }
        box(g, 2, 30, 18, cream, -51, 0, 0);             // Fassade zwischen den Türmen
        const ped = prism(g, 18, 2.5, 6, cream, -51, 30, 0); ped.rotation.y = Math.PI / 2;
      } else if (lm.t === 'blaserturm') {
        // Blaserturm am Marienplatz: Quaderschaft, achteckiger Aufsatz, grüne Haube
        box(g, 8, 36, 8, sand, 0, 0, 0); box(g, 8.6, 1, 8.6, stone, 0, 36, 0);
        cyl(g, 4.2, 4.4, 8, 8, white, 0, 37, 0); dome(g, 4.2, copper, 0, 45, 0, 1.3);
        cyl(g, 0.8, 0.8, 2.5, 8, copper, 0, 50.4, 0); cyl(g, 0, 0.9, 2.2, 8, copper, 0, 52.9, 0);
      } else if (lm.t === 'mehlsack') {
        // Mehlsack: weißer Rundturm
        cyl(g, 6.0, 6.3, 46, 18, white, 0, 0, 0); cyl(g, 6.5, 6.5, 1, 18, stone, 0, 46, 0); cyl(g, 0, 6.6, 5, 18, roofDark, 0, 47, 0);
        for (let k = 0; k < 4; k++) { const sl = box(g, 0.6, 2.2, 1.0, roofDark, Math.cos(k * 1.57) * 6.05, 30 + (k % 2) * 6, Math.sin(k * 1.57) * 6.05); sl.rotation.y = -k * 1.57; }
      } else if (lm.t === 'veitsburg') {
        // Veitsburg: Schlösschen mit Turm auf dem Hügel
        box(g, 30, 13, 13, cream, 0, 0, 0); prism(g, 30, 13, 6, roofRed, 0, 13, 0);
        box(g, 7, 24, 7, cream, -11, 0, -4); cyl(g, 0, 5.4, 6, 4, roofRed, -11, 24, -4).rotation.y = Math.PI / 4;
        for (const [x, z, w, d] of [[0, 16, 44, 1.2], [0, -16, 44, 1.2], [22, 0, 1.2, 32], [-22, 0, 1.2, 32]]) box(g, w, 3, d, stone, x, -1, z);
      }
      g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.scene.add(g);
    }
  }
  convex(p) {
    const n = p.length / 2; let sign = 0;
    for (let i = 0; i < n; i++) {
      const a = i * 2, b = ((i + 1) % n) * 2, c = ((i + 2) % n) * 2;
      const cr = (p[b] - p[a]) * (p[c + 1] - p[b + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[b]);
      if (Math.abs(cr) < 1e-6) continue;
      const s = Math.sign(cr);
      if (sign && s !== sign) return false;
      sign = s;
    }
    return true;
  }

  // ---------------- Bäume ----------------
  buildTrees() {
    const T = this.game.world.trees, Wt = this.game.world;
    if (!T.length) return;
    const trunk = new THREE.InstancedMesh(this.track(new THREE.CylinderGeometry(0.22, 0.32, 1, 6)), this.mat({ color: '#5b4630' }), T.length);
    const crown = new THREE.InstancedMesh(this.track(new THREE.IcosahedronGeometry(1, 1)), this.mat({ color: '#ffffff', flatShading: true }), T.length);
    const shades = ['#3f7a35', '#4b8a3a', '#36702f'];
    const d = this.dummy;
    T.forEach((t, i) => {
      const gz = Wt.terrain(t.x, t.y);
      d.position.set(t.x, gz + t.h * 0.3, t.y); d.rotation.set(0, 0, 0); d.scale.set(1, t.h * 0.6, 1); d.updateMatrix();
      trunk.setMatrixAt(i, d.matrix);
      d.position.set(t.x, gz + t.h * 0.68, t.y); d.rotation.set(0, i, 0); d.scale.set(t.r, t.r * 1.15, t.r); d.updateMatrix();
      crown.setMatrixAt(i, d.matrix);
      crown.setColorAt(i, R3.col(shades[t.hue]));
    });
    for (const m of [trunk, crown]) { m.castShadow = true; m.receiveShadow = true; this.scene.add(m); }
  }

  // ---------------- Rampen, Basen, Kisten ----------------
  buildStatic() {
    const W = this.game.world;
    // Rampen als Keil mit Warnstreifen
    const sc = document.createElement('canvas'); sc.width = 128; sc.height = 64;
    const sg = sc.getContext('2d');
    sg.fillStyle = '#e9b93a'; sg.fillRect(0, 0, 128, 64);
    sg.fillStyle = '#222'; for (let i = -64; i < 128; i += 32) { sg.beginPath(); sg.moveTo(i, 64); sg.lineTo(i + 16, 64); sg.lineTo(i + 80, 0); sg.lineTo(i + 64, 0); sg.fill(); }
    const rampTex = this.track(new THREE.CanvasTexture(sc));
    const rampMat = this.mat({ map: rampTex });
    const sideMat = this.mat({ color: '#5a4a32' });
    for (const r of W.ramps) {
      const L = r.len, Wd = r.wid, H = r.big ? 2.2 : 1.5;
      const g = this.track(new THREE.BufferGeometry());
      const v = [
        -L / 2, 0, -Wd / 2, L / 2, H, -Wd / 2, L / 2, H, Wd / 2, -L / 2, 0, -Wd / 2, L / 2, H, Wd / 2, -L / 2, 0, Wd / 2, // Schräge
        L / 2, 0, -Wd / 2, L / 2, H, -Wd / 2, L / 2, H, Wd / 2, L / 2, 0, -Wd / 2, L / 2, H, Wd / 2, L / 2, 0, Wd / 2, // Rückwand
        -L / 2, 0, -Wd / 2, L / 2, 0, -Wd / 2, L / 2, H, -Wd / 2, -L / 2, 0, Wd / 2, L / 2, H, Wd / 2, L / 2, 0, Wd / 2, // Seiten
      ];
      const uv = [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
      g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.addGroup(0, 6, 0); g.addGroup(6, 12, 1);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, [Object.assign(rampMat, { side: THREE.DoubleSide }), Object.assign(sideMat, { side: THREE.DoubleSide })]);
      m.position.set(r.x, W.terrain(r.x, r.y) - 0.05, r.y); m.rotation.y = -r.a;
      m.castShadow = true; m.receiveShadow = true;
      this.scene.add(m);
    }
    // Basen: leuchtende Ringe
    W.bases.forEach((b, i) => {
      const ring = new THREE.Mesh(this.track(new THREE.RingGeometry(10.2, 11.2, 48)), this.track(new THREE.MeshBasicMaterial({ color: TEAM[i].color, transparent: true, opacity: 0.85, side: THREE.DoubleSide })));
      const bz = W.terrain(b.x, b.y);
      ring.rotation.x = -Math.PI / 2; ring.position.set(b.x, bz + 0.12, b.y);
      this.scene.add(ring);
      const glow = new THREE.Mesh(this.track(new THREE.CylinderGeometry(11, 11, 3, 48, 1, true)), this.track(new THREE.MeshBasicMaterial({ color: TEAM[i].color, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false })));
      glow.position.set(b.x, bz + 1.5, b.y);
      this.scene.add(glow);
    });
    // Kisten
    const boxG = this.track(new THREE.BoxGeometry(1, 1, 1));
    const propMats = PROP.map(pr => this.mat({ color: pr.top }));
    this.props = this.game.props.map(p => {
      const m = new THREE.Mesh(boxG, propMats[p.t]);
      m.scale.set(p.hw * 2, p.h, p.hh * 2);
      m.position.set(p.x, p.z + p.h / 2, p.y); m.rotation.y = -p.a;
      m.castShadow = true; m.receiveShadow = true;
      this.scene.add(m);
      return m;
    });
  }

  // ---------------- Geschosse, Partikel, Pickups, Flaggen ----------------
  buildDynamic() {
    const s = this.scene;
    // Geschosse
    this.bulletMesh = new THREE.InstancedMesh(this.track(new THREE.BoxGeometry(1, 1, 1)), this.track(new THREE.MeshBasicMaterial({ color: '#ffffff' })), 600);
    this.bulletMesh.frustumCulled = false; this.bulletMesh.count = 0;
    s.add(this.bulletMesh);
    // Partikel (normal + leuchtend)
    const mkPoints = additive => {
      const N = 1700;
      const g = this.track(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
      g.setAttribute('pcolor', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
      g.setAttribute('psize', new THREE.BufferAttribute(new Float32Array(N), 1));
      g.setAttribute('palpha', new THREE.BufferAttribute(new Float32Array(N), 1));
      const m = this.track(new THREE.ShaderMaterial({
        uniforms: { scale: { value: 600 } },
        vertexShader: 'attribute vec3 pcolor; attribute float psize; attribute float palpha; uniform float scale; varying vec3 vC; varying float vA;' +
          'void main(){ vC=pcolor; vA=palpha; vec4 mv=modelViewMatrix*vec4(position,1.0); gl_PointSize=max(1.0, psize*scale/-mv.z); gl_Position=projectionMatrix*mv; }',
        fragmentShader: 'varying vec3 vC; varying float vA; void main(){ vec2 c=gl_PointCoord-0.5; float d=length(c); if(d>0.5) discard; gl_FragColor=vec4(vC, vA*smoothstep(0.5,0.25,d)); }',
        transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      }));
      const pts = new THREE.Points(g, m);
      pts.frustumCulled = false;
      s.add(pts);
      return pts;
    };
    this.pNormal = mkPoints(false); this.pAdd = mkPoints(true);
    // Pickups & Minen (Pools)
    this.pool = { pick: [], mine: [] };
    this.pickMats = [this.mat({ color: '#ffffff', emissive: '#552222' }), this.mat({ color: '#2a8de0', emissive: '#0a3060' }), this.mat({ color: '#f5c518', emissive: '#5a4300' })];
    this.pickGeo = [this.track(new THREE.BoxGeometry(1.6, 1.6, 1.6)), this.track(new THREE.CylinderGeometry(0.7, 0.7, 1.8, 14)), this.track(new THREE.CylinderGeometry(1, 1, 0.3, 20))];
    this.crossMat = this.mat({ color: '#e8423a', emissive: '#5a1010' });
    this.mineGeo = this.track(new THREE.CylinderGeometry(0.75, 0.85, 0.3, 12));
    this.mineMat = this.mat({ color: '#333' });
    this.mineLight = this.track(new THREE.SphereGeometry(0.25, 8, 6));
    // Flaggen
    this.flags = this.game.flags.map(f => {
      const grp = new THREE.Group();
      const pole = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.12, 0.12, 6.5, 8)), this.mat({ color: '#e8e8e8' }));
      pole.position.y = 3.25; grp.add(pole);
      const cloth = new THREE.Mesh(this.track(new THREE.PlaneGeometry(3.2, 2, 6, 1)), this.mat({ color: TEAM[f.team].color, emissive: TEAM[f.team].dark, side: THREE.DoubleSide }));
      cloth.geometry.translate(1.6, 0, 0);
      cloth.position.y = 5.4; grp.add(cloth);
      const knob = new THREE.Mesh(this.track(new THREE.SphereGeometry(0.25, 10, 8)), this.mat({ color: '#ffe66d', emissive: '#665500' }));
      knob.position.y = 6.6; grp.add(knob);
      pole.castShadow = cloth.castShadow = true;
      grp.userData.cloth = cloth;
      this.scene.add(grp);
      return grp;
    });
  }

  // ---------------- Autos ----------------
  makeCar(c) {
    const def = c.def, tm = TEAM[c.team], L = def.len, Wd = def.wid, H = CAR_H[def.shape] || 1.4;
    const root = new THREE.Group();
    const body = new THREE.Group(); root.add(body);
    const paint = this.mat({ color: tm.color, specular: '#ffffff', shininess: 70 }, 'Phong');
    const dark = this.mat({ color: tm.dark, specular: '#333333', shininess: 30 }, 'Phong');
    const black = this.mat({ color: '#171717' });
    const glass = this.mat({ color: '#1c2a3a', specular: '#9fc7ff', shininess: 100 }, 'Phong');
    const metal = this.mat({ color: '#3a3f45', specular: '#888888', shininess: 50 }, 'Phong');
    const box = (w, h, d, m, x, y, z) => { const o = new THREE.Mesh(this.track(roundBox(w, h, d, Math.min(0.14, w * 0.3, h * 0.3, d * 0.3))), m); o.position.set(x, y, z); o.castShadow = true; body.add(o); return o; };
    const wheel = (r, w, x, z) => {
      const o = new THREE.Mesh(this.track(new THREE.CylinderGeometry(r, r, w, 14)), black);
      o.rotation.x = Math.PI / 2; o.position.set(x, r, z); o.castShadow = true; body.add(o); return o;
    };
    let faceY = H + 0.02, faceX = c.shape.face;
    switch (def.shape) {
      case 'sport':
        for (const [x, z] of [[1.35, 1], [1.35, -1], [-1.35, 1], [-1.35, -1]]) wheel(0.38, 0.4, x, z);
        box(L, 0.55, Wd, paint, 0, 0.6, 0);
        box(L * 0.45, 0.42, Wd * 0.82, glass, -0.1, 1.05, 0);
        box(0.3, 0.12, Wd, dark, -L / 2 + 0.15, 1.05, 0);
        box(L * 0.9, 0.02, 0.18, this.mat({ color: '#ffffff' }), 0, 0.885, 0.2); box(L * 0.9, 0.02, 0.18, this.mat({ color: '#ffffff' }), 0, 0.885, -0.2);
        faceY = 1.27; faceX = -0.1;
        break;
      case 'buggy':
        for (const [x, z] of [[1.25, 1.05], [1.25, -1.05]]) wheel(0.48, 0.55, x, z);
        for (const [x, z] of [[-1.2, 1.1], [-1.2, -1.1]]) wheel(0.58, 0.65, x, z);
        box(L * 0.9, 0.35, 1.5, dark, 0, 0.55, 0);
        box(L * 0.55, 0.3, 1.7, paint, 0.6, 0.8, 0);
        for (const z of [-0.75, 0.75]) { box(0.1, 0.9, 0.1, metal, -0.6, 1.25, z); box(0.1, 0.9, 0.1, metal, 0.6, 1.25, z); box(1.3, 0.1, 0.1, metal, 0, 1.7, z); }
        faceY = 1.12; faceX = 0.1;
        break;
      case 'tank':
        box(L, 0.75, 0.75, black, 0, 0.42, Wd / 2 - 0.38); box(L, 0.75, 0.75, black, 0, 0.42, -Wd / 2 + 0.38);
        box(L - 0.3, 0.6, Wd - 1.2, dark, 0, 0.75, 0);
        box(L - 0.5, 0.3, Wd - 0.5, paint, 0, 1.05, 0);
        faceY = 1.22; faceX = 1.6;
        break;
      case 'jeep':
        for (const [x, z] of [[1.45, 1.05], [1.45, -1.05], [-1.45, 1.05], [-1.45, -1.05]]) wheel(0.45, 0.45, x, z);
        box(L, 0.55, Wd, dark, 0, 0.65, 0);
        box(L * 0.42, 0.6, Wd - 0.15, paint, L * 0.25, 1.2, 0);
        box(0.1, 0.45, Wd - 0.4, glass, L * 0.25 + L * 0.21, 1.2, 0);
        box(L * 0.45, 0.3, 0.15, paint, -L * 0.25, 1.05, Wd / 2 - 0.08); box(L * 0.45, 0.3, 0.15, paint, -L * 0.25, 1.05, -Wd / 2 + 0.08);
        faceY = 1.52; faceX = L * 0.22;
        break;
      case 'truck':
        for (const [x, z] of [[1.5, 1.15], [1.5, -1.15], [-1.5, 1.15], [-1.5, -1.15]]) wheel(0.65, 0.6, x, z);
        box(L - 0.2, 0.7, Wd - 0.3, dark, 0, 1.05, 0);
        box(L * 0.6, 0.6, Wd - 0.5, paint, 0.3, 1.7, 0);
        box(0.08, 0.45, Wd - 0.7, glass, 0.3 + L * 0.3, 1.7, 0);
        for (const z of [-0.5, 0, 0.5]) box(0.15, 0.15, 0.15, this.mat({ color: '#ffe9a0', emissive: '#aa9a40' }), 0.3 + L * 0.3 - 0.4, 2.05, z);
        faceY = 2.02; faceX = 0.2;
        break;
    }
    // Fahrer-Gesicht durchs Schiebedach (immer nach Norden ausgerichtet)
    const fr = c.shape.faceR * 0.95;
    const faceG = this.track(new THREE.CircleGeometry(fr, 24)); faceG.rotateX(-Math.PI / 2);
    const face = new THREE.Mesh(faceG, this.track(new THREE.MeshBasicMaterial({ map: R3.face(c.driver.id, c.name) })));
    face.position.set(faceX, faceY, 0);
    root.add(face);
    const ring = new THREE.Mesh(this.track(new THREE.RingGeometry(fr, fr + 0.12, 24)), this.track(new THREE.MeshBasicMaterial({ color: tm.light, side: THREE.DoubleSide })));
    ring.rotation.x = -Math.PI / 2; ring.position.set(faceX, faceY + 0.005, 0); root.add(ring);
    // Turm
    const turret = new THREE.Group(); turret.position.set(c.shape.turret, H + 0.05, 0); root.add(turret);
    const tb = (w, h, d, m, x, y, z) => { const o = new THREE.Mesh(this.track(new THREE.BoxGeometry(w, h, d)), m); o.position.set(x, y, z); o.castShadow = true; turret.add(o); return o; };
    const barrel = (r, l, m, x, y, z) => { const o = new THREE.Mesh(this.track(new THREE.CylinderGeometry(r, r, l, 8)), m); o.rotation.z = Math.PI / 2; o.position.set(x + l / 2, y, z); o.castShadow = true; turret.add(o); return o; };
    switch (def.weapon) {
      case 'mg': tb(0.9, 0.35, 0.9, metal, 0, 0.15, 0); barrel(0.08, 1.8, black, 0.2, 0.2, 0.2); barrel(0.08, 1.8, black, 0.2, 0.2, -0.2); break;
      case 'minigun': tb(0.9, 0.5, 0.9, metal, 0, 0.25, 0); for (const [y, z] of [[0.3, 0.12], [0.3, -0.12], [0.45, 0], [0.15, 0]]) barrel(0.06, 1.8, black, 0.3, y, z); break;
      case 'cannon': tb(2, 0.7, 1.7, metal, 0, 0.35, 0); barrel(0.2, 2.8, black, 0.8, 0.4, 0); tb(0.4, 0.15, 0.4, paint, -0.3, 0.75, 0); break;
      case 'rocket': tb(1.4, 0.9, 1.4, metal, 0, 0.45, 0); for (const [y, z] of [[0.3, 0.3], [0.3, -0.3], [0.65, 0.3], [0.65, -0.3]]) barrel(0.14, 0.5, this.mat({ color: '#ff7b39' }), 0.55, y, z); break;
      case 'shotgun': tb(1, 0.5, 1, metal, 0, 0.25, 0); barrel(0.22, 1.5, black, 0.2, 0.3, 0); break;
    }
    // Geister-Umriss für den Spieler (sichtbar durch Häuser)
    if (c.isPlayer) {
      const ghost = new THREE.Mesh(this.track(new THREE.BoxGeometry(L, H, Wd)), this.track(new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.22, depthTest: false, depthWrite: false })));
      ghost.position.y = H / 2; ghost.renderOrder = 999; root.add(ghost);
    }
    // Flagge, wenn getragen
    const fl = new THREE.Group();
    const pole = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.08, 0.08, 3.5, 6)), this.mat({ color: '#eee' })); pole.position.y = 1.75; fl.add(pole);
    const cloth = new THREE.Mesh(this.track(new THREE.PlaneGeometry(2, 1.3)), this.mat({ color: '#fff', side: THREE.DoubleSide }));
    cloth.geometry.translate(1, 0, 0); cloth.position.y = 2.9; fl.add(cloth);
    fl.position.set(-L / 2 + 0.3, H, 0); fl.visible = false; root.add(fl);
    root.traverse(o => { if (o.isMesh) o.receiveShadow = true; });
    // Drehpunkt in der Wagenmitte: Saltos und Hangneigung drehen um den Schwerpunkt statt um die Räder
    const spin = new THREE.Group(), inner = new THREE.Group();
    spin.position.y = H * 0.5; inner.position.y = -H * 0.5;
    for (const ch of [...root.children]) inner.add(ch);
    spin.add(inner); root.add(spin);
    this.scene.add(root);
    return { root, spin, turret, face, ring, flag: fl, flagCloth: cloth, paint, flashOn: false, lastFlag: -2 };
  }

  // ---------------- Kamera / Projektion ----------------
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, this.dprCap || 2);
    this.gl.setPixelRatio(dpr);
    this.gl.setSize(innerWidth, innerHeight, false);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.updatePointScale();
  }
  updatePointScale() {
    const h = innerHeight * Math.min(window.devicePixelRatio || 1, this.dprCap || 2);
    this.pNormal.material.uniforms.scale.value = this.pAdd.material.uniforms.scale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
  }
  placeCamera(cx, cy, cz, dt) {
    const G = this.game, cam = this.camera;
    if (G.camMode === 'chase') {
      // Drohne: knapp hinter und über dem Auto, steigt über Häuser im Weg
      const yaw = G.camYaw, fx = Math.cos(yaw), fy = Math.sin(yaw);
      const back = 12.5 / G.zoomMul, up = 5.2 / G.zoomMul;
      const Wd = G.world;
      let need = cz + up;
      // im Tunnel / unter einer Brücke: unter der Decke bleiben und näher ran
      const inTun = Wd.tunnelAt(cx, cy), under = Wd.ceilingAt(cx, cy, cz);
      let bk = back;
      if (inTun && cz < inTun.ceil - 0.5) bk = Math.min(back, 8);
      for (let s = 0.2; s <= 1.001; s += 0.2) {
        const sx2 = cx - fx * bk * s, sy2 = cy - fy * bk * s;
        const b = Wd.buildingAt(sx2, sy2);
        if (b) need = Math.max(need, b.top + (b.flat ? 2.5 : 6));
        const tnS = Wd.tunnelAt(sx2, sy2);
        if (!(inTun && tnS)) need = Math.max(need, Wd.terrain(sx2, sy2) + 2.5);
      }
      if (inTun && cz < inTun.ceil - 0.5) need = Math.min(need, inTun.ceil - 0.8);
      else if (under !== null) need = Math.min(need, under - 0.6);
      this.camH = this.camH == null ? need : this.camH + (need - this.camH) * Math.min(1, (dt || 0.016) * (need > this.camH ? 6 : 2.5));
      cam.position.set(cx - fx * bk, this.camH, cy - fy * bk);
      cam.lookAt(cx + fx * 10, cz + 1.4, cy + fy * 10);
      if (cam.fov !== 68) { cam.fov = 68; cam.updateProjectionMatrix(); this.updatePointScale(); }
      cam.updateMatrixWorld();
      const ax = cx + fx * 45, ay = cy + fy * 45;
      this.sun.position.set(ax - 85, cz + 150, ay + 55);
      this.sun.target.position.set(ax, cz, ay);
      this.sun.target.updateMatrixWorld();
      return;
    }
    this.camH = null;
    const fov = innerWidth < innerHeight ? 58 : 42;
    if (cam.fov !== fov) { cam.fov = fov; cam.updateProjectionMatrix(); this.updatePointScale(); }
    const d = this.camDist / this.game.zoomMul;
    cam.position.set(cx, cz + d * Math.sin(this.pitch), cy + d * Math.cos(this.pitch));
    cam.lookAt(cx, cz, cy);
    cam.updateMatrixWorld();
    this.sun.position.set(cx - 85, cz + 150, cy + 55);
    this.sun.target.position.set(cx, cz, cy);
    this.sun.target.updateMatrixWorld();
  }
  project(x, y, z) {
    const v = this.tmpV.set(x, z, y).project(this.camera);
    const cv = this.game.canvas;
    return { x: (v.x + 1) / 2 * cv.width, y: (1 - v.y) / 2 * cv.height, behind: v.z > 1 };
  }
  // Bildschirmpunkt (CSS-Pixel) -> Punkt auf einer waagrechten Ebene in Höhe h
  screenToGround(sx, sy, h = 0) {
    const ndc = new THREE.Vector2(sx / innerWidth * 2 - 1, -(sy / innerHeight) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const o = this.ray.ray.origin, d = this.ray.ray.direction;
    // über dem Horizont: in Blickrichtung weit nach vorne
    if (d.y > -0.02) { const l = Math.hypot(d.x, d.z) || 1; return { x: o.x + d.x / l * 150, y: o.z + d.z / l * 150 }; }
    let t = (h - o.y) / d.y;
    const hor = Math.hypot(d.x * t, d.z * t);
    if (hor > 150) t *= 150 / hor;
    return { x: o.x + d.x * t, y: o.z + d.z * t };
  }

  // ---------------- Bild zeichnen ----------------
  render(dt, time) {
    const G = this.game;
    // Bildrate im Blick: bei dauerhaft < 40 FPS die Auflösung stufenweise senken
    this.slowT = Math.max(0, (this.slowT || 0) + (dt > 1 / 40 ? dt : -dt * 0.5));
    if (this.slowT > 2.5 && (this.dprCap || 2) > 1 && (window.devicePixelRatio || 1) > 1) { this.dprCap = Math.max(1, (this.dprCap || 2) - 0.25); this.slowT = 0; this.resize(); }
    const sx = (Math.random() - 0.5) * G.shake * 0.9, sy = (Math.random() - 0.5) * G.shake * 0.9;
    const pz = G.player && G.player.alive ? G.player.z : G.world.terrain(G.cam.x, G.cam.y);
    this.placeCamera(G.cam.x + sx * (G.camMode === 'chase' ? 0.3 : 1), G.cam.y + sy * (G.camMode === 'chase' ? 0.3 : 1), G.camMode === 'chase' && G.player ? G.player.z : pz, dt);
    // sichtbarer Bereich (für Minikarte)
    const pts = [[0, 0], [innerWidth, 0], [0, innerHeight], [innerWidth, innerHeight]].map(([x, y]) => this.screenToGround(x, y));
    G.viewRect = { x0: Math.min(...pts.map(p => p.x)), y0: Math.min(...pts.map(p => p.y)), x1: Math.max(...pts.map(p => p.x)), y1: Math.max(...pts.map(p => p.y)) };
    // Bodentexturen mit Reifenspuren nachladen
    const now = performance.now();
    if (this.dirty.size && now - this.lastUpload > 350) {
      for (const k of this.dirty) { const t = this.groundTex.get(k); if (t) t.needsUpdate = true; }
      this.dirty.clear(); this.lastUpload = now;
    }
    // Autos
    for (const c of G.cars) {
      let m = this.cars.get(c);
      if (!m) { m = this.makeCar(c); this.cars.set(c, m); }
      const vis = c.alive && !(c.protect > 0 && Math.sin(time * 20) < -0.3);
      m.root.visible = vis;
      if (!c.alive) continue;
      m.root.position.set(c.x, c.z, c.y);
      m.root.rotation.order = 'YZX';
      m.root.rotation.y = -c.a;
      // am Hang kippen (Nicken + Rollen), in der Luft leicht nach Flugbahn
      const ca = Math.cos(c.a), sa = Math.sin(c.a), sxs = c.slopeX || 0, sys = c.slopeY || 0;
      const air = c.onGround === false || Math.abs(c.pitch || 0) > 0.05;
      const roll = air ? 0 : -Math.atan(-sxs * sa + sys * ca);
      if (air && Math.abs(c.pitch || 0) > 0.05) m.pitch = clamp(c.vz * 0.02, -0.3, 0.3) + c.pitch;   // Salto: direkt folgen
      else {
        const pitch = air ? clamp(c.vz * 0.02, -0.3, 0.3) : Math.atan(sxs * ca + sys * sa);
        m.pitch = angNorm(m.pitch || 0); m.pitch += (pitch - m.pitch) * 0.25;
      }
      m.roll = (m.roll || 0) + (roll - (m.roll || 0)) * 0.25;
      m.spin.rotation.order = 'XZY'; m.spin.rotation.z = m.pitch; m.spin.rotation.x = m.roll;
      m.turret.rotation.y = -(c.turret - c.a);
      // Gesicht immer „aufrecht“ zur Kamera
      m.face.rotation.y = c.a - Math.PI / 2 - (G.camMode === 'chase' ? G.camYaw : -Math.PI / 2);
      const flash = c.flashT > 0;
      if (flash !== m.flashOn) { m.paint.emissive.set(flash ? '#ffffff' : '#000000'); m.flashOn = flash; }
      if (c.flag !== m.lastFlag) {
        m.flag.visible = c.flag >= 0;
        if (c.flag >= 0) m.flagCloth.material.color.set(TEAM[c.flag].color);
        m.lastFlag = c.flag;
      }
      if (c.flag >= 0) m.flagCloth.rotation.y = Math.sin(time * 9) * 0.35 + 0.2;
    }
    // Flaggen am Boden
    this.game.flags.forEach((f, i) => {
      const grp = this.flags[i];
      grp.visible = f.state !== 'carried';
      if (!grp.visible) return;
      grp.position.set(f.x, f.z !== undefined ? f.z : G.world.terrain(f.x, f.y), f.y);
      grp.userData.cloth.rotation.y = Math.sin(time * 4 + i) * 0.4;
      grp.scale.setScalar(f.state === 'dropped' ? 0.8 + Math.sin(time * 8) * 0.06 : 1);
    });
    // Kisten
    G.props.forEach((p, i) => { this.props[i].visible = p.alive; });
    // Pickups
    let n = 0;
    for (const p of G.pickups) {
      if (!p.active) continue;
      let o = this.pool.pick[n];
      if (!o) { o = new THREE.Group(); o.userData.meshes = this.pickGeo.map((g, k) => { const mm = new THREE.Mesh(g, this.pickMats[k]); mm.castShadow = true; o.add(mm); return mm; }); const cr = new THREE.Mesh(this.track(new THREE.BoxGeometry(1.7, 0.4, 1.7 * 0.3)), this.crossMat); const cr2 = cr.clone(); cr2.rotation.y = Math.PI / 2; o.userData.cross = [cr, cr2]; o.add(cr, cr2); this.scene.add(o); this.pool.pick[n] = o; }
      o.visible = true;
      o.userData.meshes.forEach((mm, k) => { mm.visible = k === p.t; });
      o.userData.cross.forEach(cr => { cr.visible = p.t === 0; });
      o.position.set(p.x, (p.z !== undefined ? p.z : G.world.terrain(p.x, p.y)) + 1.2 + Math.sin(time * 3 + p.x) * 0.25, p.y);
      o.rotation.set(p.t === 2 ? Math.PI / 2 : 0, time * 1.5, 0);
      n++;
    }
    for (let i = n; i < this.pool.pick.length; i++) this.pool.pick[i].visible = false;
    // Minen
    n = 0;
    for (const mi of G.mines) {
      let o = this.pool.mine[n];
      if (!o) { o = new THREE.Group(); o.add(new THREE.Mesh(this.mineGeo, this.mineMat)); const l = new THREE.Mesh(this.mineLight, this.track(new THREE.MeshBasicMaterial({ color: '#f00' }))); l.position.y = 0.25; o.userData.light = l; o.add(l); this.scene.add(o); this.pool.mine[n] = o; }
      o.visible = true; o.position.set(mi.x, (mi.z !== undefined ? mi.z : G.world.terrain(mi.x, mi.y)) + 0.15, mi.y);
      o.userData.light.material.color.set(mi.arm > 0 ? '#888' : (Math.sin(time * 10) > 0 ? TEAM[mi.team].color : '#222'));
      n++;
    }
    for (let i = n; i < this.pool.mine.length; i++) this.pool.mine[i].visible = false;
    // Geschosse
    const bm = this.bulletMesh, d = this.dummy;
    let bi = 0;
    for (const b of G.bullets) {
      if (bi >= 600) break;
      const ang = Math.atan2(b.vy, b.vx);
      d.position.set(b.x, b.z, b.y); d.rotation.set(0, -ang, 0);
      if (b.w === WEAPONS.rocket) d.scale.set(1.3, 0.35, 0.35);
      else if (b.w === WEAPONS.cannon) d.scale.set(0.8, 0.8, 0.8);
      else d.scale.set(2.6, 0.26, 0.26);
      d.updateMatrix();
      bm.setMatrixAt(bi, d.matrix);
      bm.setColorAt(bi, R3.col(b.w === WEAPONS.rocket ? '#ff6a2a' : b.w === WEAPONS.cannon ? '#ffb347' : b.w.color));
      bi++;
    }
    bm.count = bi; bm.instanceMatrix.needsUpdate = true; if (bm.instanceColor) bm.instanceColor.needsUpdate = true;
    // Partikel
    this.fillParticles(this.pNormal, false);
    this.fillParticles(this.pAdd, true);
    this.gl.render(this.scene, this.camera);
  }
  fillParticles(pts, add) {
    const g = pts.geometry;
    const P = g.attributes.position.array, C = g.attributes.pcolor.array, S = g.attributes.psize.array, A = g.attributes.palpha.array;
    let i = 0;
    for (const p of this.game.particles.list) {
      if (!!p.add !== add || p.type === 'text' || i >= 1700) continue;
      const f = p.life / p.max;
      const gz = p.gz !== undefined ? p.gz : (p.gz = this.game.world.terrain(p.x, p.y));
      const h = gz + (p.z !== undefined ? p.z + 0.4 : (p.type === 'spark' ? 1 : p.add ? 1.2 : 1.5));
      P[i * 3] = p.x; P[i * 3 + 1] = h; P[i * 3 + 2] = p.y;
      const c = R3.col(p.color);
      C[i * 3] = c.r; C[i * 3 + 1] = c.g; C[i * 3 + 2] = c.b;
      S[i] = p.type === 'spark' ? 0.35 : p.type === 'ring' ? p.size * 1.2 : p.type === 'debris' ? p.size * 1.2 : p.size * 2.2;
      A[i] = clamp((p.alpha || 1) * (p.fade === false ? 1 : f) * (p.type === 'ring' ? 0.25 : 1), 0, 1);
      i++;
    }
    g.setDrawRange(0, i);
    for (const k of ['position', 'pcolor', 'psize', 'palpha']) g.attributes[k].needsUpdate = true;
  }
  dispose() {
    this.game.world.onDecal = null;
    for (const x of this.disposables) { try { x.dispose(); } catch (e) { /* egal */ } }
    this.scene.clear();
  }
}
