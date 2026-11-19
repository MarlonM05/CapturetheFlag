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
      if (THREE.ACESFilmicToneMapping !== undefined) {
        this.gl.toneMapping = THREE.ACESFilmicToneMapping;
        this.gl.toneMappingExposure = 1.04;
      }
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
const CAR_H = { sport: 1.15, buggy: 1.3, tank: 1.55, jeep: 1.75, truck: 2.2 };

class Renderer3D {
  constructor(game, canvas) {
    this.game = game; this.canvas = canvas;
    this.gl = R3.renderer(canvas);
    canvas.style.display = 'block';
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#d6e5f2');
    this.scene.fog = new THREE.Fog('#d6e5f2', 145, 510);
    // Himmelskuppel: tiefes Alpenvorland-Blau oben, warmer dunstiger Horizont
    {
      const geo = new THREE.SphereGeometry(1400, 48, 32), pos = geo.attributes.position, col = [];
      const zen = new THREE.Color('#3b82d6'), mid = new THREE.Color('#86bae8'), hor = new THREE.Color('#dce9f4'), c = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        const y = Math.max(0, pos.getY(i) / 1400);
        if (y < 0.25) c.copy(hor).lerp(mid, Math.pow(y / 0.25, 0.7));
        else c.copy(mid).lerp(zen, Math.pow((y - 0.25) / 0.75, 0.6));
        col.push(c.r, c.g, c.b);
      }
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      this.sky = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
      this.sky.renderOrder = -10; this.scene.add(this.sky);
    }
    this.camera = new THREE.PerspectiveCamera(42, 1, 0.5, 1800);
    this.pitch = 1.1;    // ~63° von oben – weniger Verdeckung durch Häuser
    this.camDist = 125;
    this.ray = new THREE.Raycaster();
    this.tmpV = new THREE.Vector3();
    this.dummy = new THREE.Object3D();
    this.disposables = [];
    this.disposables.push(this.sky.geometry, this.sky.material);
    this.buildEnv();
    this.buildLights();
    this.buildGround();
    this.buildBuildings();
    this.buildTrees();
    this.buildStatic();
    this.mergeStatic();
    this.buildDynamic();
    this.cars = new Map();
    for (const c of game.cars) this.cars.set(c, this.makeCar(c));
    this.resize();
  }
  track(x) { this.disposables.push(x); return x; }
  mat(o, type = 'Lambert') { return this.track(new THREE['Mesh' + type + 'Material'](o)); }

  // Spiegelungen für Metall-Lacke: Himmel oben, heller Horizont, Boden unten, Sonne als Glanzpunkt
  buildEnv() {
    try {
      const es = new THREE.Scene(), geo = new THREE.SphereGeometry(10, 32, 16), pos = geo.attributes.position, col = [];
      const sky = new THREE.Color('#5fa8f0'), hor = new THREE.Color('#f4f8ff'), gnd = new THREE.Color('#7d8b6c'), c = new THREE.Color();
      for (let i = 0; i < pos.count; i++) { const y = pos.getY(i) / 10; if (y >= 0) c.copy(hor).lerp(sky, Math.pow(y, 0.55)); else c.copy(hor).lerp(gnd, Math.min(1, -y * 4)); col.push(c.r, c.g, c.b); }
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      es.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
      const sun = new THREE.Mesh(new THREE.SphereGeometry(1.1, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(5, 4.8, 4.3) }));
      sun.position.set(-4.5, 7.5, 3.5); es.add(sun);
      const pm = new THREE.PMREMGenerator(this.gl);
      this.envRT = pm.fromScene(es, 0.03); pm.dispose(); geo.dispose();
      this.scene.environment = this.envRT.texture; this.disposables.push(this.envRT);
    } catch (e) { /* ohne Spiegelungen weiter */ }
  }
  // Statische Einzelobjekte (Brücken, Geländer, Pfeiler, Mauern, Rampen, Wahrzeichen …) nach Material und
  // Kartenbereich zu wenigen großen Meshes zusammenfassen: viel weniger Draw Calls, kein Laufzeit-Aufwand
  mergeStatic() {
    const CELL = 260, groups = new Map(), v = new THREE.Vector3();
    this.scene.updateMatrixWorld(true);
    this.scene.traverse(o => {
      if (!o.isMesh || o.isInstancedMesh || o.isSkinnedMesh || o.userData.dyn || !o.visible || !o.geometry || !o.geometry.attributes.position) return;
      const m = o.material;
      if (!m || Array.isArray(m) || m.transparent || o === this.sky) return;
      if (o.matrixWorld.determinant() < 0) return;
      for (let p = o.parent; p; p = p.parent) if (p.userData.dyn || !p.visible) return;
      v.setFromMatrixPosition(o.matrixWorld);
      const key = [m.uuid, o.castShadow ? 1 : 0, o.receiveShadow ? 1 : 0, o.renderOrder, Math.floor(v.x / CELL), Math.floor(v.z / CELL)].join('|');
      let g = groups.get(key); if (!g) { g = []; groups.set(key, g); } g.push(o);
    });
    let merged = 0, removed = 0;
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const m = list[0].material, useColor = !!m.vertexColors;
      const parts = [];
      let n = 0, hasUv = false;
      for (const o of list) {
        let geo = o.geometry.index ? o.geometry.toNonIndexed() : o.geometry.clone();
        if (!geo.attributes.normal) geo.computeVertexNormals();
        geo.applyMatrix4(o.matrixWorld);
        if (geo.attributes.uv) hasUv = true;
        parts.push(geo); n += geo.attributes.position.count;
      }
      const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = hasUv ? new Float32Array(n * 2) : null, col = useColor ? new Float32Array(n * 3).fill(1) : null;
      let k = 0;
      for (const geo of parts) {
        const c = geo.attributes.position.count;
        pos.set(geo.attributes.position.array, k * 3); nor.set(geo.attributes.normal.array, k * 3);
        if (uv && geo.attributes.uv) uv.set(geo.attributes.uv.array.subarray(0, c * 2), k * 2);
        if (col && geo.attributes.color) col.set(geo.attributes.color.array.subarray(0, c * 3), k * 3);
        k += c; geo.dispose();
      }
      const out = this.track(new THREE.BufferGeometry());
      out.setAttribute('position', new THREE.BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      if (uv) out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
      if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
      out.computeBoundingSphere();
      const mesh = new THREE.Mesh(out, m);
      mesh.castShadow = list[0].castShadow; mesh.receiveShadow = list[0].receiveShadow; mesh.renderOrder = list[0].renderOrder;
      for (const o of list) { o.parent.remove(o); removed++; }
      this.scene.add(mesh); merged++;
    }
    this.mergeInfo = { merged, removed };
  }
  // ---------------- Licht ----------------
  buildLights() {
    const s = this.scene;
    s.add(new THREE.HemisphereLight('#f4f8ff', '#9c9686', 0.68));
    const fill = new THREE.DirectionalLight('#bfd8f8', 0.22);
    fill.position.set(70, 90, -60);
    s.add(fill);
    const sun = this.sun = new THREE.DirectionalLight('#fff4e0', 0.98);
    sun.castShadow = true;
    const mobile = ('ontouchstart' in window && navigator.maxTouchPoints > 0) || Math.min(screen.width, screen.height) < 600;
    sun.shadow.mapSize.set(mobile ? 1024 : 2048, mobile ? 1024 : 2048);
    const sc = sun.shadow.camera;
    sc.left = -95; sc.right = 95; sc.top = 95; sc.bottom = -95; sc.near = 10; sc.far = 400;
    sun.shadow.bias = -0.00045; sun.shadow.normalBias = 0.035;
    s.add(sun); s.add(sun.target);
    this.tunLights = [];
    for (let i = 0; i < 3; i++) {
      const pl = new THREE.PointLight('#fff0c8', 0, 58, 1.15);
      s.add(pl);
      this.tunLights.push(pl);
    }
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
    // Löcher im Gelände an den Tunnelportalen (Zufahrt & Überdeckung steuert W.terrain)
    const hole = (x, y) => W.isPortalHole(x, y);
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
    const wave = this.facadeTex(128, 128, (g, w, h, k, hm) => {
      g.fillStyle = k('#808080', 128); g.fillRect(0, 0, w, h);
      for (let i = 0; i < 70; i++) { const x = (i * 37) % w, y = (i * 53) % h, r = 6 + (i * 7) % 14; const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, hm ? 'rgb(190,190,190)' : '#909090'); gr.addColorStop(1, hm ? 'rgba(128,128,128,0)' : 'rgba(128,128,128,0)'); g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2); }
    });
    this.waterN = wave.nmap; this.waterN.repeat.set(1, 1);
    const waterM = this.mat({ color: '#2a67a6', specular: '#e8f4ff', shininess: 120, normalMap: wave.nmap, normalScale: new THREE.Vector2(0.55, 0.55), transparent: true, opacity: 0.88 }, 'Phong');
    for (const w of W.water) {
      const geo = this.polyGeo(w.p, w.z + 0.05, 14);
      if (!geo) continue;
      const m = new THREE.Mesh(geo, waterM);
      m.receiveShadow = true;
      this.scene.add(m);
    }
  }
  polyGeo(p, y, uvScale) {
    const pts = [];
    for (let i = 0; i < p.length; i += 2) pts.push(new THREE.Vector2(p[i], p[i + 1]));
    let tris;
    try { tris = THREE.ShapeUtils.triangulateShape(pts, []); } catch (e) { return null; }
    if (!tris.length) return null;
    const pos = [];
    for (const t of tris) for (const k of [t[0], t[2], t[1]]) pos.push(pts[k].x, y, pts[k].y);
    const g = this.track(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    if (uvScale) { const uv = []; for (let i = 0; i < pos.length; i += 3) uv.push(pos[i] / uvScale, pos[i + 2] / uvScale); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); }
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
    // Dachziegel (Biberschwanz / Tonziegel mit Relief-Normalmap und individueller Ziegeltönung)
    const roofTex = this.facadeTex(256, 256, (g, w, h, k, hm) => {
      g.fillStyle = k('#ececec', 135); g.fillRect(0, 0, w, h);
      const rh = 16, cw = 16;
      for (let row = 0; row < h / rh; row++) {
        const y = row * rh, off = (row & 1) ? cw / 2 : 0;
        if (!hm) {
          const gr = g.createLinearGradient(0, y, 0, y + rh);
          gr.addColorStop(0, 'rgba(255,255,255,0.08)');
          gr.addColorStop(0.75, 'rgba(0,0,0,0.04)');
          gr.addColorStop(1, 'rgba(0,0,0,0.28)');
          g.fillStyle = gr; g.fillRect(0, y, w, rh);
        } else {
          const gr = g.createLinearGradient(0, y, 0, y + rh);
          gr.addColorStop(0, 'rgb(115,115,115)');
          gr.addColorStop(0.8, 'rgb(175,175,175)');
          gr.addColorStop(1, 'rgb(75,75,75)');
          g.fillStyle = gr; g.fillRect(0, y, w, rh);
        }
        for (let x = -cw + off; x < w + cw; x += cw) {
          const hsh = ((row * 37 + ((x / cw) | 0) * 101) & 15) - 7;
          if (!hm) {
            g.fillStyle = hsh > 0 ? `rgba(255,245,235,${hsh * 0.008})` : `rgba(25,10,5,${-hsh * 0.01})`;
            g.fillRect(x + 1, y + 1, cw - 2, rh - 3);
            g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(x, y, 1.5, rh - 2);
            // Biberschwanz-Rundung an der Ziegelunterkante
            g.strokeStyle = 'rgba(0,0,0,0.22)'; g.lineWidth = 1.4;
            g.beginPath(); g.arc(x + cw / 2, y + rh - 4, cw * 0.46, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
          } else {
            g.fillStyle = 'rgb(90,90,90)'; g.fillRect(x, y, 2, rh);
          }
        }
      }
      if (!hm) this.noise(g, w, h, 320, 'rgba(0,0,0,0.04)', 'rgba(255,255,255,0.05)');
    });
    // Asphalt mit feiner Gesteinskörnung, leichten Fahrspuren, Bitumenfugen und Normal-Map
    const asphaltTex = this.facadeTex(512, 512, (g, w, h, k, hm) => {
      g.fillStyle = k('#464950', 128); g.fillRect(0, 0, w, h);
      let s = 13579; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      // Weiche großflächige Schattierungen + dezente Radspuren (entlang u = X-Achse des Straßenbands)
      for (let i = 0; i < 22; i++) {
        const x = rnd() * w, y = rnd() * h, r = 40 + rnd() * 90;
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        const dark = rnd() < 0.5;
        gr.addColorStop(0, hm ? (dark ? 'rgb(118,118,118)' : 'rgb(138,138,138)') : (dark ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.04)'));
        gr.addColorStop(1, 'rgba(128,128,128,0)');
        g.fillStyle = gr; g.fillRect(0, 0, w, h);
      }
      if (!hm) {
        // Leicht polierte Fahrspuren
        for (const ty of [h * 0.28, h * 0.72]) {
          const wg = g.createLinearGradient(0, ty - 45, 0, ty + 45);
          wg.addColorStop(0, 'rgba(0,0,0,0)'); wg.addColorStop(0.5, 'rgba(25,27,32,0.07)'); wg.addColorStop(1, 'rgba(0,0,0,0)');
          g.fillStyle = wg; g.fillRect(0, ty - 45, w, 90);
        }
      }
      // Feines Mineral-Korn (Splitt)
      for (let i = 0; i < 4200; i++) {
        const x = rnd() * w, y = rnd() * h, sz = 0.9 + rnd() * 1.6, br = rnd();
        if (hm) g.fillStyle = br < 0.45 ? 'rgb(112,112,112)' : br > 0.55 ? 'rgb(146,146,146)' : 'rgb(128,128,128)';
        else g.fillStyle = br < 0.5 ? 'rgba(15,17,20,0.10)' : 'rgba(220,225,235,0.08)';
        g.fillRect(x, y, sz, sz);
      }
      // Feine Bitumen-Reparaturfuge
      g.strokeStyle = hm ? 'rgb(108,108,108)' : 'rgba(22,24,28,0.22)'; g.lineWidth = 1.6;
      g.beginPath(); g.moveTo(0, h * 0.51);
      for (let x = 32; x <= w; x += 32) g.lineTo(x, h * 0.51 + (rnd() - 0.5) * 6);
      g.stroke();
    });
    // Naturstein / Putz-Relief für Gesimse, Sockel, Stützmauern und Brücken
    const stone = this.facadeTex(256, 256, (g, w, h, k, hm) => {
      g.fillStyle = k('#d8d2c7', 132); g.fillRect(0, 0, w, h);
      let s = 97531; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      const rh = 32, cw = 64;
      for (let row = 0; row < h / rh; row++) {
        const y = row * rh, off = (row & 1) ? cw / 2 : 0;
        g.fillStyle = hm ? 'rgb(92,92,92)' : 'rgba(50,44,38,0.18)';
        g.fillRect(0, y, w, 2);
        for (let x = -cw + off; x < w + cw; x += cw) {
          const v = (rnd() - 0.5) * 16;
          g.fillStyle = hm ? `rgb(${Math.round(136 + v)},${Math.round(136 + v)},${Math.round(136 + v)})` : (v > 0 ? `rgba(255,252,245,${v * 0.005})` : `rgba(40,32,24,${-v * 0.006})`);
          g.fillRect(x + 2, y + 2, cw - 4, rh - 4);
          g.fillStyle = hm ? 'rgb(92,92,92)' : 'rgba(50,44,38,0.16)';
          g.fillRect(x, y, 2, rh);
        }
      }
      for (let i = 0; i < 1400; i++) {
        g.fillStyle = hm ? (rnd() < 0.5 ? 'rgb(122,122,122)' : 'rgb(144,144,144)') : (rnd() < 0.5 ? 'rgba(0,0,0,0.045)' : 'rgba(255,255,255,0.05)');
        g.fillRect(rnd() * w, rnd() * h, 1.5, 1.5);
      }
    });
    const pavers = (base) => this.canvasTex(256, 256, (g, w, h) => {
      g.fillStyle = base; g.fillRect(0, 0, w, h);
      let s = 44556; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      for (let y = 0; y < h; y += 32) for (let x = (y / 32) % 2 ? 16 : 0; x < w; x += 32) {
        g.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.035)' : 'rgba(255,255,255,0.04)';
        g.fillRect(x + 1, y + 1, 30, 30);
      }
      g.strokeStyle = 'rgba(30,26,22,0.22)'; g.lineWidth = 2;
      for (let y = 0; y <= h; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
      for (let y = 0; y < h; y += 32) for (let x = (y / 32) % 2 ? 16 : 0; x <= w; x += 32) { g.beginPath(); g.moveTo(x, y); g.lineTo(x, y + 32); g.stroke(); }
      this.noise(g, w, h, 260, 'rgba(0,0,0,0.035)', 'rgba(255,255,255,0.045)');
    });
    // Granit-Bordstein mit Fugen und Fase
    const curb = this.canvasTex(128, 32, (g, w, h) => {
      const gr = g.createLinearGradient(0, 0, 0, h);
      gr.addColorStop(0, '#b5b0a6'); gr.addColorStop(0.25, '#dcd7cd'); gr.addColorStop(0.75, '#c8c3b8'); gr.addColorStop(1, '#98938a');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
      g.fillStyle = 'rgba(40,35,30,0.32)';
      for (let x = 0; x < w; x += 32) g.fillRect(x, 0, 2, h);
      this.noise(g, w, h, 90, 'rgba(0,0,0,0.06)', 'rgba(255,255,255,0.07)');
    });
    const dash = this.canvasTex(128, 32, (g, w, h) => {
      g.clearRect(0, 0, w, h);
      g.fillStyle = '#f5f4ec'; g.fillRect(4, 4, w * 0.54, h - 8);
      g.fillStyle = 'rgba(255,255,255,0.95)'; g.fillRect(6, 6, w * 0.54 - 4, h - 12);
    });
    this.tex = {
      facade,
      roof: roofTex.map, roofN: roofTex.nmap,
      asphalt: asphaltTex.map, asphaltN: asphaltTex.nmap,
      stone,
      curb,
      sidewalk: pavers('#aba69a'), foot: pavers('#b2a792'), dash
    };
    return this.tex;
  }

  // Fassaden-Textur + passende Normal-Map: Rahmen, Simse und Läden treten hervor, Glas und Türen liegen zurück
  facadeTex(w, h, draw) {
    const mk = hm => {
      const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
      draw(g, w, h, (col, ht) => hm ? `rgb(${ht},${ht},${ht})` : col, hm); return c;
    };
    const col = mk(false), src = mk(true).getContext('2d').getImageData(0, 0, w, h).data;
    const nc = document.createElement('canvas'); nc.width = w; nc.height = h;
    const ng = nc.getContext('2d'), out = ng.createImageData(w, h), S = 2.4 / 255;
    const H = (x, y) => src[((((y + h) % h) * w) + ((x + w) % w)) * 4];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = (H(x + 1, y) - H(x - 1, y)) * S, dy = (H(x, y + 1) - H(x, y - 1)) * S, l = Math.hypot(dx, dy, 1), i = (y * w + x) * 4;
      out.data[i] = (-dx / l * 0.5 + 0.5) * 255; out.data[i + 1] = (dy / l * 0.5 + 0.5) * 255; out.data[i + 2] = (1 / l * 0.5 + 0.5) * 255; out.data[i + 3] = 255;
    }
    ng.putImageData(out, 0, 0);
    const tex = c => { const t = this.track(new THREE.CanvasTexture(c)); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = this.gl.capabilities.getMaxAnisotropy(); return t; };
    return { map: tex(col), nmap: tex(nc) };
  }
  facades() {
    if (this.fac) return this.fac;
    const glassG = (g, x, y, w, h) => { const gr = g.createLinearGradient(x, y, x + w, y + h); gr.addColorStop(0, '#6f8394'); gr.addColorStop(0.45, '#2c3946'); gr.addColorStop(1, '#4b5c70'); return gr; };
    const base = (g, w, h, k, hm) => {
      g.fillStyle = k('#f4f3ef', 128); g.fillRect(0, 0, w, h);
      if (!hm) {
        // Feiner Rauputz + dezente Verwitterung
        this.noise(g, w, h, 420, 'rgba(35,28,20,0.035)', 'rgba(255,255,255,0.055)');
        const wg = g.createLinearGradient(0, 0, 0, h);
        wg.addColorStop(0, 'rgba(255,255,255,0.04)'); wg.addColorStop(0.85, 'rgba(0,0,0,0)'); wg.addColorStop(1, 'rgba(30,24,18,0.07)');
        g.fillStyle = wg; g.fillRect(0, 0, w, h);
      } else {
        this.noise(g, w, h, 500, 'rgb(121,121,121)', 'rgb(135,135,135)');
      }
    };
    const arch = (g, x, y, ww, hh) => { g.beginPath(); g.moveTo(x, y + hh); g.lineTo(x, y + ww / 2); g.arc(x + ww / 2, y + ww / 2, ww / 2, Math.PI, 0); g.lineTo(x + ww, y + hh); g.closePath(); };
    // Obergeschosse: 2 Fenster × 2 Stockwerke = 6 m × 6,4 m
    const win = (g, k, hm, x, y, rounded) => {
      g.fillStyle = k('#5c5c5c', 165); g.fillRect(x - 17, y - 2, 13, 68); g.fillRect(x + 56, y - 2, 13, 68);   // Läden
      if (!hm) { g.fillStyle = 'rgba(0,0,0,0.25)'; for (let s = 0; s < 66; s += 6) { g.fillRect(x - 17, y + s, 13, 2); g.fillRect(x + 56, y + s, 13, 2); } }
      g.fillStyle = k('#ebebeb', 195);
      if (rounded) { arch(g, x - 5, y - 6, 62, 74); g.fill(); } else { g.fillRect(x - 5, y - 5, 62, 73); g.fillStyle = k('#dedede', 215); g.fillRect(x - 9, y - 13, 70, 8); }
      g.fillStyle = hm ? k('', 60) : glassG(g, x, y, 52, 62);
      if (rounded) { arch(g, x, y, 52, 62); g.fill(); } else g.fillRect(x, y, 52, 62);
      if (!hm) { g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(x, rounded ? y + 20 : y, 52, 5); g.fillRect(x, y, 4, 62); }   // Schatten in der Laibung
      g.fillStyle = k('#ebebeb', 150); g.fillRect(x + 24, y + (rounded ? 8 : 0), 4, rounded ? 54 : 62); g.fillRect(x, y + 28, 52, 4);
      g.fillStyle = k('#cfcfcf', 230); g.fillRect(x - 9, y + 63, 70, 7);   // Fensterbank
      if (!hm) { const sg = g.createLinearGradient(0, y + 70, 0, y + 84); sg.addColorStop(0, 'rgba(0,0,0,0.3)'); sg.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = sg; g.fillRect(x - 9, y + 70, 70, 14); }
    };
    const upper = rounded => this.facadeTex(256, 256, (g, w, h, k, hm) => {
      base(g, w, h, k, hm);
      for (let fy = 0; fy < 2; fy++) {
        g.fillStyle = k('#e4e4e4', 160); g.fillRect(0, fy * 128 + 121, w, 7);   // Stockwerksgesims
        if (!hm) { g.fillStyle = 'rgba(0,0,0,0.14)'; g.fillRect(0, (fy * 128 + 128) % 256, w, 5); }
        for (let fx = 0; fx < 2; fx++) win(g, k, hm, fx * 128 + 38, fy * 128 + 30, rounded);
      }
    });
    // Erdgeschoss (6 m × 4,1 m): Haustür + Schaufenster bzw. Arkaden
    const shop = this.facadeTex(256, 176, (g, w, h, k, hm) => {
      base(g, w, h, k, hm);
      g.fillStyle = k('#bdb7ad', 150); g.fillRect(0, h - 26, w, 26);   // Steinsockel
      // Tür mit Rahmen, zurückgesetzt
      g.fillStyle = k('#e6e6e6', 200); g.fillRect(30, 44, 70, h - 44);
      g.fillStyle = k('#6b4a32', 55); g.fillRect(40, 54, 50, h - 62);
      if (!hm) { g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(40, 54, 50, 6); g.fillRect(40, 54, 5, h - 62); g.fillStyle = '#d9b45a'; g.fillRect(80, 112, 4, 10); }
      g.fillStyle = k('#5a3d29', 75); g.fillRect(46, 64, 17, 40); g.fillRect(67, 64, 17, 40); g.fillRect(46, 112, 17, 44); g.fillRect(67, 112, 17, 44);
      g.fillStyle = k('#cfcac0', 220); g.fillRect(26, h - 8, 78, 8);   // Stufe
      // Schaufenster mit Markise
      g.fillStyle = k('#e6e6e6', 195); g.fillRect(124, 48, 112, 102);
      g.fillStyle = hm ? k('', 55) : glassG(g, 132, 56, 96, 86); g.fillRect(132, 56, 96, 86);
      if (!hm) { g.fillStyle = 'rgba(255,230,170,0.35)'; g.fillRect(140, 108, 80, 34); g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(132, 56, 96, 6); }
      g.fillStyle = k('#cfcfcf', 230); g.fillRect(120, 146, 120, 6);
      for (let i = 0; i < 8; i++) { g.fillStyle = k(i % 2 ? '#f2f2f2' : '#b83a32', 235); g.fillRect(118 + i * 15.5, 22, 15.5, 22); }
      if (!hm) { g.fillStyle = 'rgba(0,0,0,0.3)'; g.fillRect(118, 44, 124, 8); }
    });
    const arcade = this.facadeTex(256, 176, (g, w, h, k, hm) => {
      base(g, w, h, k, hm);
      for (let fx = 0; fx < 2; fx++) {
        const x = fx * 128 + 14;
        g.fillStyle = k('#e2e2e2', 200); arch(g, x - 6, 18, 112, h - 18); g.fill();
        g.fillStyle = k('#3a3530', 35); arch(g, x + 4, 28, 92, h - 28); g.fill();
        if (!hm) { const gr = g.createLinearGradient(0, 28, 0, h); gr.addColorStop(0, 'rgba(0,0,0,0.45)'); gr.addColorStop(1, 'rgba(60,50,40,0)'); g.fillStyle = gr; arch(g, x + 4, 28, 92, h - 28); g.fill(); }
        g.fillStyle = k('#d4d4d4', 225); g.fillRect(x - 8, 70, 8, 6); g.fillRect(x + 96, 70, 8, 6);   // Kämpfer
      }
      g.fillStyle = k('#bdb7ad', 150); g.fillRect(0, h - 10, w, 10);
    });
    this.fac = { up: upper(false), upArch: upper(true), shop, arcade };
    return this.fac;
  }

  // ---------------- Gebäude: Fassaden mit Tiefe, Gesimse, Dachüberstände ----------------
  buildBuildings() {
    const T = this.makeTextures(), F = this.facades();
    const B_ = () => ({ pos: [], col: [], uv: [] });
    const wallA = B_(), wallB = B_(), shopB = B_(), arcB = B_(), roofB = B_(), trim = B_();
    const towers = [];   // runde Ecktürme mit Kegeldach: [x, y, r, z0, h, Wandfarbe, Dachfarbe]
    const dormers = [], chimneys = [];   // Dachgauben [x, z, y, Drehung, Wandfarbe, Dachfarbe], Schornsteine [x, z, y]
    let bi = 0;
    const put = (B, v, c, u) => { B.pos.push(v[0], v[1], v[2]); B.col.push(c.r, c.g, c.b); B.uv.push(u[0], u[1]); };
    const tri = (B, a, b, c, col, ua, ub, uc) => { put(B, a, col, ua); put(B, b, col, ub); put(B, c, col, uc); };
    // senkrechtes Wandstück mit Farbverlauf (unten dunkler = Kontaktschatten)
    const quad = (B, ax, ay, bx, by, z1, z2, u0, u1, v0, v1, c1, c2) => {
      put(B, [ax, z1, ay], c1, [u0, v0]); put(B, [bx, z1, by], c1, [u1, v0]); put(B, [bx, z2, by], c2, [u1, v1]);
      put(B, [ax, z1, ay], c1, [u0, v0]); put(B, [bx, z2, by], c2, [u1, v1]); put(B, [ax, z2, ay], c2, [u0, v1]);
    };
    const Z = [0, 0];
    // vorstehendes Band (Gesims / Sockel) entlang einer Kante mit Naturstein-Texturkoordinaten
    const band = (ax, ay, bx, by, nx, ny, z1, z2, o, col, top, bottom) => {
      const L = Math.hypot(bx - ax, by - ay), dx = (bx - ax) / L, dy = (by - ay) / L;
      const a0x = ax - dx * o, a0y = ay - dy * o, b0x = bx + dx * o, b0y = by + dy * o;
      const a1x = a0x + nx * o, a1y = a0y + ny * o, b1x = b0x + nx * o, b1y = b0y + ny * o;
      const u1 = L / 4, v1 = Math.max(0.15, (z2 - z1) / 2);
      quad(trim, a1x, a1y, b1x, b1y, z1, z2, 0, u1, 0, v1, col, col);
      if (top) { const ct = col.clone().multiplyScalar(1.06); tri(trim, [a0x, z2, a0y], [b0x, z2, b0y], [b1x, z2, b1y], ct, [0, 0], [u1, 0], [u1, 0.2]); tri(trim, [a0x, z2, a0y], [b1x, z2, b1y], [a1x, z2, a1y], ct, [0, 0], [u1, 0.2], [0, 0.2]); }
      if (bottom) { const cb = col.clone().multiplyScalar(0.55); tri(trim, [a0x, z1, a0y], [b0x, z1, b0y], [b1x, z1, b1y], cb, Z, Z, Z); tri(trim, [a0x, z1, a0y], [b1x, z1, b1y], [a1x, z1, a1y], cb, Z, Z, Z); }
    };
    const FW = 6, FH = 6.4, GH = 4.1;  // Fassaden-Kachel / Erdgeschoss in Metern
    const stone = R3.col('#b3ab9e');
    for (const b of this.game.world.buildings) {
      if (b.lm) continue;   // Wahrzeichen haben eigene Modelle
      const p = b.p, n = p.length / 2, h = b.top, z0 = b.base;
      const wc = R3.col(b.wall), rc = R3.col(b.roof);
      const hsh = (bi++ * 2654435761) >>> 0;
      const archy = b.c !== 4 && hsh % 10 < 3;
      const wall = archy ? wallB : wallA, ground = archy ? arcB : shopB;
      const split = b.c !== 4 && h - z0 > 7;
      const gTop = z0 + GH;
      const cAO = wc.clone().multiplyScalar(0.6), cMid = wc.clone().multiplyScalar(0.93);
      const cTrim = wc.clone().lerp(R3.col('#ffffff'), 0.45);
      let A2 = 0; for (let i = 0; i < n; i++) { const j = (i + 1) % n; A2 += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1]; }
      const so = A2 > 0 ? 1 : -1;
      const roofed = !!b.rf;
      // Wände
      let run = 0;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = p[i * 2], ay = p[i * 2 + 1], bx = p[j * 2], by = p[j * 2 + 1];
        const L = Math.hypot(bx - ax, by - ay);
        const u0 = run / FW, u1 = (run + L) / FW;
        run += L;
        if (split) {
          quad(ground, ax, ay, bx, by, z0, gTop, u0, u1, 0, 1, cAO, cMid);
          quad(wall, ax, ay, bx, by, gTop, h, u0, u1, 0, (h - gTop) / FH, cMid, wc);
        } else quad(wall, ax, ay, bx, by, z0, h, u0, u1, 0, (h - z0) / FH, cAO, wc);
        if (L > 1.2 && L) {
          const nx = so * (by - ay) / L, ny = -so * (bx - ax) / L;
          band(ax, ay, bx, by, nx, ny, h - 0.45, h, 0.32, cTrim, !roofed, true);                // Traufgesims
          band(ax, ay, bx, by, nx, ny, z0, z0 + 1.2, 0.1, stone, true, false);                // Sockel
          if (split) band(ax, ay, bx, by, nx, ny, gTop - 0.12, gTop + 0.12, 0.14, cTrim, true, true);  // Gurtgesims
        }
      }
      // Dach
      if (!b.flat && n === 4) {
        let k = 0;
        const len = i => Math.hypot(p[((i + 1) % 4) * 2] - p[i * 2], p[((i + 1) % 4) * 2 + 1] - p[i * 2 + 1]);
        if (len(1) > len(0)) k = 1;
        const P = i => [p[((i + k) % 4) * 2], p[((i + k) % 4) * 2 + 1]];
        const [p0, p1, p2, p3] = [P(0), P(1), P(2), P(3)];
        const half = b.rf.half, rise = b.rf.rise;
        const rh = h + rise;
        const m0 = [(p0[0] + p3[0]) / 2, (p0[1] + p3[1]) / 2], m1 = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
        // Dachüberstand: an der Traufe 0,55 m nach außen (entlang der Dachneigung), am Giebel 0,4 m
        const lr = Math.hypot(m1[0] - m0[0], m1[1] - m0[1]) || 1, ux = (m1[0] - m0[0]) / lr, uy = (m1[1] - m0[1]) / lr, eg = 0.4, ov = 0.55;
        const ez = h - ov * rise / half;
        const eave = (pt, m, sgn) => { const vx = pt[0] - m[0], vy = pt[1] - m[1], vl = Math.hypot(vx, vy) || 1; return [pt[0] + vx / vl * ov + ux * eg * sgn, ez, pt[1] + vy / vl * ov + uy * eg * sgn]; };
        const e0 = eave(p0, m0, -1), e1 = eave(p1, m1, 1), e2 = eave(p2, m1, 1), e3 = eave(p3, m0, -1);
        const r0 = [m0[0] - ux * eg, rh, m0[1] - uy * eg], r1 = [m1[0] + ux * eg, rh, m1[1] + uy * eg];
        const slope = Math.hypot(half + ov, rise + ov * rise / half) / 3, ridge = (lr + 2 * eg) / 3;
        const dark = rc.clone().multiplyScalar(0.84);
        tri(roofB, e0, e1, r1, rc, [0, 0], [ridge, 0], [ridge, slope]); tri(roofB, e0, r1, r0, rc, [0, 0], [ridge, slope], [0, slope]);
        tri(roofB, e2, e3, r0, dark, [0, 0], [ridge, 0], [ridge, slope]); tri(roofB, e2, r0, r1, dark, [0, 0], [ridge, slope], [0, slope]);
        // First-Kappe
        const rk = rc.clone().multiplyScalar(0.7);
        tri(trim, [r0[0], rh + 0.14, r0[2]], [r1[0], rh + 0.14, r1[2]], [r1[0], rh - 0.05, r1[2]], rk, Z, Z, Z);
        tri(trim, [r0[0], rh + 0.14, r0[2]], [r1[0], rh - 0.05, r1[2]], [r0[0], rh - 0.05, r0[2]], rk, Z, Z, Z);
        // Giebel (Wandfarbe, ohne Fenster)
        const gv = (h - z0) / FH, gt = (rh - z0) / FH;
        const q = v => [v[0], h, v[1]], rr0 = [m0[0], rh, m0[1]], rr1 = [m1[0], rh, m1[1]];
        tri(wall, q(p3), q(p0), rr0, wc, [0.02, gv], [0.03, gv], [0.025, Math.min(gt, gv + 0.12)]);
        tri(wall, q(p1), q(p2), rr1, wc, [0.02, gv], [0.03, gv], [0.025, Math.min(gt, gv + 0.12)]);
        // Dachgauben auf beiden Dachseiten, ein Schornstein am First
        if (rise >= 3.2 && lr >= 6.5 && half >= 3.2 && hsh % 4 !== 0) {
          const cnt = Math.max(1, Math.min(4, Math.floor(lr / 6.5))), dOut = half * 0.42, zr = h + rise * (1 - dOut / half);
          for (const [pa, ma] of [[p0, m0], [p3, m0]]) {
            const vx = pa[0] - ma[0], vy = pa[1] - ma[1], vl = Math.hypot(vx, vy) || 1, ox = vx / vl, oy = vy / vl;
            for (let q2 = 0; q2 < cnt; q2++) {
              const t = (q2 + 0.5) / cnt;
              dormers.push([m0[0] + ux * lr * t + ox * dOut, zr - 0.15, m0[1] + uy * lr * t + oy * dOut, -Math.atan2(oy, ox), wc, rc]);
            }
          }
        }
        if (hsh % 3 !== 1 && lr > 5) chimneys.push([m0[0] + ux * lr * 0.28 + (p0[0] - m0[0]) * 0.12, rh - 0.9, m0[1] + uy * lr * 0.28 + (p0[1] - m0[1]) * 0.12]);
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
        const rh = h + b.rf.rise;
        const apex = [b.cx, rh, b.cy];
        const ex = (x, y) => { const vx = x - b.cx, vy = y - b.cy, l = Math.hypot(vx, vy) || 1; return [x + vx / l * 0.55, h - 0.3, y + vy / l * 0.55]; };
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const ax = p[i * 2], ay = p[i * 2 + 1], bx = p[j * 2], by = p[j * 2 + 1];
          const L = Math.hypot(bx - ax, by - ay) || 1;
          const dist = Math.abs((bx - ax) * (ay - b.cy) - (ax - b.cx) * (by - ay)) / L;
          const tproj = ((b.cx - ax) * (bx - ax) + (b.cy - ay) * (by - ay)) / L;
          const sl = Math.hypot(dist, rh - h) / 3;
          tri(roofB, ex(ax, ay), ex(bx, by), apex, i % 2 ? rc : rc.clone().multiplyScalar(0.86), [0, 0], [L / 3, 0], [tproj / 3, sl]);
        }
      } else if (b.rf && b.rf.t === 3) {
        // umlaufend geneigtes Dach (Mansarde) mit Überstand für verwinkelte Grundrisse
        const d = b.rf.d, rh = h + b.rf.rise, inn = [], out = [];
        for (let i = 0; i < n; i++) {
          const ip = (i + n - 1) % n, inx = (i + 1) % n;
          const e1x = p[i * 2] - p[ip * 2], e1y = p[i * 2 + 1] - p[ip * 2 + 1], e2x = p[inx * 2] - p[i * 2], e2y = p[inx * 2 + 1] - p[i * 2 + 1];
          const l1 = Math.hypot(e1x, e1y) || 1, l2 = Math.hypot(e2x, e2y) || 1;
          const n1x = -so * e1y / l1, n1y = so * e1x / l1, n2x = -so * e2y / l2, n2y = so * e2x / l2;   // nach innen
          let mx = n1x + n2x, my = n1y + n2y; const ml = Math.hypot(mx, my) || 1; mx /= ml; my /= ml;
          const L = Math.min(d * 2.2, d / Math.max(0.35, mx * n1x + my * n1y));
          inn.push([p[i * 2] + mx * L, p[i * 2 + 1] + my * L]);
          out.push([p[i * 2] - mx * 0.45, p[i * 2 + 1] - my * 0.45]);
        }
        const ez = h - 0.45 * b.rf.rise / d;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n, col = i % 2 ? rc : rc.clone().multiplyScalar(0.86);
          const L = Math.hypot(out[j][0] - out[i][0], out[j][1] - out[i][1]) / 3, sl = Math.hypot(d, b.rf.rise) / 3;
          tri(roofB, [out[i][0], ez, out[i][1]], [out[j][0], ez, out[j][1]], [inn[j][0], rh, inn[j][1]], col, [0, 0], [L, 0], [L, sl]);
          tri(roofB, [out[i][0], ez, out[i][1]], [inn[j][0], rh, inn[j][1]], [inn[i][0], rh, inn[i][1]], col, [0, 0], [L, sl], [0, sl]);
        }
        let tris = [];
        const ipts = inn.map(([x, y]) => new THREE.Vector2(x, y));
        try { tris = THREE.ShapeUtils.triangulateShape(ipts, []); } catch (e) { /* egal */ }
        const cc = rc.clone().multiplyScalar(0.78);
        for (const t of tris) { const A = ipts[t[0]], B = ipts[t[2]], C = ipts[t[1]]; tri(roofB, [A.x, rh, A.y], [B.x, rh, B.y], [C.x, rh, C.y], cc, [A.x / 3, A.y / 3], [B.x / 3, B.y / 3], [C.x / 3, C.y / 3]); }
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
    const mk = (B, map, nmap, nScale = 1.2) => {
      if (!B.pos.length) return;
      const g = this.track(new THREE.BufferGeometry());
      g.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(B.col, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(B.uv, 2));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, nmap
        ? this.mat({ vertexColors: true, map, normalMap: nmap, normalScale: new THREE.Vector2(nScale, nScale), specular: '#101010', shininess: 8, side: THREE.DoubleSide }, 'Phong')
        : this.mat({ vertexColors: true, map, side: THREE.DoubleSide }));
      m.castShadow = true; m.receiveShadow = true;
      this.scene.add(m);
    };
    mk(wallA, F.up.map, F.up.nmap, 1.25); mk(wallB, F.upArch.map, F.upArch.nmap, 1.25);
    mk(shopB, F.shop.map, F.shop.nmap, 1.25); mk(arcB, F.arcade.map, F.arcade.nmap, 1.25);
    mk(roofB, T.roof, T.roofN, 0.95); mk(trim, T.stone.map, T.stone.nmap, 0.75);
    if (dormers.length) {
      // Gaube: Körper (Wandfarbe), Fenster, kleines Satteldach (Dachfarbe); lokal zeigt +x nach außen
      const body = this.track(new THREE.BoxGeometry(2.4, 1.7, 1.9)); body.translate(-1.0, 0.85, 0);
      const win = this.track(new THREE.PlaneGeometry(1.1, 1.0)); win.rotateY(Math.PI / 2); win.translate(0.21, 0.85, 0);
      const cap = this.track(new THREE.BufferGeometry());
      cap.setAttribute('position', new THREE.Float32BufferAttribute([0.35, 1.7, -1.15, -2.3, 1.7, -1.15, -2.3, 2.55, 0, 0.35, 1.7, -1.15, -2.3, 2.55, 0, 0.35, 2.55, 0, -2.3, 1.7, 1.15, 0.35, 1.7, 1.15, 0.35, 2.55, 0, -2.3, 1.7, 1.15, 0.35, 2.55, 0, -2.3, 2.55, 0, 0.35, 1.7, 1.15, 0.35, 1.7, -1.15, 0.35, 2.55, 0], 3));
      cap.computeVertexNormals();
      const mB = new THREE.InstancedMesh(body, this.mat({ map: T.stone.map }), dormers.length), mW = new THREE.InstancedMesh(win, this.mat({ color: '#2c3946' }), dormers.length), mC = new THREE.InstancedMesh(cap, this.mat({ map: T.roof, normalMap: T.roofN, side: THREE.DoubleSide }, 'Phong'), dormers.length);
      const d = this.dummy;
      dormers.forEach(([x, z, y, ry, wc, rc], i) => {
        d.position.set(x, z, y); d.rotation.set(0, ry, 0); d.scale.set(1, 1, 1); d.updateMatrix();
        mB.setMatrixAt(i, d.matrix); mW.setMatrixAt(i, d.matrix); mC.setMatrixAt(i, d.matrix);
        mB.setColorAt(i, wc); mC.setColorAt(i, rc);
      });
      for (const m of [mB, mW, mC]) { m.castShadow = true; m.receiveShadow = true; this.scene.add(m); }
    }
    if (chimneys.length) {
      const mc = new THREE.InstancedMesh(this.track(new THREE.BoxGeometry(0.8, 2.0, 0.8)), this.mat({ color: '#8a4a3a', map: T.stone.map }), chimneys.length), d = this.dummy;
      chimneys.forEach(([x, z, y], i) => { d.position.set(x, z + 1.0, y); d.rotation.set(0, 0, 0); d.scale.set(1, 1, 1); d.updateMatrix(); mc.setMatrixAt(i, d.matrix); });
      mc.castShadow = true; this.scene.add(mc);
    }
    if (towers.length) {
      const cyl = new THREE.InstancedMesh(this.track(new THREE.CylinderGeometry(1, 1, 1, 16)), this.mat({ map: F.up.map, normalMap: F.up.nmap, specular: '#0c0c0c', shininess: 6 }, 'Phong'), towers.length);
      const cone = new THREE.InstancedMesh(this.track(new THREE.ConeGeometry(1.18, 1, 16)), this.mat({ map: T.roof, normalMap: T.roofN, specular: '#101010', shininess: 6 }, 'Phong'), towers.length);
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
  ribbon(B, flat0, w, y, uScale, offset = 0, skipFn = null) {
    // Scharfe Knicke an Kreuzungen und Kurven abrunden, bevor verdichtet wird
    const smoothed = [];
    const n0 = flat0.length / 2;
    for (let i = 0; i < n0; i++) {
      const bx = flat0[i * 2], by = flat0[i * 2 + 1];
      if (i > 0 && i < n0 - 1) {
        const ax = flat0[(i - 1) * 2], ay = flat0[(i - 1) * 2 + 1];
        const cx = flat0[(i + 1) * 2], cy = flat0[(i + 1) * 2 + 1];
        const l1 = Math.hypot(bx - ax, by - ay), l2 = Math.hypot(cx - bx, cy - by);
        if (l1 > 4 && l2 > 4) {
          const d1x = (bx - ax) / l1, d1y = (by - ay) / l1, d2x = (cx - bx) / l2, d2y = (cy - by) / l2;
          const dot = d1x * d2x + d1y * d2y;
          if (dot < 0.94) {
            const cut = Math.min(l1 * 0.32, l2 * 0.32, Math.max(3.5, w * 0.55));
            const p0x = bx - d1x * cut, p0y = by - d1y * cut;
            const p2x = bx + d2x * cut, p2y = by + d2y * cut;
            for (let s = 0; s <= 4; s++) {
              const t = s / 4, it = 1 - t;
              smoothed.push(it * it * p0x + 2 * it * t * bx + t * t * p2x, it * it * p0y + 2 * it * t * by + t * t * p2y);
            }
            continue;
          }
        }
      }
      smoothed.push(bx, by);
    }
    // Polylinie fein verdichten (2,5 m), damit das Band dem Gelände weich folgt
    const flat = [];
    for (let i = 0; i + 1 < smoothed.length; i += 2) {
      const x = smoothed[i], yy = smoothed[i + 1];
      if (i + 3 < smoothed.length) {
        const nx = smoothed[i + 2], ny = smoothed[i + 3], L = Math.hypot(nx - x, ny - yy), k = Math.max(1, Math.ceil(L / 2.5));
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
        const f = 1 / Math.max(0.55, cos); nx *= f; ny *= f;
      }
      norms.push([nx, ny]);
    }
    let u = 0;
    for (let i = 0; i < n - 1; i++) {
      const a = P(i), b = P(i + 1), na = norms[i], nb = norms[i + 1];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (skipFn) {
        const mx = (a[0] + b[0]) * 0.5 + (na[0] + nb[0]) * 0.5 * offset;
        const my = (a[1] + b[1]) * 0.5 + (na[1] + nb[1]) * 0.5 * offset;
        if (skipFn(mx, my)) { u += L; continue; }
      }
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
    const carRoads = W.roads.filter(r => r.k <= 1);
    // Prüft, ob (x, y) auf der Fahrbahn einer anderen Straße liegt -> verhindert Bordsteine/Gehwege quer über Kreuzungen!
    const inOtherRoad = (x, y, selfR, pad = -0.15) => {
      for (const o of carRoads) {
        if (o === selfR) continue;
        const hw = o.w * 0.5 + pad;
        if (x < o.bb[0] - hw || x > o.bb[2] + hw || y < o.bb[1] - hw || y > o.bb[3] + hw) continue;
        const p = o.p;
        for (let i = 0; i + 3 < p.length; i += 2) {
          const ax = p[i], ay = p[i + 1], bx = p[i + 2], by = p[i + 3];
          const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
          const qx = ax + dx * t, qy = ay + dy * t;
          if ((x - qx) * (x - qx) + (y - qy) * (y - qy) < hw * hw) return true;
        }
      }
      return false;
    };
    // Runde Asphalt-Knoten an Straßenenden/Kreuzungen für nahtlose Übergänge
    const addJunctionDisc = (cx, cy, rad) => {
      if (W.isPortalHole(cx, cy)) return;
      const segs = 16;
      const cz = W.terrain(cx, cy) + 0.069;
      for (let s = 0; s < segs; s++) {
        const a0 = (s / segs) * Math.PI * 2, a1 = ((s + 1) / segs) * Math.PI * 2;
        const x0 = cx + Math.cos(a0) * rad, z0 = cy + Math.sin(a0) * rad;
        const x1 = cx + Math.cos(a1) * rad, z1 = cy + Math.sin(a1) * rad;
        L.asph.pos.push(cx, cz, cy, x0, W.terrain(x0, z0) + 0.069, z0, x1, W.terrain(x1, z1) + 0.069, z1);
        L.asph.uv.push(0.5, 0.5, 0.5 + Math.cos(a0) * 0.5, 0.5 + Math.sin(a0) * 0.5, 0.5 + Math.cos(a1) * 0.5, 0.5 + Math.sin(a1) * 0.5);
      }
    };
    const skipHole = (x, y) => W.isPortalHole(x, y);
    for (const r of W.roads) {
      if (r.k > 2) continue;
      if (r.k === 2) { this.ribbon(L.foot, r.p, Math.min(r.w, 5), 0.035, 2.2, 0, (x, y) => skipHole(x, y) || inOtherRoad(x, y, r, 0.1)); continue; }
      const skipCurb = (x, y) => skipHole(x, y) || inOtherRoad(x, y, r, -0.05);
      const skipSide = (x, y) => skipHole(x, y) || inOtherRoad(x, y, r, 0.25);
      const skipLine = (x, y) => skipHole(x, y) || inOtherRoad(x, y, r, -0.6);
      // Gehwege als zwei schmale Streifen (unterbrochen an einmündenden Straßen & Tunnelportalen)
      this.ribbon(L.side, r.p, 1.85, 0.032, 2.2, r.w / 2 + 0.9, skipSide);
      this.ribbon(L.side, r.p, 1.85, 0.032, 2.2, -r.w / 2 - 0.9, skipSide);
      this.ribbon(L.asph, r.p, r.w + 0.15, 0.07, 8, 0, skipHole);
      this.ribbon(L.curb, r.p, 0.32, 0.098, 2, r.w / 2 + 0.12, skipCurb);
      this.ribbon(L.curb, r.p, 0.32, 0.098, 2, -r.w / 2 - 0.12, skipCurb);
      if (r.k === 0 || r.w >= 9) this.ribbon(L.line, r.p, 0.22, 0.086, 6, 0, skipLine);
      if (r.k === 0) for (const sg of [1, -1]) this.ribbon(L.edge, r.p, 0.2, 0.086, 6, sg * (r.w / 2 - 0.65), skipCurb);
      // An Straßenenden / Kreuzungspunkten runde Asphaltteller einfügen
      for (const idx of [0, r.p.length - 2]) {
        const jx = r.p[idx], jy = r.p[idx + 1];
        if (inOtherRoad(jx, jy, r, 1.2)) addJunctionDisc(jx, jy, r.w * 0.52);
      }
      // Laternen
      let acc = 12, side = 1;
      for (let i = 0; i + 3 < r.p.length; i += 2) {
        const ax = r.p[i], ay = r.p[i + 1], bx = r.p[i + 2], by = r.p[i + 3];
        const seg = Math.hypot(bx - ax, by - ay); if (!seg) continue;
        const nx = -(by - ay) / seg, ny = (bx - ax) / seg;
        for (let d = 28 - acc; d < seg; d += 28) {
          const x = ax + (bx - ax) * d / seg + nx * side * (r.w / 2 + 1.35), y = ay + (by - ay) * d / seg + ny * side * (r.w / 2 + 1.35);
          if (x > 2 && y > 2 && x < W.w - 2 && y < W.h - 2 && !W.buildingAt(x, y) && !W.inWater(x, y) && !inOtherRoad(x, y, r, 1.6)) {
            lamps.push([x, y, Math.atan2(-ny * side, -nx * side)]);
          }
          side = -side;
        }
        acc = (acc + seg) % 28;
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
    mk(L.asph, this.mat(po({ map: T.asphalt, normalMap: T.asphaltN, normalScale: new THREE.Vector2(0.45, 0.45), specular: '#1c1e22', shininess: 14 }, -2), 'Phong'), 2);
    mk(L.curb, this.mat(po({ map: T.curb, color: '#d4d0c7' }, -3)), 3);
    mk(L.line, this.mat(po({ map: T.dash, transparent: true, alphaTest: 0.3 }, -4)), 4);
    mk(L.edge, this.mat(po({ color: '#f0efe6' }, -4)), 4);
    // Detaillierte Straßenlaternen mit Guss-Sockel, geschwungenem Ausleger, Leuchtenkopf und warmem Lichtkegel am Boden
    if (lamps.length) {
      const metalM = this.mat({ color: '#343a42', metalness: 0.65, roughness: 0.38 }, 'Standard');
      const baseGeo = this.track(new THREE.CylinderGeometry(0.14, 0.20, 0.9, 8));
      const poleGeo = this.track(new THREE.CylinderGeometry(0.065, 0.11, 5.2, 8));
      const armGeo = this.track(new THREE.BoxGeometry(1.15, 0.09, 0.11));
      const hoodGeo = this.track(new THREE.BoxGeometry(0.72, 0.14, 0.38));
      const bulbGeo = this.track(new THREE.BoxGeometry(0.56, 0.08, 0.28));
      const poolTex = this.canvasTex(64, 64, (g, w, h) => {
        const gr = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
        gr.addColorStop(0, 'rgba(255,235,175,0.22)'); gr.addColorStop(0.55, 'rgba(255,225,150,0.08)'); gr.addColorStop(1, 'rgba(255,225,150,0)');
        g.fillStyle = gr; g.fillRect(0, 0, w, h);
      }, false);
      const poolGeo = this.track(new THREE.PlaneGeometry(5.5, 5.5)); poolGeo.rotateX(-Math.PI / 2);
      const baseM = new THREE.InstancedMesh(baseGeo, metalM, lamps.length);
      const pole = new THREE.InstancedMesh(poleGeo, metalM, lamps.length);
      const arm = new THREE.InstancedMesh(armGeo, metalM, lamps.length);
      const hood = new THREE.InstancedMesh(hoodGeo, metalM, lamps.length);
      const bulb = new THREE.InstancedMesh(bulbGeo, this.mat({ color: '#fff8db', emissive: '#ffcf6b' }), lamps.length);
      const pool = new THREE.InstancedMesh(poolGeo, this.track(new THREE.MeshBasicMaterial({ map: poolTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })), lamps.length);
      const d = this.dummy;
      lamps.forEach(([x, y, a], i) => {
        const gz = W.terrain(x, y), ca = Math.cos(a), sa = Math.sin(a);
        d.position.set(x, gz + 0.45, y); d.rotation.set(0, 0, 0); d.scale.set(1, 1, 1); d.updateMatrix(); baseM.setMatrixAt(i, d.matrix);
        d.position.set(x, gz + 3.0, y); d.updateMatrix(); pole.setMatrixAt(i, d.matrix);
        d.position.set(x + ca * 0.52, gz + 5.52, y + sa * 0.52); d.rotation.order = 'YZX'; d.rotation.set(0, -a, 0.14); d.updateMatrix(); arm.setMatrixAt(i, d.matrix);
        d.position.set(x + ca * 1.02, gz + 5.60, y + sa * 1.02); d.rotation.set(0, -a, 0); d.updateMatrix(); hood.setMatrixAt(i, d.matrix);
        d.position.set(x + ca * 1.02, gz + 5.52, y + sa * 1.02); d.updateMatrix(); bulb.setMatrixAt(i, d.matrix);
        const px = x + ca * 1.3, py = y + sa * 1.3;
        d.position.set(px, W.terrain(px, py) + 0.11, py); d.rotation.set(0, 0, 0); d.updateMatrix(); pool.setMatrixAt(i, d.matrix);
      });
      pole.castShadow = true;   // Kleinteile werfen keinen Schatten (spart Schatten-Durchgang)
      pool.renderOrder = 5;
      this.scene.add(baseM, pole, arm, hood, bulb, pool);
    }
  }
  // ---------------- Brücken, Auffahrten & Dach-Skybridges ----------------
  buildDecks() {
    const W = this.game.world, T = this.makeTextures();
    const concrete = this.mat({ color: '#c4bfb6', map: T.stone.map, normalMap: T.stone.nmap, normalScale: new THREE.Vector2(0.5, 0.5) }, 'Phong');
    const rail = this.mat({ color: '#d0d5da', metalness: 0.6, roughness: 0.35 }, 'Standard');
    const asph = this.mat({ map: T.asphalt, normalMap: T.asphaltN, normalScale: new THREE.Vector2(0.45, 0.45), specular: '#1c1e22', shininess: 14, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }, 'Phong');
    for (const d of W.decks) {
      const ang = Math.atan2(d.uy, d.ux), dz = d.bz - d.az, tilt = Math.atan2(dz, d.L), len3D = Math.hypot(d.L, dz);
      const mx = (d.ax + d.bx) / 2, my = (d.ay + d.by) / 2, mz = (d.az + d.bz) / 2;
      const grp = new THREE.Group();
      grp.position.set(mx, mz, my); grp.rotation.order = 'YZX'; grp.rotation.set(0, -ang, tilt);
      const slab = new THREE.Mesh(this.track(new THREE.BoxGeometry(len3D + 0.4, 1.2, d.w)), concrete); slab.position.y = -0.6; grp.add(slab);
      const roadW = d.sky ? d.w - 1.2 : d.w - 2.2;
      const road = new THREE.Mesh(this.track(new THREE.PlaneGeometry(len3D, roadW)), asph); road.rotation.x = -Math.PI / 2; road.position.y = 0.04; grp.add(road);
      road.geometry.attributes.uv.array.forEach((v, i, a) => { if (i % 2 === 0) a[i] = v * len3D / 8; });
      // Geländer: bei Skybridges an den Dachanschlüssen wie im Kollisions-Hash zurückgesetzt
      const t0 = d.sky ? (d.acc ? 0 : Math.min(0.22, 2.3 / d.L)) : 0;
      const t1 = d.sky ? 1 - Math.min(0.22, 2.3 / d.L) : 1;
      const rLen = Math.max(0.5, (t1 - t0) * len3D), rMid = ((t0 + t1) * 0.5 - 0.5) * len3D;
      const curbW = d.sky ? 0.5 : 1.0, curbZ = d.sky ? d.w / 2 - 0.35 : d.w / 2 - 0.6;
      for (const sgn of [1, -1]) {
        const r = new THREE.Mesh(this.track(roundBox(rLen, 0.28, 0.24, 0.05)), rail); r.position.set(rMid, 0.92, sgn * (d.w / 2 - 0.16)); grp.add(r);
        const rMidBar = new THREE.Mesh(this.track(new THREE.BoxGeometry(rLen, 0.14, 0.14)), rail); rMidBar.position.set(rMid, 0.52, sgn * (d.w / 2 - 0.16)); grp.add(rMidBar);
        const curb = new THREE.Mesh(this.track(new THREE.BoxGeometry(len3D, 0.25, curbW)), concrete); curb.position.set(0, 0.12, sgn * curbZ); grp.add(curb);
        // Senkrechte Brückenpfeiler direkt in der Welt (nicht durch Steigung gekippt und nicht in Häusern)
        const pTs = d.acc ? [0.05, 0.32] : [-0.4, 0.4];
        for (const pt of pTs) {
          const px = mx + d.ux * d.L * pt + -d.uy * sgn * (d.w / 2 - 1.0), py = my + d.uy * d.L * pt + d.ux * sgn * (d.w / 2 - 1.0);
          if (W.buildingAt(px, py)) continue;
          const topZ = mz + dz * pt, gz = W.terrain(px, py), hgt = topZ - 1.0 - gz + 0.8;
          if (hgt < 1.2) continue;
          const pil = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.65, 0.78, hgt, 12)), concrete);
          pil.position.set(px, gz + hgt / 2 - 0.4, py);
          pil.castShadow = true; pil.receiveShadow = true;
          this.scene.add(pil);
        }
      }
      grp.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.scene.add(grp);
    }
  }

  // ---------------- Leitplanken an den Brückendämmen ----------------
  buildRails() {
    const W = this.game.world, T = this.makeTextures();
    const m = this.mat({ color: '#d4d9de', metalness: 0.7, roughness: 0.32 }, 'Standard');
    const postMat = this.mat({ color: '#7a8086', metalness: 0.6, roughness: 0.45 }, 'Standard');
    const reflMat = this.mat({ color: '#ff4b3a', emissive: '#9a1c10' });
    const stoneM = this.mat({ color: '#d6cdbd', map: T.stone.map, normalMap: T.stone.nmap, normalScale: new THREE.Vector2(0.85, 0.85) }, 'Phong');
    const capM = this.mat({ color: '#e8e1d3', map: T.stone.map });
    const posts = [], refls = [];
    for (const r of W.rails) {
      const L = Math.hypot(r.bx - r.ax, r.by - r.ay); if (L < 1) continue;
      const ry = -Math.atan2(r.by - r.ay, r.bx - r.ax), rz = Math.atan2(r.bz - r.az, L);
      if (r.w) {
        // Stützmauer: vom tiefsten Gelände daneben bis 0,9 m über die Fläche, mit heller Abdeckplatte
        const mx = (r.ax + r.bx) / 2, my = (r.ay + r.by) / 2, nx = -(r.by - r.ay) / L, ny = (r.bx - r.ax) / L;
        const zl = Math.min(W.terrain(mx + nx * 2.5, my + ny * 2.5), W.terrain(mx - nx * 2.5, my - ny * 2.5), (r.az + r.bz) / 2) - 0.6;
        const zt = (r.az + r.bz) / 2 + 0.9, hh = zt - zl;
        const wgGeo = this.track(new THREE.BoxGeometry(L + 0.5, hh, 0.72));
        wgGeo.attributes.uv.array.forEach((v, idx, arr) => { arr[idx] = v * (idx % 2 === 0 ? L / 4 : hh / 3); });
        const wg = new THREE.Mesh(wgGeo, stoneM);
        wg.position.set(mx, zl + hh / 2, my); wg.rotation.order = 'YZX'; wg.rotation.y = ry; wg.rotation.z = rz;
        wg.castShadow = true; wg.receiveShadow = true; this.scene.add(wg);
        const cp = new THREE.Mesh(this.track(roundBox(L + 0.65, 0.2, 0.92, 0.06)), capM); cp.position.set(mx, zt + 0.1, my); cp.rotation.copy(wg.rotation);
        cp.castShadow = true; cp.receiveShadow = true; this.scene.add(cp);
        continue;
      }
      // Doppel-W-Profil-Leitplanke
      const g = new THREE.Mesh(this.track(roundBox(L, 0.34, 0.18, 0.04)), m);
      g.position.set((r.ax + r.bx) / 2, (r.az + r.bz) / 2 + 0.76, (r.ay + r.by) / 2);
      g.rotation.order = 'YZX'; g.rotation.y = ry; g.rotation.z = rz;
      g.castShadow = true; g.receiveShadow = true; this.scene.add(g);
      const step = 3.5;
      for (let d = 0.4; d <= L - 0.2; d += step) {
        const t = d / L;
        const px = r.ax + (r.bx - r.ax) * t, py = r.ay + (r.by - r.ay) * t, pz = r.az + (r.bz - r.az) * t;
        posts.push([px, pz + 0.45, py, ry]);
        refls.push([px, pz + 0.76, py, ry]);
      }
    }
    if (posts.length) {
      const pMesh = new THREE.InstancedMesh(this.track(new THREE.BoxGeometry(0.14, 0.92, 0.16)), postMat, posts.length);
      const rMesh = new THREE.InstancedMesh(this.track(new THREE.BoxGeometry(0.12, 0.12, 0.21)), reflMat, refls.length);
      const d = this.dummy;
      posts.forEach(([x, z, y, ry], i) => {
        d.position.set(x, z, y); d.rotation.set(0, ry, 0); d.scale.set(1, 1, 1); d.updateMatrix();
        pMesh.setMatrixAt(i, d.matrix);
        const rf = refls[i];
        d.position.set(rf[0], rf[1], rf[2]); d.updateMatrix();
        rMesh.setMatrixAt(i, d.matrix);
      });
      pMesh.castShadow = true; pMesh.receiveShadow = true;
      this.scene.add(pMesh, rMesh);
    }
  }

  // ---------------- Tunnel: helle Röhre mit klaren Texturen, Lichtband und trichterförmigen Portalen ----------------
  buildTunnels() {
    const W = this.game.world, T = this.makeTextures();
    this.tunLampPts = [];
    // Scharfe Wandtextur: Betonfelder oben, reflektierendes Warnband, helle Keramik-Kacheln unten
    const wtex = this.canvasTex(256, 512, (g, w, h) => {
      g.fillStyle = '#8b8882'; g.fillRect(0, 0, w, 336);
      g.fillStyle = '#97948d';
      for (let y = 0; y < 336; y += 84) for (let x = 0; x < w; x += 128) g.fillRect(x + 2, y + 2, 124, 80);
      g.fillStyle = 'rgba(0,0,0,0.16)';
      for (let y = 84; y <= 336; y += 84) g.fillRect(0, y - 2, w, 3);
      for (let x = 0; x < w; x += 128) g.fillRect(x, 0, 3, 336);
      // Gelb-schwarzer Leitstreifen auf Augenhöhe
      g.fillStyle = '#e5ab20'; g.fillRect(0, 336, w, 18);
      g.fillStyle = '#24262b';
      for (let x = -32; x < w + 32; x += 32) { g.beginPath(); g.moveTo(x, 354); g.lineTo(x + 14, 354); g.lineTo(x + 26, 336); g.lineTo(x + 12, 336); g.closePath(); g.fill(); }
      // Helle reflektierende Kacheln unten für klare Sichtweite
      g.fillStyle = '#ece9df'; g.fillRect(0, 354, w, h - 354);
      for (let y = 354; y < h; y += 26) for (let x = 0; x < w; x += 32) {
        if (((x >> 5) + ((y / 26) | 0)) & 1) { g.fillStyle = 'rgba(0,0,0,0.035)'; g.fillRect(x + 1, y + 1, 30, 24); }
      }
      g.strokeStyle = 'rgba(55,52,48,0.22)'; g.lineWidth = 2;
      for (let y = 354; y <= h; y += 26) { g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); }
      for (let x = 0; x < w; x += 32) { g.beginPath(); g.moveTo(x, 354); g.lineTo(x, h); g.stroke(); }
    }, false);
    wtex.wrapS = THREE.RepeatWrapping; wtex.wrapT = THREE.ClampToEdgeWrapping;
    // Scharfe Tunnelfahrbahn: dunkler Asphalt mit Leitstreifen, gestrichelter Mittellinie & hellen Randstreifen
    const rtex = this.canvasTex(256, 256, (g, w, h) => {
      g.fillStyle = '#383b42'; g.fillRect(0, 0, w, h);
      let s = 24680; const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
      for (let i = 0; i < 1600; i++) {
        g.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.06)';
        g.fillRect(rnd() * w, rnd() * h, 1.5, 1.5);
      }
      // Randbankette + weiße Seitenlinien (v = 0..1 quer über Fahrbahn)
      g.fillStyle = '#7e7b74'; g.fillRect(0, 0, w, 12); g.fillRect(0, h - 12, w, 12);
      g.fillStyle = '#f2efe6'; g.fillRect(0, 14, w, 5); g.fillRect(0, h - 19, w, 5);
      // Gestrichelte Mittellinie in Fahrtrichtung (u-Achse)
      g.fillStyle = '#f5dc6e'; g.fillRect(16, h / 2 - 4, 140, 8);
    }, true);
    const hazTex = this.canvasTex(128, 32, (g, w, h) => {
      g.fillStyle = '#f0b820'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#1f2228';
      for (let x = -32; x < w + 32; x += 32) { g.beginPath(); g.moveTo(x, h); g.lineTo(x + 16, h); g.lineTo(x + 32, 0); g.lineTo(x + 16, 0); g.closePath(); g.fill(); }
    }, true);

    const wallM = this.mat({ map: wtex, emissive: '#5a5750', emissiveMap: wtex, emissiveIntensity: 0.55 });   // heller: Innenraum und Ausgang von außen gut sichtbar
    const ceilM = this.mat({ color: '#77756f', emissive: '#3a3833' });
    const roadM = this.mat({ map: rtex, emissive: '#2c2f34', polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
    const lampM = this.mat({ color: '#fff8de', emissive: '#ffe9a6' });
    const abutM = this.mat({ color: '#b4afa4', map: T.stone.map, normalMap: T.stone.nmap, normalScale: new THREE.Vector2(0.5, 0.5) }, 'Phong');
    const frameM = this.mat({ color: '#d8d2c4', map: T.stone.map });
    const hazM = this.mat({ map: hazTex, emissive: '#443200' });

    const lampList = [];
    for (const tn of W.tunnels) {
      const wall = [], ceil = [], road = [], ruv = [], wuv = [];
      const hw = tn.hw, H = tn.hgt;
      let acc = 0, nextLamp = 6;
      for (const sg of tn.segs) {
        const ux = (sg.bx - sg.ax) / sg.L, uy = (sg.by - sg.ay) / sg.L, nx = -uy * hw, ny = ux * hw;
        const A = [sg.ax, sg.az, sg.ay], B = [sg.bx, sg.bz, sg.by];
        const P = (pt, s, h) => [pt[0] + nx * s, pt[1] + h, pt[2] + ny * s];
        const w0 = acc / 6, w1 = (acc + sg.L) / 6;
        // Innenwände (FrontSide strikt nach innen gewickelt)
        {
          const a0 = P(A, 1, -0.2), b0 = P(B, 1, -0.2), a1 = P(A, 1, H + 0.06), b1 = P(B, 1, H + 0.06);
          wall.push(...a0, ...a1, ...b1, ...a0, ...b1, ...b0);
          wuv.push(w0, 0, w0, 1, w1, 1, w0, 0, w1, 1, w1, 0);
        }
        {
          const a0 = P(A, -1, -0.2), b0 = P(B, -1, -0.2), a1 = P(A, -1, H + 0.06), b1 = P(B, -1, H + 0.06);
          wall.push(...a0, ...b0, ...b1, ...a0, ...b1, ...a1);
          wuv.push(w0, 0, w1, 0, w1, 1, w0, 0, w1, 1, w0, 1);
        }
        // Decke (FrontSide nach unten -Y gerichtet)
        const l0 = P(A, 1.02, H), r0 = P(A, -1.02, H), l1 = P(B, 1.02, H), r1 = P(B, -1.02, H);
        ceil.push(...l0, ...r0, ...r1, ...l0, ...r1, ...l1);
        // Fahrbahn (FrontSide nach oben +Y gerichtet, sauber über Außenband ohne Z-Fighting)
        const fl0 = P(A, 0.99, 0.09), fr0 = P(A, -0.99, 0.09), fl1 = P(B, 0.99, 0.09), fr1 = P(B, -0.99, 0.09);
        road.push(...fl0, ...fl1, ...fr1, ...fl0, ...fr1, ...fr0);
        const u0 = acc / 8, u1 = (acc + sg.L) / 8;
        ruv.push(u0, 1, u1, 1, u1, 0, u0, 1, u1, 0, u0, 0);
        // Durchgehende Deckenbeleuchtung über alle Segmentlängen hinweg (alle 18 m)
        const rotY = -Math.atan2(uy, ux), tilt = Math.atan2(sg.bz - sg.az, sg.L);
        while (nextLamp < acc + sg.L - 3) {
          const d = nextLamp - acc, t = d / sg.L;
          const lx = sg.ax + ux * d, ly = sg.ay + uy * d, lz = sg.az + (sg.bz - sg.az) * t;
          lampList.push([lx, lz + H - 0.14, ly, rotY, tilt]);
          this.tunLampPts.push({ x: lx, y: ly, z: lz + H - 1.2 });
          nextLamp += 18;
        }
        acc += sg.L;
      }
      const mk = (arr, m, uvs) => {
        const g = this.track(new THREE.BufferGeometry());
        g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
        if (uvs) g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        g.computeVertexNormals();
        const mesh = new THREE.Mesh(g, m); mesh.receiveShadow = true; this.scene.add(mesh); return mesh;
      };
      mk(wall, wallM, wuv);
      mk(ceil, ceilM);
      mk(road, roadM, ruv);
      // Portale: Betonkragen über dem Hangloch, Seitenwangen, Warnbalken und aufgeweitete Flügelwände
      for (const p of tn.portals) {
        const ang = Math.atan2(-p.oy, -p.ox);   // +X zeigt ins Tunnelinnere, -X nach außen
        const grp = new THREE.Group(); grp.position.set(p.x, p.z, p.y); grp.rotation.y = -ang;
        const collar = new THREE.Mesh(this.track(new THREE.BoxGeometry(13.8, 0.9, tn.w + 8.8)), abutM);
        collar.position.set(6.6, H + 0.45, 0); grp.add(collar);
        const lintel = new THREE.Mesh(this.track(new THREE.BoxGeometry(1.8, 2.0, tn.w + 8.8)), frameM);
        lintel.position.set(0.4, H + 1.0, 0); grp.add(lintel);
        const haz = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.45, 0.72, tn.w + 0.8)), hazM);
        haz.position.set(-0.45, H + 0.36, 0); grp.add(haz);
        const browLamp = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.4, 0.18, tn.w - 1.4)), lampM);
        browLamp.position.set(0.4, H - 0.08, 0); grp.add(browLamp);
        for (const sgn of [1, -1]) {
          const side = new THREE.Mesh(this.track(new THREE.BoxGeometry(13.8, H + 1.4, 4.4)), abutM);
          side.position.set(6.6, (H + 0.4) / 2, sgn * (hw + 2.2)); grp.add(side);
          const pil = new THREE.Mesh(this.track(new THREE.BoxGeometry(2.2, H + 2.2, 2.8)), frameM);
          pil.position.set(0.4, (H + 1.8) / 2, sgn * (hw + 1.4)); grp.add(pil);
          // Trichterförmige Flügelwand von (0, ±hw) nach (-12, ±(hw + 5.5)) – aus Box verformt (sauberes Winding!)
          const wingG = this.track(new THREE.BoxGeometry(12, 1, 1.4, 1, 1, 1));
          const wp = wingG.attributes.position;
          for (let i = 0; i < wp.count; i++) {
            const vx = wp.getX(i), vy = wp.getY(i), vz = wp.getZ(i);
            const u = (6 - vx) / 12;
            const hTop = (H + 1.2) * (1 - u) + 2.4 * u;
            wp.setXYZ(i, vx - 6, (vy + 0.5) * hTop - 0.5, vz + u * 5.5 * sgn);
          }
          wingG.computeVertexNormals();
          const wing = new THREE.Mesh(wingG, abutM);
          wing.position.set(0, 0, sgn * (hw + 0.7)); grp.add(wing);
        }
        grp.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
        this.scene.add(grp);
      }
    }
    if (lampList.length) {
      const lmMesh = new THREE.InstancedMesh(this.track(new THREE.BoxGeometry(3.4, 0.22, 0.85)), lampM, lampList.length);
      const d = this.dummy;
      d.rotation.order = 'YZX';
      lampList.forEach(([x, z, y, ry, rz], i) => {
        d.position.set(x, z, y); d.rotation.set(0, ry, rz); d.scale.set(1, 1, 1); d.updateMatrix();
        lmMesh.setMatrixAt(i, d.matrix);
      });
      this.scene.add(lmMesh);
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
      if (lm.t === 'basilika') this.buildBasilika(g, { box, cyl, dome, prism, white, cream, copper });
      else if (lm.t === 'turm') this.buildTurm(g, lm);
      else if (lm.t === 'kirche') this.buildKirche(g, lm);
      else if (lm.t === 'blaserturm') {
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
  // gemeinsame Helfer für Altstadt-Bauten: Canvas-Textur, Box mit Kachel-UVs, steiles Satteldach, Pyramide
  lmKit() {
    if (this._lmKit) return this._lmKit;
    const T = this.makeTextures();
    const tex = (w, h, draw) => { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); const t = this.track(new THREE.CanvasTexture(c)); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = this.gl.capabilities.getMaxAnisotropy(); return t; };
    // mittelalterlicher Turm: Putz mit Eckquadern und schmalen Fenstern (Kachel 8 m)
    const towerT = tex(256, 256, (g, w, h) => {
      g.fillStyle = '#eee6d6'; g.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 32) { g.fillStyle = (y / 32) % 2 ? '#d9cdb5' : '#e3d8c2'; g.fillRect(0, y, 22, 30); g.fillRect(w - 22, y + 16 > h ? 0 : y, 22, 30); }
      g.fillStyle = '#3b3530'; g.fillRect(118, 70, 20, 54); g.beginPath(); g.arc(128, 70, 10, Math.PI, 0); g.fill();
      g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(118, 124, 20, 4);
    });
    // gotische Kirchenwand: Strebepfeiler und hohe Spitzbogenfenster (Kachel 8 m)
    const gothT = tex(256, 256, (g, w, h) => {
      g.fillStyle = '#e7dfcf'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#d2c6ae'; g.fillRect(0, 0, 26, h);
      g.fillStyle = '#b9ad95'; g.beginPath(); g.moveTo(90, 236); g.lineTo(90, 70); g.quadraticCurveTo(90, 30, 128, 18); g.quadraticCurveTo(166, 30, 166, 70); g.lineTo(166, 236); g.closePath(); g.fill();
      const gr = g.createLinearGradient(0, 30, 0, 230); gr.addColorStop(0, '#5a6d82'); gr.addColorStop(1, '#2d3846');
      g.fillStyle = gr; g.beginPath(); g.moveTo(98, 230); g.lineTo(98, 72); g.quadraticCurveTo(98, 40, 128, 28); g.quadraticCurveTo(158, 40, 158, 72); g.lineTo(158, 230); g.closePath(); g.fill();
      g.fillStyle = '#b9ad95'; g.fillRect(126, 40, 4, 190); g.fillRect(98, 120, 60, 3);
    });
    const glazed = tex(64, 64, (g) => {   // glasierte Ziegel im Rautenmuster (Grüner Turm)
      g.fillStyle = '#2f7a4f'; g.fillRect(0, 0, 64, 64);
      g.fillStyle = '#4fae6f'; for (let y = 0; y < 64; y += 16) for (let x = (y / 16) % 2 ? 8 : 0; x < 64; x += 16) { g.beginPath(); g.moveTo(x + 8, y); g.lineTo(x + 16, y + 8); g.lineTo(x + 8, y + 16); g.lineTo(x, y + 8); g.closePath(); g.fill(); }
    });
    const M = o => this.mat(o);
    const kit = {
      tower: M({ map: towerT }), goth: M({ map: gothT }), plain: M({ color: '#e9e1d0' }), stone: M({ color: '#cbbfa8' }),
      roofRed: M({ map: T.roof, color: '#b0503a', side: THREE.DoubleSide }), roofGreen: M({ map: glazed, side: THREE.DoubleSide }),
      slate: this.mat({ color: '#565c66', metalness: 0.3, roughness: 0.5, side: THREE.DoubleSide }, 'Standard'), dark: M({ color: '#2b2622' }), gold: M({ color: '#e2bf5a' }),
    };
    kit.box = (g, w, h, d, m, x, y, z, tile = 8) => {
      const geo = this.track(new THREE.BoxGeometry(w, h, d)), uv = geo.attributes.uv, dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
      for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) { const i = f * 4 + k; uv.setXY(i, uv.getX(i) * dims[f][0] / tile, uv.getY(i) * dims[f][1] / tile); }
      const o = new THREE.Mesh(geo, m); o.position.set(x, y + h / 2, z); g.add(o); return o;
    };
    kit.gable = (g, L, w, h, m, x, y, z) => {   // Satteldach entlang x, mit Überstand
      const a = L / 2 + 0.4, b = w / 2 + 0.6, geo = this.track(new THREE.BufferGeometry());
      const v = [-a, 0, -b, a, 0, -b, a, h, 0, -a, 0, -b, a, h, 0, -a, h, 0, a, 0, b, -a, 0, b, -a, h, 0, a, 0, b, -a, h, 0, a, h, 0];
      const sl = Math.hypot(b, h) / 3, ll = L / 3;
      geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, ll, 0, ll, sl, 0, 0, ll, sl, 0, sl, 0, 0, ll, 0, ll, sl, 0, 0, ll, sl, 0, sl], 2)); geo.computeVertexNormals();
      const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); g.add(o);
      const gg = this.track(new THREE.BufferGeometry()), hh = h * (w / 2) / b;
      gg.setAttribute('position', new THREE.Float32BufferAttribute([-L / 2, 0, -w / 2, -L / 2, 0, w / 2, -L / 2, hh, 0, L / 2, 0, w / 2, L / 2, 0, -w / 2, L / 2, hh, 0], 3)); gg.computeVertexNormals();
      const gm = new THREE.Mesh(gg, kit.plain); gm.position.set(x, y, z); g.add(gm);
      return o;
    };
    kit.pyramid = (g, w, h, m, x, y, z, seg = 4) => {
      const geo = this.track(new THREE.ConeGeometry(w / 2 * Math.SQRT2 * (seg === 4 ? 1 : 0.75) + 0.3, h, seg, 1, true));
      const uv = geo.attributes.uv; for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * w / 2, uv.getY(i) * h / 3);
      const o = new THREE.Mesh(geo, m); o.position.set(x, y + h / 2, z); if (seg === 4) o.rotation.y = Math.PI / 4; g.add(o); return o;
    };
    return (this._lmKit = kit);
  }
  // Stadttürme der Ravensburger Altstadt (Grüner Turm, Frauentor, Untertor, Spitalturm, Obertor)
  buildTurm(g, lm) {
    const K = this.lmKit(), w = lm.w, d = lm.d, s = lm.s;
    const roofH = s === 'treppe' ? w * 0.85 : s === 'gruen' ? w * 1.5 : s === 'helm' ? w * 1.2 : w * 1.25;
    const shaft = Math.max(12, lm.h - roofH);
    K.box(g, w, shaft, d, K.tower, 0, 0, 0);
    K.box(g, w + 0.6, 0.6, d + 0.6, K.stone, 0, shaft - 0.6, 0, 4);   // Gesims
    // Torbogen (Frauentor/Obertor) an beiden Seiten, Uhr oben
    if (s === 'treppe') for (const sg of [1, -1]) { const ar = new THREE.Mesh(this.track(new THREE.PlaneGeometry(w * 0.45, 5.5)), K.dark); ar.position.set(sg * (w / 2 + 0.03), 2.75, 0); ar.rotation.y = sg * Math.PI / 2; g.add(ar); }
    if (s === 'treppe') {
      K.gable(g, w, d, roofH, K.roofRed, 0, shaft, 0);
      // Treppengiebel an den Stirnseiten
      for (const sg of [1, -1]) for (let k = 0; k < 5; k++) { const bw = d * (1 - k / 5.5); K.box(g, 0.7, roofH / 5 + 0.05, bw, K.plain, sg * (w / 2 - 0.2), shaft + k * roofH / 5, 0, 4); }
    } else if (s === 'gruen') {
      K.pyramid(g, w, roofH, K.roofGreen, 0, shaft, 0);
      const sp = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.08, 0.08, 3, 6)), K.gold); sp.position.set(0, shaft + roofH + 1.2, 0); g.add(sp);
    } else if (s === 'helm') {
      K.pyramid(g, w, roofH * 0.55, K.roofRed, 0, shaft, 0);
      K.box(g, w * 0.35, 3, w * 0.35, K.plain, 0, shaft + roofH * 0.5, 0, 4);
      K.pyramid(g, w * 0.4, roofH * 0.5, K.slate, 0, shaft + roofH * 0.5 + 3, 0, 8);
    } else {
      K.pyramid(g, w, roofH, K.roofRed, 0, shaft, 0);
    }
  }
  // gotische Kirche: Langhaus mit Strebepfeilern und Spitzbogenfenstern, steiles Ziegeldach, Chor, Westturm mit Spitzhelm
  buildKirche(g, lm) {
    const K = this.lmKit(), L = lm.L, Wd = lm.W, tw = lm.tw, h = lm.h, th = lm.th;
    const nl = L - tw, nx = tw / 2;
    K.box(g, nl, h, Wd, K.goth, nx, 0, 0);
    K.gable(g, nl, Wd, Wd * 0.8, K.roofRed, nx, h, 0);
    // Chor: halbrund am Ostende
    const ch = new THREE.Mesh(this.track(new THREE.CylinderGeometry(Wd * 0.42, Wd * 0.42, h * 0.92, 10, 1, false, 0, Math.PI)), K.goth);
    ch.position.set(nx + nl / 2, h * 0.46, 0); g.add(ch);
    const cr = new THREE.Mesh(this.track(new THREE.ConeGeometry(Wd * 0.46, Wd * 0.6, 10, 1, true, 0, Math.PI)), K.roofRed); cr.position.set(nx + nl / 2, h * 0.92 + Wd * 0.3, 0); g.add(cr);
    // Westturm
    const shaft = th * 0.6;
    K.box(g, tw, shaft, tw, K.tower, -L / 2 + tw / 2, 0, 0);
    K.box(g, tw + 0.5, 0.6, tw + 0.5, K.stone, -L / 2 + tw / 2, shaft - 0.6, 0, 4);
    K.box(g, tw * 0.82, th * 0.1, tw * 0.82, K.tower, -L / 2 + tw / 2, shaft, 0);
    K.pyramid(g, tw * 0.82, th * 0.3, K.slate, -L / 2 + tw / 2, shaft + th * 0.1, 0, 8);
    const cross = new THREE.Mesh(this.track(new THREE.BoxGeometry(0.15, 2.2, 0.15)), K.gold); cross.position.set(-L / 2 + tw / 2, th + 1, 0); g.add(cross);
    const portal = new THREE.Mesh(this.track(new THREE.PlaneGeometry(3.2, 5)), K.dark); portal.position.set(-L / 2 - 0.03, 2.5, 0); portal.rotation.y = -Math.PI / 2; g.add(portal);
  }
  // Basilika St. Martin: helle Barockfassade mit Pilastern und Rundbogenfenstern, Doppeltürme mit Kupferhauben,
  // steile rote Ziegeldächer über Langhaus und Querhaus, Kuppel mit Tambour über der Vierung
  buildBasilika(g, H) {
    const { cyl, dome, copper } = H, T = this.makeTextures();
    const tex = (w, h, draw) => { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h); const t = this.track(new THREE.CanvasTexture(c)); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = this.gl.capabilities.getMaxAnisotropy(); return t; };
    const archP = (x, y, w, h, gg) => { gg.beginPath(); gg.moveTo(x, y + h); gg.lineTo(x, y + w / 2); gg.arc(x + w / 2, y + w / 2, w / 2, Math.PI, 0); gg.lineTo(x + w, y + h); gg.closePath(); };
    // Fassade: 8 m × 8 m Kachel – Pilaster, Gesims, Rundbogenfenster mit Rahmen
    const baroque = tex(256, 256, (gg, w, h) => {
      gg.fillStyle = '#efe6d2'; gg.fillRect(0, 0, w, h);
      for (const x of [0, w - 26]) { const gr = gg.createLinearGradient(x, 0, x + 26, 0); gr.addColorStop(0, '#f8f2e4'); gr.addColorStop(1, '#d8ccb0'); gg.fillStyle = gr; gg.fillRect(x, 0, 26, h); }
      gg.fillStyle = '#ddd1b6'; gg.fillRect(0, 0, w, 10); gg.fillStyle = 'rgba(0,0,0,0.18)'; gg.fillRect(0, 10, w, 4);
      gg.fillStyle = '#d9cdb0'; archP(78, 58, 100, 160, gg); gg.fill();
      const gl = gg.createLinearGradient(0, 70, 0, 210); gl.addColorStop(0, '#55687a'); gl.addColorStop(1, '#2c3846'); gg.fillStyle = gl; archP(90, 70, 76, 142, gg); gg.fill();
      gg.fillStyle = 'rgba(230,224,210,0.9)'; gg.fillRect(126, 70, 4, 142); gg.fillRect(90, 140, 76, 3);
      gg.fillStyle = '#cfc2a4'; gg.fillRect(72, 214, 112, 9);
      gg.fillStyle = 'rgba(0,0,0,0.25)'; gg.fillRect(72, 223, 112, 6);
    });
    const belfry = tex(128, 128, (gg, w, h) => {
      gg.fillStyle = '#efe6d2'; gg.fillRect(0, 0, w, h);
      gg.fillStyle = '#d8ccb0'; gg.fillRect(0, 0, 10, h); gg.fillRect(w - 10, 0, 10, h);
      gg.fillStyle = '#2a2622'; archP(30, 18, 68, 96, gg); gg.fill();
      gg.fillStyle = '#d8ccb0'; gg.fillRect(24, 112, 80, 8);
    });
    const clock = tex(128, 128, (gg, w) => {
      gg.fillStyle = '#efe6d2'; gg.fillRect(0, 0, w, w);
      gg.fillStyle = '#1f2a33'; gg.beginPath(); gg.arc(64, 64, 46, 0, 7); gg.fill();
      gg.strokeStyle = '#e2bf5a'; gg.lineWidth = 5; gg.beginPath(); gg.arc(64, 64, 46, 0, 7); gg.stroke();
      gg.lineWidth = 6; gg.beginPath(); gg.moveTo(64, 64); gg.lineTo(64, 30); gg.moveTo(64, 64); gg.lineTo(88, 74); gg.stroke();
    });
    const wallM = this.mat({ map: baroque, color: '#ffffff' }), towerM = this.mat({ map: baroque, color: '#f4efe4' });
    const belM = this.mat({ map: belfry }), clockM = this.mat({ map: clock }), plainM = this.mat({ color: '#eee5d1' });
    const roofM = this.mat({ map: T.roof, color: '#b4553a', side: THREE.DoubleSide }), corn = this.mat({ color: '#ddd1b6' });
    // Box mit Textur-Wiederholung nach Größe (Kachel in Metern)
    const tbox = (w, h, d, m, x, y, z, tile = 8) => {
      const geo = this.track(new THREE.BoxGeometry(w, h, d)), uv = geo.attributes.uv;
      const dims = [[d, h], [d, h], [w, d], [w, d], [w, h], [w, h]];
      for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) { const i = f * 4 + k; uv.setXY(i, uv.getX(i) * dims[f][0] / tile, uv.getY(i) * dims[f][1] / tile); }
      const o = new THREE.Mesh(geo, m); o.position.set(x, y + h / 2, z); g.add(o); return o;
    };
    // steiles Satteldach mit Überstand (Ziegeltextur)
    const roof = (L, w, h, x, y, z, rotY = 0) => {
      const a = L / 2 + 0.6, b = w / 2 + 0.9, geo = this.track(new THREE.BufferGeometry());
      const v = [-a, 0, -b, a, 0, -b, a, h, 0, -a, 0, -b, a, h, 0, -a, h, 0, a, 0, b, -a, 0, b, -a, h, 0, a, 0, b, -a, h, 0, a, h, 0];
      const sl = Math.hypot(b, h) / 3, ll = L / 3, uv = [0, 0, ll, 0, ll, sl, 0, 0, ll, sl, 0, sl, 0, 0, ll, 0, ll, sl, 0, 0, ll, sl, 0, sl];
      geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); geo.computeVertexNormals();
      const o = new THREE.Mesh(geo, roofM); o.position.set(x, y, z); o.rotation.y = rotY; g.add(o);
      // Giebeldreiecke in Wandfarbe
      const gg = this.track(new THREE.BufferGeometry());
      gg.setAttribute('position', new THREE.Float32BufferAttribute([-L / 2, 0, -w / 2, -L / 2, 0, w / 2, -L / 2, h * (w / 2) / b, 0, L / 2, 0, w / 2, L / 2, 0, -w / 2, L / 2, h * (w / 2) / b, 0], 3)); gg.computeVertexNormals();
      const gm = new THREE.Mesh(gg, plainM); gm.material.side = THREE.DoubleSide; gm.position.copy(o.position); gm.rotation.y = rotY; g.add(gm);
    };
    // Langhaus + Querhaus
    tbox(98, 22, 26, wallM, 2, 0, 0); tbox(98.8, 1.2, 26.8, corn, 2, 22, 0, 4); roof(98, 26, 13, 2, 23.2, 0);
    tbox(24, 22, 46, wallM, 12, 0, 0); tbox(24.8, 1.2, 46.8, corn, 12, 22, 0, 4); roof(46, 24, 12, 12, 23.2, 0, Math.PI / 2);
    // Kuppel: Tambour mit Fenstern, Kupferkuppel, Laterne
    const drum = new THREE.Mesh(this.track(new THREE.CylinderGeometry(8.6, 8.6, 9, 24, 1, true)), this.mat({ map: belfry, side: THREE.DoubleSide }));
    drum.material.map = belfry.clone(); drum.material.map.needsUpdate = true; drum.material.map.repeat.set(8, 1); drum.position.set(12, 31.5, 0); g.add(drum);
    cyl(g, 9.2, 9.2, 0.8, 24, corn, 12, 36, 0);
    const cu = this.mat({ color: '#5f9e8a', envMapIntensity: 0.6, metalness: 0.35, roughness: 0.45 }, 'Standard');
    dome(g, 8.8, cu, 12, 36.8, 0, 1.2); cyl(g, 1.8, 1.8, 4, 12, plainM, 12, 46.8, 0); dome(g, 2.0, cu, 12, 50.8, 0, 1.3);
    cyl(g, 0.12, 0.12, 2.5, 6, this.mat({ color: '#e2bf5a' }), 12, 53, 0);
    // Doppeltürme mit Glockenstube, Uhr und Zwiebelhaube
    const helm = this.track(new THREE.LatheGeometry([[0, 0], [5.4, 0], [5.6, 0.8], [5.0, 2.2], [3.4, 3.8], [1.6, 5.0], [2.0, 6.0], [1.4, 7.2], [0.6, 8.2], [0.25, 10.5], [0, 11]].map(([x, y]) => new THREE.Vector2(x, y)), 16));
    for (const zz of [-14, 14]) {
      tbox(11.5, 40, 11.5, towerM, -46, 0, zz); tbox(12.3, 1.2, 12.3, corn, -46, 40, zz, 4);
      tbox(10, 8, 10, belM, -46, 41.2, zz, 10); tbox(10.8, 0.9, 10.8, corn, -46, 49.2, zz, 4);
      for (const [cx, cz] of [[-5.8, 0], [0, zz > 0 ? 5.8 : -5.8]]) { const ck = new THREE.Mesh(this.track(new THREE.CircleGeometry(2.1, 20)), clockM); ck.position.set(-46 + cx - (cx ? 0.02 : 0), 36, zz + cz + (cz ? Math.sign(cz) * 0.02 : 0)); ck.rotation.y = cx ? -Math.PI / 2 : (cz > 0 ? 0 : Math.PI); g.add(ck); }
      const hm = new THREE.Mesh(helm, cu); hm.position.set(-46, 50.1, zz); g.add(hm);
      cyl(g, 0.12, 0.12, 2.2, 6, this.mat({ color: '#e2bf5a' }), -46, 61, zz);
    }
    // geschwungene Mittelfassade mit Säulen, Portal und Volutengiebel
    const front = new THREE.Mesh(this.track(new THREE.CylinderGeometry(9.5, 9.5, 30, 24, 1, false, Math.PI, Math.PI)), wallM);
    front.material = this.mat({ map: baroque.clone(), color: '#ffffff' }); front.material.map.needsUpdate = true; front.material.map.repeat.set(3.6, 3.75);
    front.position.set(-50.5, 15, 0); g.add(front);
    for (const zz of [-6.8, -3.2, 3.2, 6.8]) { const a = Math.asin(zz / 9.5), cx = -50.5 - Math.cos(a) * 9.6; cyl(g, 0.55, 0.65, 21, 10, plainM, cx, 0, zz); cyl(g, 0.95, 0.95, 1, 10, corn, cx, 21, zz); }
    const portal = new THREE.Mesh(this.track(new THREE.PlaneGeometry(4.2, 7)), this.mat({ color: '#5a3d29' })); portal.position.set(-60.05, 3.5, 0); portal.rotation.y = -Math.PI / 2; g.add(portal);
    const ped = new THREE.Mesh(this.track(new THREE.CylinderGeometry(6.5, 6.5, 1.6, 20, 1, false, Math.PI, Math.PI)), corn); ped.rotation.x = Math.PI / 2; ped.position.set(-58.6, 30, 0); ped.scale.set(1, 1, 1); g.add(ped);
    cyl(g, 0.15, 0.15, 3, 6, this.mat({ color: '#e2bf5a' }), -57.5, 34, 0);
    // Treppe zum Portal
    for (let k = 0; k < 3; k++) tbox(2.2, 0.35 * (3 - k), 14 - k * 2, this.mat({ color: '#d6cfc0' }), -61.5 - k * 1.6 + 1.6, -0.3, 0, 4);
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
    const cg = this.track(new THREE.IcosahedronGeometry(1, 2)), cp = cg.attributes.position;
    for (let i = 0; i < cp.count; i++) { const x = cp.getX(i), y = cp.getY(i), z = cp.getZ(i), f = 1 + 0.12 * Math.sin(x * 5.1 + y * 3.7) * Math.cos(z * 4.3); cp.setXYZ(i, x * f, y * f, z * f); }
    cg.computeVertexNormals();
    const crown = new THREE.InstancedMesh(cg, this.mat({ color: '#ffffff' }), T.length);
    const crown2 = new THREE.InstancedMesh(cg, this.mat({ color: '#ffffff' }), T.length);
    const shades = ['#3d6f2f', '#4f8436', '#35652c'];
    const d = this.dummy;
    T.forEach((t, i) => {
      const gz = Wt.terrain(t.x, t.y);
      d.position.set(t.x, gz + t.h * 0.3, t.y); d.rotation.set(0, 0, 0); d.scale.set(1, t.h * 0.6, 1); d.updateMatrix();
      trunk.setMatrixAt(i, d.matrix);
      d.position.set(t.x, gz + t.h * 0.68, t.y); d.rotation.set(0, i, 0); d.scale.set(t.r, t.r * 1.15, t.r); d.updateMatrix();
      crown.setMatrixAt(i, d.matrix);
      crown.setColorAt(i, R3.col(shades[t.hue]));
      d.position.set(t.x + Math.cos(i) * t.r * 0.45, gz + t.h * 0.82, t.y + Math.sin(i) * t.r * 0.45); d.scale.set(t.r * 0.68, t.r * 0.72, t.r * 0.68); d.updateMatrix();
      crown2.setMatrixAt(i, d.matrix);
      crown2.setColorAt(i, R3.col(shades[(t.hue + 1) % 3]).clone().multiplyScalar(1.08));
    });
    for (const m of [trunk, crown, crown2]) { m.castShadow = true; m.receiveShadow = true; this.scene.add(m); }
  }

  // ---------------- Rampen, Basen, Kisten ----------------
  buildStatic() {
    const W = this.game.world;
    // Rampen als sanft ansteigender Keil mit Warnstreifen & Seitenführung
    const sc = document.createElement('canvas'); sc.width = 256; sc.height = 128;
    const sg = sc.getContext('2d');
    sg.fillStyle = '#383b42'; sg.fillRect(0, 0, 256, 128);
    // Asphalt-Körnung auf der Rampe
    for (let i = 0; i < 600; i++) {
      sg.fillStyle = (i & 1) ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.12)';
      sg.fillRect((i * 73) % 256, (i * 41) % 128, 2, 2);
    }
    // Gelb-schwarze Warnstreifen an den Rändern und Richtungspfeile in der Mitte
    sg.fillStyle = '#f2be24';
    sg.fillRect(0, 0, 256, 18); sg.fillRect(0, 110, 256, 18);
    sg.fillStyle = '#1d1f24';
    for (let i = -64; i < 256; i += 32) {
      sg.beginPath(); sg.moveTo(i, 18); sg.lineTo(i + 16, 18); sg.lineTo(i + 30, 0); sg.lineTo(i + 14, 0); sg.fill();
      sg.beginPath(); sg.moveTo(i, 128); sg.lineTo(i + 16, 128); sg.lineTo(i + 30, 110); sg.lineTo(i + 14, 110); sg.fill();
    }
    sg.strokeStyle = 'rgba(242,190,36,0.85)'; sg.lineWidth = 6;
    for (let x = 36; x < 235; x += 56) {
      sg.beginPath(); sg.moveTo(x - 16, 40); sg.lineTo(x + 12, 64); sg.lineTo(x - 16, 88); sg.stroke();
    }
    const rampTex = this.track(new THREE.CanvasTexture(sc));
    rampTex.anisotropy = this.maxAniso || 4;
    const rampMat = this.mat({ map: rampTex, roughness: 0.72, metalness: 0.12, side: THREE.DoubleSide }, 'Standard');
    const sideMat = this.mat({ color: '#6b6e75', roughness: 0.78, metalness: 0.15, side: THREE.DoubleSide }, 'Standard');
    const railMat = this.mat({ color: '#d8b028', roughness: 0.45, metalness: 0.35 }, 'Standard');
    for (const r of W.ramps) {
      const L = r.len, Wd = r.wid, H = r.big ? 2.2 : 1.5;
      const x0 = -L / 2, xLip = -L / 2 + L * 0.22, x1 = L / 2;
      const hLip = 0.22 * H;
      const g = this.track(new THREE.BufferGeometry());
      const v = [
        // Sanfter Einlauf-Keil vorne (0..22%)
        x0, 0, -Wd / 2, xLip, hLip, -Wd / 2, xLip, hLip, Wd / 2, x0, 0, -Wd / 2, xLip, hLip, Wd / 2, x0, 0, Wd / 2,
        // Hauptschräge (22%..100%)
        xLip, hLip, -Wd / 2, x1, H, -Wd / 2, x1, H, Wd / 2, xLip, hLip, -Wd / 2, x1, H, Wd / 2, xLip, hLip, Wd / 2,
        // Rückwand
        x1, 0, -Wd / 2, x1, H, -Wd / 2, x1, H, Wd / 2, x1, 0, -Wd / 2, x1, H, Wd / 2, x1, 0, Wd / 2,
        // Seitenwände
        x0, 0, -Wd / 2, x1, 0, -Wd / 2, x1, H, -Wd / 2, x0, 0, -Wd / 2, x1, H, -Wd / 2, xLip, hLip, -Wd / 2,
        x0, 0, Wd / 2, x1, H, Wd / 2, x1, 0, Wd / 2, x0, 0, Wd / 2, xLip, hLip, Wd / 2, x1, H, Wd / 2,
      ];
      const uv = [
        0, 0, 0.22, 0, 0.22, 1, 0, 0, 0.22, 1, 0, 1,
        0.22, 0, 1, 0, 1, 1, 0.22, 0, 1, 1, 0.22, 1,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ];
      g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.addGroup(0, 12, 0); g.addGroup(12, 18, 1);
      g.computeVertexNormals();
      const grp = new THREE.Group();
      const m = new THREE.Mesh(g, [rampMat, sideMat]);
      m.castShadow = true; m.receiveShadow = true;
      grp.add(m);
      // Niedrige seitliche Leitbordsteine auf der Rampe
      const slopeLen = Math.hypot(L, H), slopeAng = Math.atan2(H, L);
      const curbGeo = this.track(new THREE.BoxGeometry(slopeLen, 0.14, 0.16));
      for (const s of [-1, 1]) {
        const cb = new THREE.Mesh(curbGeo, railMat);
        cb.position.set(0, H * 0.48 + 0.06, s * (Wd / 2 - 0.08));
        cb.rotation.z = slopeAng;
        cb.castShadow = true;
        grp.add(cb);
      }
      grp.position.set(r.x, (r.rz !== undefined ? r.rz : W.terrain(r.x, r.y)) - 0.03, r.y); grp.rotation.y = -r.a;
      this.scene.add(grp);
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
    const propMats = PROP.map(pr => this.mat({ color: pr.top, metalness: 0.15, roughness: 0.45, envMapIntensity: 0.6 }, 'Standard'));
    const geoCache = new Map();
    this.props = this.game.props.map(p => {
      const key = [p.hw, p.h, p.hh].map(v => v.toFixed(2)).join('|');
      let geo = geoCache.get(key);
      if (!geo) { geo = this.track(roundBox(p.hw * 2, p.h, p.hh * 2, Math.min(0.25, p.h * 0.2, p.hw * 0.4, p.hh * 0.4))); geoCache.set(key, geo); }
      const m = new THREE.Mesh(geo, propMats[p.t]); m.userData.dyn = true;
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
    this.bulletMesh = new THREE.InstancedMesh(this.track(new THREE.BoxGeometry(1, 1, 1)), this.track(new THREE.MeshBasicMaterial({ color: '#ffffff' })), 1200);
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
          'void main(){ vC=pcolor; vec4 mv=modelViewMatrix*vec4(position,1.0); float d=-mv.z; vA=palpha*smoothstep(2.5,9.0,d); gl_PointSize=clamp(psize*scale/d, 1.0, 220.0); gl_Position=projectionMatrix*mv; }',
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
    const def = c.def, tm = TEAM[c.team % TEAM.length], L = def.len, Wd = def.wid, H = CAR_H[def.shape] || 1.4;
    const wId = c.weaponId || def.weapon;
    const root = new THREE.Group();
    const body = new THREE.Group(); root.add(body);
    const S = (o) => this.mat({ envMapIntensity: 0.75, ...o }, 'Standard');
    const paint = S({ color: tm.color, metalness: 0.35, roughness: 0.3 });
    const dark = S({ color: tm.dark, metalness: 0.3, roughness: 0.42 });
    const black = S({ color: '#1a1a1c', metalness: 0.1, roughness: 0.6 });
    const glass = S({ color: '#16222f', metalness: 0.2, roughness: 0.06, envMapIntensity: 1.1 });
    const metal = S({ color: '#4a5058', metalness: 0.75, roughness: 0.32 });
    const box = (w, h, d, m, x, y, z) => { const o = new THREE.Mesh(this.track(roundBox(w, h, d, Math.min(0.14, w * 0.3, h * 0.3, d * 0.3))), m); o.position.set(x, y, z); o.castShadow = true; body.add(o); return o; };
    // Seitenprofil (x = Länge, y = Höhe) über die Breite extrudiert, mit weichen Kanten
    const prof = (pts, w, m, z = 0, bev = 0.11) => {
      const sh = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
      const d = Math.max(0.02, w - 2 * bev);
      const g = this.track(new THREE.ExtrudeGeometry(sh, { depth: d, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelOffset: -bev, bevelSegments: 3, curveSegments: 4 }));
      g.translate(0, 0, -d / 2); g.computeVertexNormals();
      const o = new THREE.Mesh(g, m); o.position.z = z; o.castShadow = true; body.add(o); return o;
    };
    const tube = (x1, y1, z1, x2, y2, z2, r, m) => {
      const a = new THREE.Vector3(x1, y1, z1), b = new THREE.Vector3(x2, y2, z2), L = a.distanceTo(b);
      const o = new THREE.Mesh(this.track(new THREE.CylinderGeometry(r, r, L, 8)), m);
      o.position.copy(a).add(b).multiplyScalar(0.5); o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      o.castShadow = true; body.add(o); return o;
    };
    const tire = S({ color: '#1b1b1d', metalness: 0, roughness: 0.85 });
    const rim = S({ color: '#c7cbd1', metalness: 0.9, roughness: 0.22 });
    const wheels = [];
    // große, frei stehende Geländeräder: verschachtelter Lenk-Pivot (steerGrp) und Roll-Pivot (spinGrp)
    const wheel = (r, w, x, z) => {
      const steerGrp = new THREE.Group(); steerGrp.position.set(x, r, z); body.add(steerGrp);
      const spinGrp = new THREE.Group(); steerGrp.add(spinGrp);
      const t = new THREE.Mesh(this.track(new THREE.CylinderGeometry(r, r, w, 20)), tire); t.rotation.x = Math.PI / 2; t.castShadow = true; spinGrp.add(t);
      const lugs = new THREE.Mesh(this.track(new THREE.TorusGeometry(r * 0.97, r * 0.07, 4, 16)), tire); lugs.scale.z = w / (r * 0.14) * 0.9; spinGrp.add(lugs);
      const rr = new THREE.Mesh(this.track(new THREE.CylinderGeometry(r * 0.58, r * 0.58, w + 0.04, 10)), rim); rr.rotation.x = Math.PI / 2; spinGrp.add(rr);
      const hub = new THREE.Mesh(this.track(new THREE.CylinderGeometry(r * 0.2, r * 0.26, w + 0.12, 6)), metal); hub.rotation.x = Math.PI / 2; spinGrp.add(hub);
      wheels.push({ g: steerGrp, spin: spinGrp, r, front: x > 0 });
      // runder Kotflügel (Radlauf) über dem Rad
      const R0 = r + 0.07, R1 = r + 0.24, sh = new THREE.Shape();
      sh.absarc(0, 0, R1, 0.12, Math.PI - 0.12, false); sh.absarc(0, 0, R0, Math.PI - 0.12, 0.12, true);
      const fg = this.track(new THREE.ExtrudeGeometry(sh, { depth: w + 0.1, bevelEnabled: true, bevelThickness: 0.04, bevelSize: 0.04, bevelOffset: -0.04, bevelSegments: 2, curveSegments: 14 }));
      fg.translate(0, 0, -(w + 0.1) / 2);
      const fe = new THREE.Mesh(fg, def.shape === 'buggy' ? dark : paint); fe.position.set(x, r, z * 0.985); fe.castShadow = true; body.add(fe);
      return steerGrp;
    };
    const lightF = S({ color: '#fff6d8', emissive: '#d8c98a', roughness: 0.2 }), lightR = S({ color: '#ff3b30', emissive: '#a01a12', roughness: 0.2 });
    const lamps = (xf, xr, y, hw) => {
      for (const s of [1, -1]) { box(0.12, 0.16, 0.38, lightF, xf, y, s * hw); box(0.1, 0.14, 0.3, lightR, xr, y, s * hw); }
    };
    let faceY = H + 0.02, faceX = c.shape.face;
    const hl = L / 2;
    switch (def.shape) {
      case 'sport': {   // flache Keilform mit schräger Frontscheibe
        for (const [x, z] of [[1.4, 1.02], [1.4, -1.02], [-1.35, 1.02], [-1.35, -1.02]]) wheel(0.44, 0.42, x, z);
        prof([[-hl, 0.38], [hl, 0.38], [hl, 0.62], [hl * 0.55, 0.8], [0.2, 0.86], [-hl * 0.75, 0.86], [-hl, 0.78]], Wd - 0.5, paint);
        prof([[0.65, 0.84], [-0.85, 0.84], [-1.05, 1.0], [-0.55, H], [0.05, H]], Wd * 0.72, glass);
        prof([[0.02, H - 0.02], [-0.55, H - 0.02], [-0.56, H + 0.04], [0.0, H + 0.04]], Wd * 0.74, paint);
        box(0.3, 0.12, Wd - 0.4, dark, -hl + 0.15, 1.02, 0);   // Heckflügel
        box(0.25, 0.28, Wd - 0.3, black, hl + 0.05, 0.48, 0);
        lamps(hl - 0.02, -hl + 0.02, 0.62, Wd / 2 - 0.55);
        faceY = H + 0.06; faceX = -0.25;
        break;
      }
      case 'buggy': {   // offener Rahmen mit Überrollbügeln, riesige Hinterräder
        for (const [x, z] of [[1.3, 1.12], [1.3, -1.12]]) wheel(0.5, 0.5, x, z);
        for (const [x, z] of [[-1.15, 1.15], [-1.15, -1.15]]) wheel(0.64, 0.62, x, z);
        prof([[-hl + 0.3, 0.42], [hl, 0.42], [hl, 0.62], [hl * 0.3, 0.9], [-hl + 0.3, 0.9]], 1.5, dark);
        prof([[0.2, 0.86], [hl, 0.62], [hl - 0.1, 0.8], [0.4, 1.05]], 1.65, paint);
        const cy = 1.75;
        for (const z of [-0.72, 0.72]) {
          tube(-0.85, 0.9, z, -0.6, cy, z * 0.9, 0.06, metal); tube(0.55, 0.9, z, 0.2, cy, z * 0.9, 0.06, metal);
          tube(-0.6, cy, z * 0.9, 0.2, cy, z * 0.9, 0.06, metal);
        }
        tube(-0.6, cy, 0.65, -0.6, cy, -0.65, 0.06, metal); tube(0.2, cy, 0.65, 0.2, cy, -0.65, 0.06, metal);
        box(0.5, 0.5, 0.9, black, -1.35, 0.95, 0);   // Motor hinten
        lamps(hl - 0.05, -hl + 0.35, 0.72, 0.55);
        faceY = 1.1; faceX = -0.1;
        break;
      }
      case 'tank': {    // gepanzerter Kettenwagen mit schrägen Panzerplatten
        for (const s of [1, -1]) {
          box(L, 0.8, 0.72, black, 0, 0.45, s * (Wd / 2 - 0.36));
          for (let i = 0; i < 5; i++) { const w = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.3, 0.3, 0.76, 12)), metal); w.rotation.x = Math.PI / 2; w.position.set(-hl + 0.6 + i * (L - 1.2) / 4, 0.38, s * (Wd / 2 - 0.36)); body.add(w); }
          prof([[-hl - 0.05, 0.82], [hl + 0.05, 0.82], [hl - 0.2, 1.0], [-hl + 0.1, 1.0]], 0.82, dark, s * (Wd / 2 - 0.36));   // Kettenschürze
        }
        prof([[-hl + 0.1, 0.55], [hl - 0.3, 0.55], [hl, 0.75], [hl - 0.8, H - 0.15], [-hl + 0.3, H - 0.15], [-hl + 0.1, 0.95]], Wd - 1.35, paint);
        prof([[hl - 0.85, H - 0.18], [-hl + 0.35, H - 0.18], [-hl + 0.6, H], [hl - 1.2, H]], Wd - 1.6, dark);
        lamps(hl - 0.2, -hl + 0.1, 0.85, Wd / 2 - 1.0);
        faceY = H + 0.02; faceX = 1.55;
        break;
      }
      case 'jeep': {    // Geländewagen: Motorhaube, Kabine, Reserverad
        for (const [x, z] of [[1.5, 1.1], [1.5, -1.1], [-1.45, 1.1], [-1.45, -1.1]]) wheel(0.52, 0.5, x, z);
        prof([[-hl, 0.48], [hl, 0.48], [hl, 0.98], [hl * 0.25, 1.05], [-hl, 1.05]], Wd - 0.5, dark);
        prof([[hl * 0.2, 1.0], [hl, 0.95], [hl - 0.05, 1.12], [hl * 0.2, 1.18]], Wd - 0.55, paint);   // Haube
        prof([[hl * 0.22, 1.08], [-0.75, 1.08], [-0.8, H - 0.08], [-0.05, H - 0.08]], Wd - 0.6, glass);
        prof([[-0.02, H - 0.1], [-0.82, H - 0.1], [-0.82, H], [-0.02, H]], Wd - 0.5, paint);
        const sp = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.42, 0.42, 0.28, 16)), tire); sp.rotation.z = Math.PI / 2; sp.position.set(-hl - 0.12, 1.0, 0); body.add(sp);
        box(0.22, 0.3, Wd - 0.2, black, hl + 0.08, 0.62, 0);
        lamps(hl - 0.02, -hl + 0.02, 0.88, Wd / 2 - 0.45);
        faceY = H + 0.02; faceX = -0.45;
        break;
      }
      case 'truck': {   // Monster-Pickup: hohe Kabine, Ladefläche, riesige Räder
        for (const [x, z] of [[1.55, 1.2], [1.55, -1.2], [-1.55, 1.2], [-1.55, -1.2]]) wheel(0.72, 0.62, x, z);
        prof([[-hl, 0.95], [hl, 0.95], [hl, 1.42], [hl * 0.45, 1.5], [-hl, 1.5]], Wd - 0.5, dark);
        prof([[hl * 0.45, 1.42], [hl, 1.38], [hl - 0.05, 1.6], [hl * 0.4, 1.66]], Wd - 0.55, paint);
        prof([[hl * 0.42, 1.55], [-0.35, 1.55], [-0.4, H - 0.08], [0.55, H - 0.08]], Wd - 0.6, glass);
        prof([[0.53, H - 0.1], [-0.42, H - 0.1], [-0.42, H], [0.5, H]], Wd - 0.5, paint);
        for (const s of [1, -1]) box(hl - 0.5, 0.35, 0.12, paint, -hl / 2 - 0.2, 1.62, s * (Wd / 2 - 0.3));   // Ladeflächen-Bordwand
        box(0.12, 0.35, Wd - 0.6, paint, -hl + 0.08, 1.62, 0);
        for (const z of [-0.5, 0, 0.5]) box(0.15, 0.15, 0.15, this.mat({ color: '#ffe9a0', emissive: '#aa9a40' }), 0.4, H + 0.08, z);
        box(0.25, 0.32, Wd - 0.1, black, hl + 0.1, 1.05, 0);
        lamps(hl - 0.02, -hl + 0.02, 1.3, Wd / 2 - 0.5);
        faceY = H + 0.02; faceX = 0.05;
        break;
      }
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
    const turret = new THREE.Group(); turret.position.set(c.shape.turret, H + 0.05, 0); turret.rotation.order = 'YZX'; root.add(turret);
    const ringM = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.62, 0.72, 0.22, 16)), metal); ringM.position.y = 0.06; ringM.castShadow = true; turret.add(ringM);
    const tb = (w, h, d, m, x, y, z) => { const o = new THREE.Mesh(this.track(roundBox(w, h, d, Math.min(0.18, w * 0.3, h * 0.35, d * 0.3))), m); o.position.set(x, y, z); o.castShadow = true; turret.add(o); return o; };
    const dome = (r, sy, m, x, y) => { const o = new THREE.Mesh(this.track(new THREE.SphereGeometry(r, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2)), m); o.scale.y = sy; o.position.set(x, y, 0); o.castShadow = true; turret.add(o); return o; };
    const muzzle = (r, x, y, z, col) => { const o = new THREE.Mesh(this.track(new THREE.CylinderGeometry(r * 1.35, r * 1.35, 0.18, 10)), col || metal); o.rotation.z = Math.PI / 2; o.position.set(x, y, z); turret.add(o); };
    const barrel = (r, l, m, x, y, z) => { const o = new THREE.Mesh(this.track(new THREE.CylinderGeometry(r, r, l, 8)), m); o.rotation.z = Math.PI / 2; o.position.set(x + l / 2, y, z); o.castShadow = true; turret.add(o); return o; };
    switch (wId) {
      case 'mg': dome(0.5, 0.7, dark, 0, 0.12); barrel(0.07, 1.7, metal, 0.25, 0.28, 0.17); barrel(0.07, 1.7, metal, 0.25, 0.28, -0.17); muzzle(0.07, 1.95, 0.28, 0.17); muzzle(0.07, 1.95, 0.28, -0.17); break;
      case 'burst': {
        const cyanM = this.mat({ color: '#6ee7ff', emissive: '#1e6e88', roughness: 0.25 }, 'Standard');
        tb(0.88, 0.44, 0.85, dark, 0, 0.3, 0);
        barrel(0.095, 1.95, metal, 0.35, 0.32, 0.22); barrel(0.095, 1.95, metal, 0.35, 0.32, -0.22);
        muzzle(0.095, 2.3, 0.32, 0.22, cyanM); muzzle(0.095, 2.3, 0.32, -0.22, cyanM);
        break;
      }
      case 'minigun': dome(0.52, 0.75, dark, 0, 0.12); { const drum = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.2, 0.2, 0.5, 12)), metal); drum.rotation.z = Math.PI / 2; drum.position.set(0.55, 0.32, 0); turret.add(drum); }
        for (let k = 0; k < 6; k++) barrel(0.045, 1.5, black, 0.6, 0.32 + Math.sin(k * 1.047) * 0.12, Math.cos(k * 1.047) * 0.12); break;
      case 'cannon': {
        const sh = new THREE.Shape([[-1.0, 0], [0.75, 0], [1.05, 0.25], [0.7, 0.62], [-0.85, 0.62], [-1.05, 0.35]].map(([a, b]) => new THREE.Vector2(a, b)));
        const g = this.track(new THREE.ExtrudeGeometry(sh, { depth: 1.3, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.12, bevelOffset: -0.12, bevelSegments: 3 })); g.translate(0, 0, -0.65);
        const o = new THREE.Mesh(g, dark); o.position.y = 0.1; o.castShadow = true; turret.add(o);
        barrel(0.17, 2.6, metal, 0.9, 0.42, 0); muzzle(0.17, 3.45, 0.42, 0); dome(0.25, 0.6, paint, -0.35, 0.72); break;
      }
      case 'plasma': {
        const plasmaM = this.mat({ color: '#d580ff', emissive: '#7a22b8', roughness: 0.2, metalness: 0.5 }, 'Standard');
        dome(0.58, 0.78, dark, -0.05, 0.14);
        barrel(0.16, 2.1, metal, 0.3, 0.36, 0);
        for (const x of [0.75, 1.3, 1.85]) muzzle(0.16, x, 0.36, 0, plasmaM);
        dome(0.26, 0.6, plasmaM, -0.05, 0.52);
        break;
      }
      case 'rocket': {
        tb(1.15, 0.6, 1.3, dark, 0.05, 0.45, 0);
        const orange = this.mat({ color: '#ff7b39', emissive: '#7a2a08', roughness: 0.4 }, 'Standard');
        for (const [y, z] of [[0.33, 0.3], [0.33, -0.3], [0.58, 0.3], [0.58, -0.3]]) { barrel(0.12, 0.35, metal, 0.5, y, z); const tip = new THREE.Mesh(this.track(new THREE.SphereGeometry(0.1, 8, 6)), orange); tip.position.set(0.88, y, z); turret.add(tip); }
        break;
      }
      case 'shotgun': dome(0.55, 0.7, dark, 0, 0.12); barrel(0.2, 1.4, metal, 0.25, 0.32, 0); muzzle(0.2, 1.6, 0.32, 0); break;
      case 'railgun': {
        const goldM = this.mat({ color: '#ffd700', emissive: '#805a00', metalness: 0.92, roughness: 0.18 }, 'Standard');
        const coreM = this.mat({ color: '#fff4a8', emissive: '#ffae00' }, 'Standard');
        tb(1.15, 0.52, 0.95, goldM, -0.1, 0.35, 0);
        tb(2.7, 0.11, 0.46, goldM, 1.35, 0.46, 0);
        tb(2.7, 0.11, 0.46, goldM, 1.35, 0.24, 0);
        barrel(0.08, 2.55, coreM, 0.15, 0.35, 0);
        break;
      }
    }
    // Geister-Umriss für den Spieler (sichtbar durch Häuser)
    if (c.isPlayer) {
      const ghost = new THREE.Mesh(this.track(new THREE.BoxGeometry(L, H, Wd)), this.track(new THREE.MeshBasicMaterial({ color: '#9fc4ff', blending: THREE.AdditiveBlending, opacity: 0.5, depthFunc: THREE.GreaterDepth, depthWrite: false })));
      // nur dort sichtbar, wo Häuser davor stehen: vor dem Auto (renderOrder 10) zeichnen, additiv
      ghost.position.y = H / 2; ghost.renderOrder = 5; ghost.userData.ghost = true; root.add(ghost);
    }
    // Flagge, wenn getragen
    const fl = new THREE.Group();
    const pole = new THREE.Mesh(this.track(new THREE.CylinderGeometry(0.08, 0.08, 3.5, 6)), this.mat({ color: '#eee' })); pole.position.y = 1.75; fl.add(pole);
    const cloth = new THREE.Mesh(this.track(new THREE.PlaneGeometry(2, 1.3)), this.mat({ color: '#fff', side: THREE.DoubleSide }));
    cloth.geometry.translate(1, 0, 0); cloth.position.y = 2.9; fl.add(cloth);
    fl.position.set(-L / 2 + 0.3, H, 0); fl.visible = false; root.add(fl);
    root.traverse(o => { if (o.isMesh) { o.receiveShadow = true; if (!o.userData.ghost) o.renderOrder = 10; } });
    // Drehpunkt in der Wagenmitte: Saltos und Hangneigung drehen um den Schwerpunkt statt um die Räder
    const spin = new THREE.Group(), inner = new THREE.Group();
    spin.position.y = H * 0.5; inner.position.y = -H * 0.5;
    for (const ch of [...root.children]) inner.add(ch);
    spin.add(inner); root.add(spin);
    this.scene.add(root);
    return { root, spin, wheels, turret, face, ring, flag: fl, flagCloth: cloth, paint, flashOn: false, lastFlag: -2, weaponId: wId, team: c.team };
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
      // Drohne: knapp hinter und über dem Auto, steigt über Häuser im Weg. Blickpunkt weich nachgeführt (kein Zittern)
      const dts = dt || 0.016, kxy = 1 - Math.exp(-dts * 18), kz = 1 - Math.exp(-dts * 6);
      if (!this.camF || Math.hypot(this.camF.x - cx, this.camF.y - cy) > 25 || Math.abs(this.camF.z - cz) > 12) this.camF = { x: cx, y: cy, z: cz };
      else { this.camF.x += (cx - this.camF.x) * kxy; this.camF.y += (cy - this.camF.y) * kxy; this.camF.z += (cz - this.camF.z) * kz; }
      cx = this.camF.x; cy = this.camF.y; cz = this.camF.z;
      const yaw = G.viewYaw ?? G.camYaw, fx = Math.cos(yaw), fy = Math.sin(yaw), lp = G.lookPitch || 0;
      // nach oben schauen: Kamera tiefer und etwas näher, nach unten: höher
      const back = 12.5 / G.zoomMul * (1 - 0.25 * Math.max(0, lp) / 1.55), up = Math.max(1.4, (5.2 - Math.max(0, lp) * 2.4 - Math.min(0, lp) * 4) / G.zoomMul);
      const Wd = G.world;
      let need = cz + up;
      // im Tunnel / unter einer Brücke: unter der Decke bleiben und näher ran
      const under = Wd.ceilingAt(cx, cy, cz);
      // liegt irgendein Punkt zwischen Auto und Kamera im Tunnel (auf Fahrbahnhöhe)? -> unter der Decke bleiben, näher ran
      let tunCap = null;
      for (let s = 0; s <= 1.001; s += 0.1) {
        const t = Wd.tunnelAt(cx - fx * back * s, cy - fy * back * s);
        if (t && cz < t.ceil - 0.5) tunCap = Math.min(tunCap ?? 1e9, t.ceil - 0.8);
      }
      const bkWant = tunCap !== null ? Math.min(back, 7.5) : back;
      this.camBk = this.camBk == null ? bkWant : this.camBk + (bkWant - this.camBk) * Math.min(1, (dt || 0.016) * 4);
      const bk = this.camBk;
      for (let s = 0.2; s <= 1.001; s += 0.2) {
        const sx2 = cx - fx * bk * s, sy2 = cy - fy * bk * s;
        const b = Wd.buildingAt(sx2, sy2);
        if (b) need = Math.max(need, b.top + (b.rf ? b.rf.rise + 1.8 : 2.5));
        if (tunCap === null) need = Math.max(need, Wd.terrain(sx2, sy2) + 2.5);
      }
      if (tunCap !== null) need = Math.min(Math.max(need, cz + 2.2), tunCap);
      else if (under !== null) need = Math.min(need, under - 0.6);
      this.camH = this.camH == null ? need : this.camH + (need - this.camH) * Math.min(1, (dt || 0.016) * (need > this.camH ? 6 : 2.5));
      if (tunCap !== null && this.camH > tunCap) this.camH = tunCap;   // im Tunnel nie über der Decke
      cam.position.set(cx - fx * bk, this.camH, cy - fy * bk);
      // Blickrichtung: Grundneigung aufs Auto + Maus-Neigung, bis fast senkrecht nach oben
      const basePitch = Math.atan2(cz + 1.4 - this.camH, bk + 10);
      cam.rotation.order = 'YXZ';
      cam.rotation.set(clamp(basePitch + lp, -1.3, 1.32), -Math.PI / 2 - yaw, 0);
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
    const ndc = (this._ndc || (this._ndc = new THREE.Vector2())).set(sx / innerWidth * 2 - 1, -(sy / innerHeight) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const o = this.ray.ray.origin, d = this.ray.ray.direction;
    // über dem Horizont: in Blickrichtung weit nach vorne
    if (d.y > -0.02) { const l = Math.hypot(d.x, d.z) || 1; return { x: o.x + d.x / l * 150, y: o.z + d.z / l * 150 }; }
    let t = (h - o.y) / d.y;
    const hor = Math.hypot(d.x * t, d.z * t);
    if (hor > 150) t *= 150 / hor;
    return { x: o.x + d.x * t, y: o.z + d.z * t };
  }

  // Zielpunkt in 3D unter dem Fadenkreuz: Gegner (mit magnetischer Trackpad-Toleranz), Hauswand/Dach, Boden oder Himmel
  aimPoint(sx, sy, c) {
    const ndc = (this._ndc || (this._ndc = new THREE.Vector2())).set(sx / innerWidth * 2 - 1, -(sy / innerHeight) * 2 + 1);
    this.ray.setFromCamera(ndc, this.camera);
    const o = this.ray.ray.origin, d = this.ray.ray.direction, W = this.game.world;
    const assistOn = !!(this.game.opts && this.game.opts.autoAim);
    // erst hinter dem eigenen Auto anfangen (Strahl kommt von der Kamera dahinter)
    const t0 = Math.max(0, (c.x - o.x) * d.x + (c.z + 1 - o.y) * d.y + (c.y - o.z) * d.z);
    let best = null, bt = t0 + 260, bestScore = 1e9;
    for (const q of this.game.cars) {
      if (!q.alive || q === c || q.team === c.team) continue;
      const px = q.x - o.x, py = q.z + 0.95 - o.y, pz = q.y - o.z, t = px * d.x + py * d.y + pz * d.z;
      if (t < t0 || t > t0 + 260) continue;
      const baseTol = assistOn ? 3.8 : 2.4;
      const tol = baseTol + (t - t0) * (assistOn ? 0.042 : 0.025);
      const perpSq = Math.max(0, px * px + py * py + pz * pz - t * t);
      if (perpSq < tol * tol) {
        const score = Math.sqrt(perpSq) + (t - t0) * 0.018;
        if (score < bestScore) { bestScore = score; bt = t; best = q; }
      }
    }
    for (let t = t0 + 1.5; t < bt; t += 1.5) {
      const x = o.x + d.x * t, y = o.z + d.z * t, z = o.y + d.y * t;
      if (x < 0 || y < 0 || x > W.w || y > W.h) break;
      // eigenes Dach / Kante direkt vor dem Auto verdeckt kein anvisiertes Ziel dahinter
      const nearMe = best && (x - c.x) ** 2 + (y - c.y) ** 2 < 14 * 14;
      if (W.solidAt(x, y, z)) { if (nearMe) continue; return { x, y, z, kind: 'wall' }; }
      const gz = W.groundAt(x, y, z + 0.5);
      if (z < gz) { if (nearMe) continue; return { x, y, z: gz, kind: W.groundKind === 'roof' ? 'wall' : 'ground' }; }
    }
    if (best) return { x: best.x, y: best.y, z: best.z + 0.9, car: best, kind: 'car', aimDist: bestScore };
    const t = t0 + 220;
    return { x: o.x + d.x * t, y: o.z + d.z * t, z: o.y + d.y * t, kind: 'sky' };
  }

  // Auto wurde ersetzt (Nachjoinen / Bot übernimmt): altes Modell entfernen
  removeCar(c) {
    const m = this.cars.get(c);
    if (!m) return;
    this.scene.remove(m.root); this.cars.delete(c);
    // Geometrien/Materialien des alten Modells freigeben (Gun Game baut bei jedem Waffenwechsel neu)
    m.root.traverse(o => { if (o.isMesh) { if (o.geometry) o.geometry.dispose(); const mm = Array.isArray(o.material) ? o.material : [o.material]; for (const x of mm) if (x && x !== this.sky.material) x.dispose(); } });
  }
  // ---------------- Bild zeichnen ----------------
  render(dt, time) {
    const G = this.game;
    if (this.waterN) { this.waterN.offset.x += (dt || 0.016) * 0.012; this.waterN.offset.y += (dt || 0.016) * 0.007; }
    // Bildrate im Blick: bei dauerhaft < 40 FPS die Auflösung stufenweise senken
    this.slowT = Math.max(0, (this.slowT || 0) + (dt > 1 / 40 ? dt : -dt * 0.5));
    if (this.slowT > 2.5 && (this.dprCap || 2) > 1 && (window.devicePixelRatio || 1) > 1) { this.dprCap = Math.max(1, (this.dprCap || 2) - 0.25); this.slowT = 0; this.resize(); }
    const chaseCam = G.camMode === 'chase';
    const sx = chaseCam ? Math.sin(time * 29) * G.shake * 0.12 : (Math.random() - 0.5) * G.shake * 0.9;
    const sy = chaseCam ? Math.cos(time * 23) * G.shake * 0.12 : (Math.random() - 0.5) * G.shake * 0.9;
    const pz = G.player && G.player.alive ? G.player.z : G.world.terrain(G.cam.x, G.cam.y);
    this.placeCamera(G.cam.x + sx * (G.camMode === 'chase' ? 0.3 : 1), G.cam.y + sy * (G.camMode === 'chase' ? 0.3 : 1), G.camMode === 'chase' && G.player ? G.player.z : pz, dt);
    if (this.tunLights && this.tunLampPts && this.tunLampPts.length) {
      const fx = G.player && G.player.alive ? G.player.x : G.cam.x;
      const fy = G.player && G.player.alive ? G.player.y : G.cam.y;
      const picked = [];
      for (const lp of this.tunLampPts) {
        const d2 = (lp.x - fx) * (lp.x - fx) + (lp.y - fy) * (lp.y - fy);
        if (d2 >= 8100) continue;
        if (picked.length < 3 || d2 < picked[picked.length - 1].d2) {
          picked.push({ lp, d2 });
          picked.sort((a, b) => a.d2 - b.d2);
          if (picked.length > 3) picked.pop();
        }
      }
      for (let i = 0; i < this.tunLights.length; i++) {
        const pl = this.tunLights[i];
        if (i < picked.length) {
          const { lp, d2 } = picked[i];
          pl.position.set(lp.x, lp.z, lp.y);
          pl.intensity = 2.8 * clamp(1 - Math.max(0, Math.sqrt(d2) - 55) / 35, 0, 1);
        } else pl.intensity = 0;
      }
    }
    // sichtbarer Bereich (für Minikarte)
    if (!this.vrT || time - this.vrT > 0.25) {   // Sichtbereich (Minikarte) nur 4× pro Sekunde
      this.vrT = time;
      const pts = [[0, 0], [innerWidth, 0], [0, innerHeight], [innerWidth, innerHeight]].map(([x, y]) => this.screenToGround(x, y));
      G.viewRect = { x0: Math.min(...pts.map(p => p.x)), y0: Math.min(...pts.map(p => p.y)), x1: Math.max(...pts.map(p => p.x)), y1: Math.max(...pts.map(p => p.y)) };
    }
    // Bodentexturen mit Reifenspuren nachladen
    const now = performance.now();
    if (this.dirty.size && now - this.lastUpload > 1000) {
      const k = this.dirty.values().next().value; this.dirty.delete(k);
      const t = this.groundTex.get(k); if (t) t.needsUpdate = true;
      this.lastUpload = now;
    }
    // Autos
    for (const c of G.cars) {
      let m = this.cars.get(c);
      const curWId = c.weaponId || c.def.weapon;
      if (m && (m.weaponId !== curWId || m.team !== c.team)) { this.removeCar(c); m = null; }
      if (!m) { m = this.makeCar(c); this.cars.set(c, m); }
      const vis = c.alive && !(c.protect > 0 && Math.sin(time * 20) < -0.3);
      m.root.visible = vis;
      if (!c.alive) continue;
      m.root.position.set(c.x, c.z, c.y);
      m.root.rotation.order = 'YZX';
      m.root.rotation.y = -c.a;
      // am Hang kippen (Nicken + Rollen), in der Luft leicht nach Flugbahn + aktivem Air-Roll
      const ca = Math.cos(c.a), sa = Math.sin(c.a), sxs = c.slopeX || 0, sys = c.slopeY || 0;
      const air = c.onGround === false || Math.abs(c.pitch || 0) > 0.05 || Math.abs(c.roll || 0) > 0.05;
      const roll = air ? (c.roll || 0) : -Math.atan(-sxs * sa + sys * ca);
      if (air && Math.abs(c.pitch || 0) > 0.05) m.pitch = clamp(c.vz * 0.02, -0.3, 0.3) + c.pitch;   // Salto / Luftneigung: direkt folgen
      else {
        const pitch = air ? clamp(c.vz * 0.02, -0.3, 0.3) : Math.atan(sxs * ca + sys * sa);
        m.pitch = angNorm(m.pitch || 0); m.pitch += (pitch - m.pitch) * 0.25;
      }
      m.roll = angNorm(m.roll || 0);
      m.roll += angNorm(roll - m.roll) * (air ? 0.35 : 0.25);
      m.spin.rotation.order = 'XZY'; m.spin.rotation.z = m.pitch; m.spin.rotation.x = m.roll;
      m.turret.rotation.y = -(c.turret - c.a); m.turret.rotation.z = c.tpitch || 0;
      // Räder drehen (auf eigenem spin-Pivot) und vorne in die echte Lenkrichtung einlenken
      const vfw = c.vx * ca + c.vy * sa;
      for (const w of m.wheels) {
        (w.spin || w.g).rotation.z -= vfw * dt / w.r;
        if (w.front) w.g.rotation.y = -(c.steerS || 0) * 0.45;
      }
      // Gesicht immer „aufrecht“ zur Kamera
      m.face.rotation.y = c.a - Math.PI / 2 - (G.camMode === 'chase' ? (G.viewYaw ?? G.camYaw) : -Math.PI / 2);
      const flash = c.flashT > 0;
      if (flash !== m.flashOn) { m.paint.emissive.set(flash ? '#ffffff' : '#000000'); m.flashOn = flash; }
      if (c.flag !== m.lastFlag) {
        m.flag.visible = c.flag >= 0 && G.gameMode === 'ctf';
        if (c.flag >= 0) m.flagCloth.material.color.set(TEAM[c.flag % TEAM.length].color);
        m.lastFlag = c.flag;
      }
      if (c.flag >= 0) m.flagCloth.rotation.y = Math.sin(time * 9) * 0.35 + 0.2;
    }
    // Flaggen am Boden (nur in Capture the Flag sichtbar)
    this.game.flags.forEach((f, i) => {
      const grp = this.flags[i];
      grp.visible = G.gameMode === 'ctf' && f.state !== 'carried';
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
      o.userData.light.material.color.set(mi.arm > 0 ? '#888' : (Math.sin(time * 10) > 0 ? TEAM[mi.team % TEAM.length].color : '#222'));
      n++;
    }
    for (let i = n; i < this.pool.mine.length; i++) this.pool.mine[i].visible = false;
    // Geschosse
    const bm = this.bulletMesh, d = this.dummy;
    let bi = 0;
    for (const b of G.bullets) {
      if (bi >= 1200) break;
      const ang = Math.atan2(b.vy, b.vx);
      d.position.set(b.x, b.z, b.y); d.rotation.order = 'YZX'; d.rotation.set(0, -ang, Math.atan2(b.vz || 0, Math.hypot(b.vx, b.vy)));
      if (b.w === WEAPONS.rocket) d.scale.set(1.3, 0.35, 0.35);
      else if (b.w === WEAPONS.cannon || b.w === WEAPONS.plasma) d.scale.set(0.85, 0.85, 0.85);
      else if (b.w === WEAPONS.railgun) d.scale.set(3.8, 0.36, 0.36);
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
    if (this.sky) { this.sky.position.copy(this.camera.position); this.sky.updateMatrixWorld(); }
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
    if (add) {
      // weiches Leuchten (Bloom-Ersatz): Halo um Geschosse und Nitro-Flammen
      const glow = (x, y, z, size, col, a) => {
        if (i >= 1700) return;
        P[i * 3] = x; P[i * 3 + 1] = z; P[i * 3 + 2] = y;
        const cc = R3.col(col); C[i * 3] = cc.r; C[i * 3 + 1] = cc.g; C[i * 3 + 2] = cc.b; S[i] = size; A[i] = a; i++;
      };
      for (const b of this.game.bullets) {
        const big = b.w === WEAPONS.rocket ? 3.4 : (b.w === WEAPONS.cannon || b.w === WEAPONS.plasma || b.w === WEAPONS.railgun) ? 2.8 : 1.3;
        glow(b.x, b.y, b.z, big, b.w === WEAPONS.rocket ? '#ff7a30' : b.w === WEAPONS.cannon ? '#ffc060' : b.w.color, 0.55);
      }
      const tm = performance.now() / 60;
      for (const c of this.game.cars) {
        if (!c.alive || !c.boosting) continue;
        const L = c.def.len * 0.55, fx = Math.cos(c.a), fy = Math.sin(c.a);
        glow(c.x - fx * L, c.y - fy * L, c.z + 0.7, 2.6 + Math.sin(tm + c.id) * 0.5, '#6fd0ff', 0.6);
        glow(c.x - fx * (L + 0.8), c.y - fy * (L + 0.8), c.z + 0.7, 1.3, '#ffffff', 0.7);
      }
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
