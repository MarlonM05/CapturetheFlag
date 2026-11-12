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
  face(id) {
    let t = this.faceTex.get(id);
    if (!t) { t = new THREE.Texture(DRIVER_IMG[id]); t.needsUpdate = true; this.faceTex.set(id, t); }
    return t;
  },
};

const CAR_H = { sport: 1.15, buggy: 1.3, tank: 1.55, jeep: 1.6, truck: 1.85 };

class Renderer3D {
  constructor(game, canvas) {
    this.game = game; this.canvas = canvas;
    this.gl = R3.renderer(canvas);
    canvas.style.display = 'block';
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color('#a9cbe6');
    this.scene.fog = new THREE.Fog('#a9cbe6', 170, 430);
    this.camera = new THREE.PerspectiveCamera(42, 1, 1, 1500);
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
    s.add(new THREE.HemisphereLight('#f4f8ff', '#77705a', 0.68));
    const sun = this.sun = new THREE.DirectionalLight('#fff3dc', 0.85);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -95; sc.right = 95; sc.top = 95; sc.bottom = -95; sc.near = 10; sc.far = 400;
    sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.04;
    s.add(sun); s.add(sun.target);
  }

  // ---------------- Boden (aus den 2D-Kacheln) ----------------
  buildGround() {
    const W = this.game.world;
    const T = Math.ceil(Math.max(W.w, W.h) / 2) + 2;
    const PX = 2048, Z = PX / T;
    W.tiles = new Map(); W.tileZ = Z; W.tileM = T;
    this.groundTex = new Map(); this.dirty = new Set(); this.lastUpload = 0;
    const aniso = this.gl.capabilities.getMaxAnisotropy();
    for (let ty = 0; ty * T < W.h; ty++) for (let tx = 0; tx * T < W.w; tx++) {
      const cv = W.renderTile(tx, ty, Z, { px: PX, flat3d: true });
      W.tiles.set(tx + ',' + ty, cv);
      const tex = this.track(new THREE.CanvasTexture(cv));
      tex.anisotropy = aniso;
      this.groundTex.set(tx + ',' + ty, tex);
      const m = new THREE.Mesh(this.track(new THREE.PlaneGeometry(T, T)), this.mat({ map: tex }));
      m.rotation.x = -Math.PI / 2;
      m.position.set(tx * T + T / 2, 0, ty * T + T / 2);
      m.receiveShadow = true;
      this.scene.add(m);
    }
    W.onDecal = (tx, ty) => this.dirty.add(tx + ',' + ty);
    // Umland
    const out = new THREE.Mesh(this.track(new THREE.PlaneGeometry(4000, 4000)), this.mat({ color: '#4c5a3d' }));
    out.rotation.x = -Math.PI / 2; out.position.set(W.w / 2, -0.08, W.h / 2);
    this.scene.add(out);
    // Wasser als glänzende Fläche
    for (const w of W.water) {
      const geo = this.polyGeo(w.p, 0.06);
      if (!geo) continue;
      const m = new THREE.Mesh(geo, this.mat({ color: '#2f6db0', specular: '#cfe6ff', shininess: 90, transparent: true, opacity: 0.82 }, 'Phong'));
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

  // ---------------- Gebäude: ein einziges Mesh mit Satteldächern ----------------
  buildBuildings() {
    const pos = [], col = [];
    const push = (x, h, y, c) => { pos.push(x, h, y); col.push(c.r, c.g, c.b); };
    const tri = (a, b, c, color) => { push(a[0], a[1], a[2], color); push(b[0], b[1], b[2], color); push(c[0], c[1], c[2], color); };
    const quad = (a, b, c, d, color) => { tri(a, b, c, color); tri(a, c, d, color); };
    for (const b of this.game.world.buildings) {
      const p = b.p, n = p.length / 2, h = b.h;
      const wall = R3.col(b.wall), roof = R3.col(b.roof);
      const wallDark = wall.clone().multiplyScalar(0.9);
      // Wände
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = p[i * 2], ay = p[i * 2 + 1], bx = p[j * 2], by = p[j * 2 + 1];
        quad([ax, 0, ay], [bx, 0, by], [bx, h, by], [ax, h, ay], i % 2 ? wall : wallDark);
      }
      // Dach
      if (!b.flat && n === 4) {
        // Satteldach entlang der längeren Seite
        let k = 0;
        const len = i => Math.hypot(p[((i + 1) % 4) * 2] - p[i * 2], p[((i + 1) % 4) * 2 + 1] - p[i * 2 + 1]);
        if (len(1) > len(0)) k = 1;
        const P = i => [p[((i + k) % 4) * 2], p[((i + k) % 4) * 2 + 1]];
        const [p0, p1, p2, p3] = [P(0), P(1), P(2), P(3)];
        const rh = h + Math.min(4.5, len((k + 1) % 4) * 0.42);
        const r0 = [(p0[0] + p3[0]) / 2, rh, (p0[1] + p3[1]) / 2], r1 = [(p1[0] + p2[0]) / 2, rh, (p1[1] + p2[1]) / 2];
        const q = v => [v[0], h, v[1]];
        quad(q(p0), q(p1), r1, r0, roof);
        quad(q(p2), q(p3), r0, r1, roof.clone().multiplyScalar(0.82));
        tri(q(p3), q(p0), r0, wall); tri(q(p1), q(p2), r1, wall);
      } else if (!b.flat && n <= 10 && this.convex(p)) {
        // Walmdach zur Mitte
        let A = 0; for (let i = 0; i < n; i++) { const j = (i + 1) % n; A += p[i * 2] * p[j * 2 + 1] - p[j * 2] * p[i * 2 + 1]; }
        const rh = h + Math.min(4, Math.sqrt(Math.abs(A / 2)) * 0.22 + 1.2);
        const apex = [b.cx, rh, b.cy];
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          tri([p[i * 2], h, p[i * 2 + 1]], [p[j * 2], h, p[j * 2 + 1]], apex, i % 2 ? roof : roof.clone().multiplyScalar(0.85));
        }
      } else {
        // Flachdach
        const pts = [];
        for (let i = 0; i < n; i++) pts.push(new THREE.Vector2(p[i * 2], p[i * 2 + 1]));
        let tris = [];
        try { tris = THREE.ShapeUtils.triangulateShape(pts, []); } catch (e) { /* egal */ }
        const rc = b.c === 4 ? R3.col('#8f9396') : roof;
        for (const t of tris) tri([pts[t[0]].x, h, pts[t[0]].y], [pts[t[2]].x, h, pts[t[2]].y], [pts[t[1]].x, h, pts[t[1]].y], rc);
      }
    }
    const g = this.track(new THREE.BufferGeometry());
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, this.mat({ vertexColors: true, side: THREE.DoubleSide }));
    m.castShadow = true; m.receiveShadow = true;
    this.scene.add(m);
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
    const T = this.game.world.trees;
    if (!T.length) return;
    const trunk = new THREE.InstancedMesh(this.track(new THREE.CylinderGeometry(0.22, 0.32, 1, 6)), this.mat({ color: '#5b4630' }), T.length);
    const crown = new THREE.InstancedMesh(this.track(new THREE.IcosahedronGeometry(1, 1)), this.mat({ color: '#ffffff', flatShading: true }), T.length);
    const shades = ['#3f7a35', '#4b8a3a', '#36702f'];
    const d = this.dummy;
    T.forEach((t, i) => {
      d.position.set(t.x, t.h * 0.3, t.y); d.rotation.set(0, 0, 0); d.scale.set(1, t.h * 0.6, 1); d.updateMatrix();
      trunk.setMatrixAt(i, d.matrix);
      d.position.set(t.x, t.h * 0.68, t.y); d.rotation.set(0, i, 0); d.scale.set(t.r, t.r * 1.15, t.r); d.updateMatrix();
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
      const L = r.len, Wd = r.wid, H = 1.5;
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
      m.position.set(r.x, 0, r.y); m.rotation.y = -r.a;
      m.castShadow = true; m.receiveShadow = true;
      this.scene.add(m);
    }
    // Basen: leuchtende Ringe
    W.bases.forEach((b, i) => {
      const ring = new THREE.Mesh(this.track(new THREE.RingGeometry(10.2, 11.2, 48)), this.track(new THREE.MeshBasicMaterial({ color: TEAM[i].color, transparent: true, opacity: 0.85, side: THREE.DoubleSide })));
      ring.rotation.x = -Math.PI / 2; ring.position.set(b.x, 0.08, b.y);
      this.scene.add(ring);
      const glow = new THREE.Mesh(this.track(new THREE.CylinderGeometry(11, 11, 3, 48, 1, true)), this.track(new THREE.MeshBasicMaterial({ color: TEAM[i].color, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false })));
      glow.position.set(b.x, 1.5, b.y);
      this.scene.add(glow);
    });
    // Kisten
    const boxG = this.track(new THREE.BoxGeometry(1, 1, 1));
    const propMats = PROP.map(pr => this.mat({ color: pr.top }));
    this.props = this.game.props.map(p => {
      const m = new THREE.Mesh(boxG, propMats[p.t]);
      m.scale.set(p.hw * 2, p.h, p.hh * 2);
      m.position.set(p.x, p.h / 2, p.y); m.rotation.y = -p.a;
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
    const box = (w, h, d, m, x, y, z) => { const o = new THREE.Mesh(this.track(new THREE.BoxGeometry(w, h, d)), m); o.position.set(x, y, z); o.castShadow = true; body.add(o); return o; };
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
    const face = new THREE.Mesh(faceG, this.track(new THREE.MeshBasicMaterial({ map: R3.face(c.driver.id) })));
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
    this.scene.add(root);
    return { root, turret, face, ring, flag: fl, flagCloth: cloth, paint, flashOn: false, lastFlag: -2 };
  }

  // ---------------- Kamera / Projektion ----------------
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.gl.setPixelRatio(dpr);
    this.gl.setSize(innerWidth, innerHeight, false);
    this.camera.aspect = innerWidth / innerHeight;
    // auf schmalen Hochkant-Bildschirmen weiter weg
    this.camera.fov = innerWidth < innerHeight ? 58 : 42;
    this.camera.updateProjectionMatrix();
    const h = innerHeight * dpr;
    this.pNormal.material.uniforms.scale.value = this.pAdd.material.uniforms.scale.value = h / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2));
  }
  placeCamera(cx, cy, cz) {
    const d = this.camDist / this.game.zoomMul;
    const cam = this.camera;
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
    if (Math.abs(d.y) < 1e-4) return { x: o.x, y: o.z };
    const t = (h - o.y) / d.y;
    return { x: o.x + d.x * t, y: o.z + d.z * t };
  }

  // ---------------- Bild zeichnen ----------------
  render(dt, time) {
    const G = this.game;
    const sx = (Math.random() - 0.5) * G.shake * 0.9, sy = (Math.random() - 0.5) * G.shake * 0.9;
    const pz = G.player && G.player.alive ? Math.min(G.player.z, 8) * 0.6 : 0;
    this.placeCamera(G.cam.x + sx, G.cam.y + sy, pz);
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
      m.root.rotation.y = -c.a;
      // leichtes Kippen in der Luft
      m.root.rotation.z = c.onGround === false ? clamp(c.vz * 0.02, -0.25, 0.25) : 0;
      m.turret.rotation.y = -(c.turret - c.a);
      m.face.rotation.y = c.a; m.ring.rotation.z = 0;
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
      grp.position.set(f.x, 0, f.y);
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
      o.position.set(p.x, 1.2 + Math.sin(time * 3 + p.x) * 0.25, p.y);
      o.rotation.set(p.t === 2 ? Math.PI / 2 : 0, time * 1.5, 0);
      n++;
    }
    for (let i = n; i < this.pool.pick.length; i++) this.pool.pick[i].visible = false;
    // Minen
    n = 0;
    for (const mi of G.mines) {
      let o = this.pool.mine[n];
      if (!o) { o = new THREE.Group(); o.add(new THREE.Mesh(this.mineGeo, this.mineMat)); const l = new THREE.Mesh(this.mineLight, this.track(new THREE.MeshBasicMaterial({ color: '#f00' }))); l.position.y = 0.25; o.userData.light = l; o.add(l); this.scene.add(o); this.pool.mine[n] = o; }
      o.visible = true; o.position.set(mi.x, 0.15, mi.y);
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
      else d.scale.set(1.8, 0.16, 0.16);
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
      const h = p.z !== undefined ? p.z + 0.4 : (p.type === 'spark' ? 1 : p.add ? 1.2 : 1.5);
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
