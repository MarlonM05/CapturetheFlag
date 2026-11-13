"""Baut die zusammenhängende Karte „Schussental“ (Ravensburg + Weingarten) für das Spiel.

Aufruf:  python build_world.py <osm-ordner> <ausgabe maps.js> [preview.png]

Erwartet ravensburg.osm und weingarten.osm (Export von api.openstreetmap.org/api/0.6/map):
  ravensburg: bbox 9.6075,47.7772,9.6195,47.7840
  weingarten: bbox 9.6375,47.8055,9.6490,47.8112
Kartendaten (c) OpenStreetMap-Mitwirkende, ODbL.

Aufbau (Spiel-Koordinaten in Metern, x nach Osten, y nach Süden):
  Weingarten oben rechts (Team Rot, Basis Münsterplatz vor der Basilika),
  Ravensburg unten links (Team Blau, Basis Marienplatz am Blaserturm),
  dazwischen das Schussental mit Fluss, Brücken, Überführung, Tunnelhügel.
"""
import base64
import json
import math
import random
import sys

import numpy as np
from scipy import ndimage
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import unary_union

import build_maps as bm

bm.SCALE = 1.15
bm.BLOCK_INSET = 1.6
bm.ROAD_EXTRA = 2.0
bm.TREE_KEEP = 0.4

# Ravensburg: Ausschnitt eng um die Altstadt, stärker vergrößert und mit breiteren Gassen (gut befahrbar)
RV = dict(id="ravensburg", name="Ravensburg", sub="", bbox=(9.60758, 47.77783, 9.61801, 47.7840), bases_m=[(100, 100), (500, 300)],
          scale=1.32, inset=2.4, road_extra=4.0)
# Wahrzeichen der Ravensburger Altstadt nach OSM-Namen: Typ, Stil, Höhe (m, vor Skalierung egal – echte Höhe)
RV_LANDMARKS = {
    "Blaserturm": dict(t="blaserturm"), "Mehlsack": dict(t="mehlsack"), "Veitsburg": dict(t="veitsburg", a=0.35),
    "Grüner Turm": dict(t="turm", s="gruen", h=30), "Frauentor": dict(t="turm", s="treppe", h=35),
    "Untertor": dict(t="turm", s="zelt", h=36), "Spitalturm": dict(t="turm", s="helm", h=44), "Obertor": dict(t="turm", s="treppe", h=28),
    "Liebfrauenkirche": dict(t="kirche", h=20, th=52), "Evangelische Stadtkirche": dict(t="kirche", h=18, th=42),
}
WG = dict(id="weingarten", name="Weingarten", sub="", bbox=(9.6375, 47.8055, 9.6490, 47.8112), bases_m=[(100, 100), (500, 300)])
OFF = {"ravensburg": (0.0, 948.0), "weingarten": (300.0, 0.0)}
RES = 4.0                  # Raster der Höhenkarte in Metern
CEIL = 7.5                 # Tunnel-Lichte Höhe
R1 = lambda v: round(v, 1)


def flat(coords):
    out = []
    for x, y in coords:
        out += [R1(x), R1(y)]
    return out


def shift(p, ox, oy):
    return [R1(v + (ox if i % 2 == 0 else oy)) for i, v in enumerate(p)]


# ---------------------------------------------------------------------------
# Synthetische Straßen im Schussental (globale Koordinaten)
# ---------------------------------------------------------------------------
RIVER = [(-20, 880), (120, 868), (260, 878), (420, 862), (600, 874), (780, 860), (960, 876), (1120, 864), (1320, 872)]
RIVER_W = 24.0
ROUTES = [
    # name, Breite, Klasse, Punkte
    ("Schussentalstraße", 18, 0, [(194, 935), (214, 905), (236, 878), (252, 850), (270, 815), (296, 784), (318, 758), (333, 734)]),
    ("B30", 18, 0, [(653, 945), (642, 912), (628, 880), (616, 850), (604, 818), (592, 790), (575, 762), (552, 746), (535, 738)]),
    ("Querspange", 16, 0, [(296, 780), (400, 782), (500, 786), (593, 788), (690, 786), (800, 780), (900, 774), (983, 750)]),
    ("Höhenweg", 12, 1, [(1052, 1094), (1090, 1096), (1125, 1098), (1165, 1100), (1205, 1080), (1236, 1040), (1240, 990), (1222, 950), (1190, 925), (1170, 912)]),
    ("Tunnelstraße", 14, 0, [(1052, 1283), (1100, 1290), (1140, 1290), (1165, 1270), (1165, 1220), (1165, 1100), (1165, 980), (1166, 930), (1170, 900), (1172, 870), (1175, 830), (1177, 790), (1178, 745)]),
    ("Martinsberg-Höhe", 11, 1, [(280, 249), (220, 250), (160, 275), (120, 330), (105, 400), (110, 470), (135, 540), (170, 590)]),
    ("Westflanke", 11, 1, [(280, 586), (220, 596), (170, 610), (135, 650), (112, 710), (102, 780), (100, 835)]),
    ("Westflanke Süd", 11, 1, [(122, 912), (124, 935), (126, 972)]),
]
# Brücken (Fluss) und Überführung: Straße, Kreuzungspunkt, halbe Spannweite, Rampenlänge, Höhe über Tal
TUNNEL_HILL = (1165.0, 1100.0, 36.0, 105.0, 2.6)   # x, y, Höhe, Radius, Exponent
HILLS = [
    (880.0, 268.0, 16.0, 175.0, 2.0),    # Martinsberg (Basilika)
    (790.0, 1705.0, 30.0, 92.0, 2.4),    # Veitsburg
    (120.0, 330.0, 18.0, 190.0, 2.0),    # Hügel im Nordwesten
]
JUMP_RAMPS = [  # x, y, Richtung (Fluss überspringen)
    (100.0, 846.0, math.pi / 2),
    (124.0, 905.0, -math.pi / 2),
]
LANDMARKS = [
    dict(t="basilika", x=900.0, y=262.0, a=0.0),
]   # Ravensburger Wahrzeichen kommen in main() aus den OSM-Daten dazu
BASES = [(818.0, 262.0), (540.0, 1268.0)]   # Rot (Weingarten, auf dem Basilika-Vorplatz), Blau (Ravensburg)
# Basilika-Vorplatz: gepflasterte Terrasse auf Fassadenhöhe mit geschwungenen Stützmauern und zwei breiten Rampen
TERRACE = dict(x0=790.0, x1=851.0, y0=194.0, y1=330.0, r=22.0)
TERRACE_RAMPS = [((792.0, 214.0), (752.0, 196.0), 14.0), ((792.0, 310.0), (752.0, 328.0), 14.0)]


def terrace_poly():
    t = TERRACE
    return box(t["x0"], t["y0"], t["x1"], t["y1"]).buffer(-t["r"]).buffer(t["r"], resolution=8)


def terrace_area():
    return unary_union([terrace_poly()] + [LineString([a, b]).buffer(w / 2 + 1.5, cap_style=2) for a, b, w in TERRACE_RAMPS])


def landmark_boxes(lm):
    """Kollisions-Grundrisse (lokal: dx, dy, Breite, Tiefe, Höhe) der Wahrzeichen."""
    t = lm["t"]
    if t == "basilika":
        return [(0, 0, 100, 26, 24), (12, 0, 24, 46, 24), (-46, -14, 11, 11, 58), (-46, 14, 11, 11, 58), (12, 0, 16, 16, 44), (-55, 0, 10, 17, 30)]
    if t == "blaserturm":
        return [(0, 0, 8, 8, 52)]
    if t == "mehlsack":
        return [("round", 0, 0, 6.2, 51)]
    if t == "veitsburg":
        return [(0, 0, 30, 13, 13), (-11, -4, 7, 7, 24)]
    if t == "turm":
        return [(0, 0, lm["w"], lm["d"], lm["h"])]
    if t == "kirche":
        L, Wd, tw = lm["L"], lm["W"], lm["tw"]
        return [(tw / 2, 0, L - tw, Wd, lm["h"]), (-L / 2 + tw / 2, 0, tw, tw, lm["th"])]
    return []


def rv_landmarks(osm_dir):
    """Lage, Größe und Ausrichtung der Altstadt-Wahrzeichen aus den OSM-Grundrissen (Weltkoordinaten)."""
    import xml.etree.ElementTree as ET
    minlon, minlat, maxlon, maxlat = RV["bbox"]
    kx = 111320 * math.cos(math.radians((minlat + maxlat) / 2)); ky = 110540; sc = RV["scale"]; ox, oy = OFF["ravensburg"]
    P = lambda lon, lat: (ox + (lon - minlon) * kx * sc, oy + (maxlat - lat) * ky * sc)
    root = ET.parse(f"{osm_dir}/ravensburg.osm").getroot()
    nodes = {n.get("id"): (float(n.get("lon")), float(n.get("lat"))) for n in root.iter("node")}
    out, square = [], None
    for w in root.iter("way"):
        tags = {c.get("k"): c.get("v") for c in w if c.tag == "tag"}
        nm = tags.get("name")
        pts = [P(*nodes[nd.get("ref")]) for nd in w if nd.tag == "nd" and nd.get("ref") in nodes]
        if nm == "Marienplatz" and tags.get("place") == "square" and len(pts) > 3:
            square = Polygon(pts).centroid
        if nm not in RV_LANDMARKS or len(pts) < 4:
            continue
        if any(o["name"] == nm for o in out):
            continue
        poly = Polygon(pts)
        if not poly.is_valid or poly.area < 10:
            continue
        rect = list(poly.minimum_rotated_rectangle.exterior.coords)[:4]
        e1 = (rect[1][0] - rect[0][0], rect[1][1] - rect[0][1]); e2 = (rect[2][0] - rect[1][0], rect[2][1] - rect[1][1])
        l1, l2 = math.hypot(*e1), math.hypot(*e2)
        long_e = e1 if l1 >= l2 else e2
        a = math.atan2(long_e[1], long_e[0])
        L, Wd = max(l1, l2), min(l1, l2)
        c = poly.centroid
        spec = dict(RV_LANDMARKS[nm])
        lm = dict(t=spec["t"], x=R1(c.x), y=R1(c.y), a=round(spec.get("a", a), 3), name=nm)
        if spec["t"] == "turm":
            side = max(9.0, min(14.0, (L + Wd) / 2))
            lm.update(w=R1(side), d=R1(side), h=spec["h"], s=spec["s"])
        elif spec["t"] == "kirche":
            # Turm an das westliche Ende
            if math.cos(a) < 0:   # lokal +x zeigt nach Osten (Chor), Turm im Westen
                a += math.pi
            lm.update(a=round(math.atan2(math.sin(a), math.cos(a)), 3), L=R1(max(30, L)), W=R1(max(14, Wd)), tw=R1(min(12, max(9, Wd * 0.55))), h=spec["h"], th=spec["th"])
        out.append(lm)
    for lm in out:
        lm.pop("name", None)
    return out, square


def lm_polys(lm):
    out = []
    ca, sa = math.cos(lm["a"]), math.sin(lm["a"])
    for b in landmark_boxes(lm):
        if b[0] == "round":
            _, dx, dy, r, h = b
            pts = [(lm["x"] + dx + r * math.cos(k * math.pi / 8), lm["y"] + dy + r * math.sin(k * math.pi / 8)) for k in range(16)]
        else:
            dx, dy, w, d, h = b
            pts = []
            for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                lx, ly = dx + sx * w / 2, dy + sy * d / 2
                pts.append((lm["x"] + lx * ca - ly * sa, lm["y"] + lx * sa + ly * ca))
        out.append((Polygon(pts), h))
    return out


# ---------------------------------------------------------------------------
def main():
    osm_dir, out_js = sys.argv[1], sys.argv[2]
    preview = sys.argv[3] if len(sys.argv) > 3 else None
    rnd = random.Random("schussental")

    towns = {}
    for m in (RV, WG):
        bm.SCALE, bm.BLOCK_INSET, bm.ROAD_EXTRA = m.get("scale", 1.15), m.get("inset", 1.6), m.get("road_extra", 2.0)
        towns[m["id"]] = bm.build(m, osm_dir, None)
    # Ravensburger Wahrzeichen, Veitsburg-Hügel und blaue Basis (Marienplatz) aus OSM
    rv_lms, mp = rv_landmarks(osm_dir)
    LANDMARKS[:] = [lm for lm in LANDMARKS if lm["t"] == "basilika"] + rv_lms
    vb = next((lm for lm in rv_lms if lm["t"] == "veitsburg"), None)
    if vb:
        HILLS[1] = (vb["x"] + 9, vb["y"] + 6, 30.0, 92.0, 2.4)
    if mp is not None:
        BASES[1] = (mp.x, mp.y)
    print("Wahrzeichen RV:", [(lm["t"], lm.get("s", ""), lm["x"], lm["y"]) for lm in rv_lms], "Marienplatz:", BASES[1], file=sys.stderr)
    # Hauptrouten an die (neu skalierten) Ravensburger Straßen anschließen
    rvx, rvy = OFF["ravensburg"]
    rv_lines = [LineString([(x + rvx, y + rvy) for x, y in zip(r["p"][0::2], r["p"][1::2])]) for r in towns["ravensburg"]["roads"] if r["k"] <= 1 and len(r["p"]) >= 4]
    rv_rect = box(rvx, rvy, rvx + towns["ravensburg"]["w"], rvy + towns["ravensburg"]["h"])
    connectors = []
    for ri, (name, w, k, pts) in enumerate(ROUTES):
        pts = list(pts)
        for end in (0, -1):
            e = Point(pts[end])
            if rv_rect.distance(e) > 40:
                continue
            best = min(rv_lines, key=lambda l: l.distance(e))
            q = best.interpolate(best.project(e))
            if 2 < e.distance(q) < 110:
                connectors.append(LineString([(e.x, e.y), (q.x, q.y)]).buffer(w / 2 + 2))
                if end == 0:
                    pts.insert(0, (q.x, q.y))
                else:
                    pts.append((q.x, q.y))
        ROUTES[ri] = (name, w, k, pts)
    connect_area = unary_union(connectors) if connectors else None
    W = R1(max(OFF["ravensburg"][0] + towns["ravensburg"]["w"], OFF["weingarten"][0] + towns["weingarten"]["w"]))
    H = R1(max(OFF["ravensburg"][1] + towns["ravensburg"]["h"], OFF["weingarten"][1] + towns["weingarten"]["h"]))
    world = box(0, 0, W, H)

    # ---- Städte zusammenführen ----
    buildings, roads, areas, water, trees, labels = [], [], [], [], [], []
    lm_union = unary_union([p.buffer(3) for lm in LANDMARKS for p, _ in lm_polys(lm)] + [terrace_area().buffer(2)])
    for tid, d in towns.items():
        ox, oy = OFF[tid]
        for b in d["buildings"]:
            p = shift(b["p"], ox, oy)
            poly = Polygon(list(zip(p[0::2], p[1::2])))
            if poly.is_valid and poly.intersects(lm_union):
                continue      # wird durch Wahrzeichen ersetzt
            if connect_area is not None and poly.is_valid and poly.intersects(connect_area):
                continue      # Anschluss der Hauptroute frei halten
            buildings.append({**b, "p": p})
        for r in d["roads"]:
            if r["k"] == 2:
                continue          # Fußwege/Gassen weglassen – nur klare Straßen
            roads.append({**r, "p": shift(r["p"], ox, oy)})
        for a in d["areas"]:
            areas.append({**a, "p": shift(a["p"], ox, oy)})
        for w in d["water"]:
            water.append(shift(w, ox, oy))
        for i in range(0, len(d["trees"]), 2):
            trees.append((d["trees"][i] + ox, d["trees"][i + 1] + oy))
        for l in d["labels"]:
            labels.append({**l, "x": R1(l["x"] + ox), "y": R1(l["y"] + oy)})

    # Wahrzeichen als Kollisions-Grundrisse
    for lm in LANDMARKS:
        for poly, h in lm_polys(lm):
            buildings.append(dict(p=flat(list(poly.exterior.coords)[:-1]), h=h, c=5, lm=1))

    # ---- Höhenkarte ----
    nx, ny = int(math.ceil(W / RES)) + 1, int(math.ceil(H / RES)) + 1
    gx, gy = np.meshgrid(np.arange(nx) * RES, np.arange(ny) * RES)

    def bump(cx, cy, h, r, p):
        d = np.hypot(gx - cx, gy - cy) / r
        return h * np.exp(-d ** p)

    # Talboden: Ravensburg 0 m, Weingarten steigt nach Norden an
    base = np.where(gy >= 948, 0.0, np.where(gy <= 720, 6.0 + (720 - gy) / 720 * 6.0, (948 - gy) / 228 * 6.0))
    hz = base.copy()
    for hcx, hcy, hh, hr, hp in HILLS:
        hz += bump(hcx, hcy, hh, hr, hp)
    hill_t = bump(*TUNNEL_HILL)
    hz += hill_t

    def seg_dist(points):
        """Abstand jedes Rasterpunkts zur Polylinie + Bogenlänge des nächsten Punkts."""
        best = np.full(gx.shape, 1e9); arc = np.zeros(gx.shape); acc = 0.0
        for (x1, y1), (x2, y2) in zip(points, points[1:]):
            dx, dy = x2 - x1, y2 - y1; L2 = dx * dx + dy * dy or 1.0
            t = np.clip(((gx - x1) * dx + (gy - y1) * dy) / L2, 0, 1)
            d = np.hypot(gx - (x1 + dx * t), gy - (y1 + dy * t))
            m = d < best
            best[m] = d[m]; arc[m] = acc + t[m] * math.sqrt(L2)
            acc += math.sqrt(L2)
        return best, arc

    def sample(z, x, y):
        fx, fy = x / RES, y / RES
        ix, iy = int(np.clip(math.floor(fx), 0, nx - 2)), int(np.clip(math.floor(fy), 0, ny - 2))
        tx, ty = fx - ix, fy - iy
        return float(z[iy, ix] * (1 - tx) * (1 - ty) + z[iy, ix + 1] * tx * (1 - ty) + z[iy + 1, ix] * (1 - tx) * ty + z[iy + 1, ix + 1] * tx * ty)

    # Flussbett
    rd, _ = seg_dist(RIVER)
    hz -= 3.8 * np.exp(-(rd / 14.0) ** 4)      # breites Flussbett mit flachem Grund, gut sichtbar
    water_z = lambda x, y: sample(base, x, y) - 1.7
    river_poly = LineString(RIVER).buffer(RIVER_W / 2, cap_style=2).intersection(world)
    river_out = []
    for g in (river_poly.geoms if hasattr(river_poly, "geoms") else [river_poly]):
        if isinstance(g, Polygon):
            c = g.representative_point()
            river_out.append(dict(p=flat(list(g.simplify(0.6).exterior.coords)[:-1]), z=R1(water_z(c.x, c.y))))

    # Brücken + Überführung: Kreuzungspunkte suchen
    decks, embank = [], []
    river_line = LineString(RIVER)

    def add_bridge(route_pts, cross_pt, half_span, ramp, rise, w):
        line = LineString(route_pts)
        s = line.project(Point(cross_pt))
        zb = sample(base, cross_pt[0], cross_pt[1]) + rise
        sa, sb = s - half_span, s + half_span
        A, B, C, D = (line.interpolate(v) for v in (sa - ramp, sa, sb, sb + ramp))
        za, zd = sample(hz, A.x, A.y), sample(hz, D.x, D.y)
        embank.append(([(A.x, A.y), (B.x, B.y)], (za, zb), w))
        embank.append(([(C.x, C.y), (D.x, D.y)], (zb, zd), w))
        decks.append(dict(p=[R1(B.x), R1(B.y), R1(zb), R1(C.x), R1(C.y), R1(zb)], w=w + 2, s=(sa, sb), route=tuple(route_pts)))

    for name, w, k, pts in ROUTES:
        line = LineString(pts)
        inter = line.intersection(river_line)
        for g in (inter.geoms if hasattr(inter, "geoms") else [inter]):
            if isinstance(g, Point) and name not in ("Westflanke", "Westflanke Süd"):
                add_bridge(pts, (g.x, g.y), 18.0, 32.0, 3.6, w)
    # Überführung: Querspange über die B30
    q = dict((n, p) for n, _, _, p in ROUTES)
    cross = LineString(q["Querspange"]).intersection(LineString(q["B30"]))
    add_bridge(q["Querspange"], (cross.x, cross.y), 17.0, 58.0, 7.8, 14)

    # Leitplanken auf den hohen Teilen der Dämme
    rails = []
    for (pa, pb), (za, zb), w in embank:
        lo, hi = (za, zb) if zb >= za else (zb, za)
        if hi - lo < 2.0:
            continue
        # Abschnitt, auf dem der Damm höher als 1,5 m ist (zur Brücke hin)
        f0 = 1.5 / (hi - lo)
        if zb >= za:
            p1, p2, z1, z2 = (pa[0] + (pb[0] - pa[0]) * f0, pa[1] + (pb[1] - pa[1]) * f0), pb, za + 1.5, zb
        else:
            p1, p2, z1, z2 = pa, (pb[0] + (pa[0] - pb[0]) * f0, pb[1] + (pa[1] - pb[1]) * f0), za, zb + 1.5
        L = math.hypot(p2[0] - p1[0], p2[1] - p1[1]) or 1
        rnx, rny = -(p2[1] - p1[1]) / L, (p2[0] - p1[0]) / L
        off = w / 2 + 2.2
        for sgn in (1, -1):
            rails.append(dict(p=[R1(p1[0] + rnx * off * sgn), R1(p1[1] + rny * off * sgn), R1(z1), R1(p2[0] + rnx * off * sgn), R1(p2[1] + rny * off * sgn), R1(z2)]))

    # Rampen in die Höhenkarte einbauen (Damm mit steilen Seiten)
    for (pa, pb), (za, zb), w in embank:
        d, arc = seg_dist([pa, pb])
        L = math.hypot(pb[0] - pa[0], pb[1] - pa[1])
        prof = za + (zb - za) * np.clip(arc / L, 0, 1)
        target = prof - np.maximum(0, d - (w / 2 + 2.6)) * 1.8
        hz = np.where(d < w / 2 + 2.6 + 20, np.maximum(hz, target), hz)

    # ---- Basilika-Vorplatz (Terrasse) ----
    tp = terrace_poly()
    zt = sample(hz, TERRACE["x1"] - 3, (TERRACE["y0"] + TERRACE["y1"]) / 2)
    from shapely import vectorized as shv
    inside = shv.contains(tp, gx, gy) | shv.contains(tp.buffer(2.5), gx, gy)
    hz = np.where(inside, zt, hz)
    # Rampen von der Terrasse hinunter (nur aufschütten, mit Böschung)
    for (pa, pb, w) in TERRACE_RAMPS:
        d, arc = seg_dist([pa, pb])
        L = math.hypot(pb[0] - pa[0], pb[1] - pa[1])
        zb = sample(hz, pb[0], pb[1])
        prof = zt + (zb - zt) * np.clip(arc / L, 0, 1)
        target = prof - np.maximum(0, d - (w / 2 + 1.0)) * 1.2
        hz = np.where(d < w / 2 + 14, np.maximum(hz, target), hz)
    # Stützmauern entlang des Randes (Lücken an den Rampen, Ostseite stößt an die Basilika)
    ring = tp.exterior
    n_seg = int(ring.length / 5)
    pts = [ring.interpolate(i / n_seg, normalized=True) for i in range(n_seg + 1)]
    mouths = [Point(pa) for pa, _, _ in TERRACE_RAMPS]
    for a, b in zip(pts, pts[1:]):
        mx, my = (a.x + b.x) / 2, (a.y + b.y) / 2
        if mx > TERRACE["x1"] - 4 or any(Point(mx, my).distance(m) < 9.5 for m in mouths):
            continue
        rails.append(dict(p=[R1(a.x), R1(a.y), R1(zt), R1(b.x), R1(b.y), R1(zt)], w=1))
    for (pa, pb, w) in TERRACE_RAMPS:   # niedrige Mauern an den Rampenseiten
        L = math.hypot(pb[0] - pa[0], pb[1] - pa[1]); ux, uy = (pb[0] - pa[0]) / L, (pb[1] - pa[1]) / L
        za, zb = zt, sample(hz, pb[0], pb[1])
        for sgn in (1, -1):
            ox, oy = -uy * (w / 2 + 0.6) * sgn, ux * (w / 2 + 0.6) * sgn
            rails.append(dict(p=[R1(pa[0] + ox), R1(pa[1] + oy), R1(za), R1(pb[0] - ux * 6 + ox), R1(pb[1] - uy * 6 + oy), R1(za + (zb - za) * (L - 6) / L)], w=1))
    plaza_area = terrace_area()

    # Tunnel durch den Hügel
    tun_route = q["Tunnelstraße"]
    tline = LineString(tun_route)
    td, tarc = seg_dist(tun_route)
    # Boden: Höhe ohne Hügel, entlang der Straße
    floor_grid = hz - hill_t
    tw = 14.0
    cut = (td < tw / 2 + 3.0) & (hill_t < 9.0) & (hill_t > 0.3)
    hz = np.where(cut, floor_grid, hz)            # Einschnitte vor den Portalen
    # Tunnelachse = Abschnitt der Straße, dessen Mitte im Hügel liegt
    samples = [tline.interpolate(s) for s in np.arange(0, tline.length, 2.0)]
    hin = [sample(hill_t, p.x, p.y) >= 9.0 for p in samples]
    i0 = hin.index(True); i1 = len(hin) - 1 - hin[::-1].index(True)
    tpts = samples[max(0, i0 - 1): i1 + 2]
    tunnel = dict(p=[], w=tw, hgt=CEIL, name="Tunnel Schussentaler Höhe")
    for p in tpts[::3] + ([tpts[-1]] if (len(tpts) - 1) % 3 else []):
        tunnel["p"] += [R1(p.x), R1(p.y), R1(sample(floor_grid, p.x, p.y))]

    # Basen einebnen
    for bx, by in BASES[1:]:   # Rot steht schon auf der ebenen Terrasse
        d = np.hypot(gx - bx, gy - by)
        h0 = sample(hz, bx, by)
        f = np.clip((d - 16) / 14, 0, 1)
        hz = hz * f + h0 * (1 - f)

    # ---- Straßen, Brücken, Tunnel als Daten ----
    for name, w, k, pts in ROUTES:
        line = LineString(pts)
        cuts = [dk["s"] for dk in decks if dk["route"] == tuple(pts)]
        if name == "Tunnelstraße":
            s0 = line.project(tpts[0]); s1 = line.project(tpts[-1])
            cuts.append((s0 + 1, s1 - 1))
        cuts.sort()
        s = 0.0
        parts = []
        for a, b in cuts:
            if a > s:
                parts.append((s, a))
            s = b
        parts.append((s, line.length))
        for a, b in parts:
            if b - a < 2:
                continue
            seg = [line.interpolate(v) for v in np.linspace(a, b, max(2, int((b - a) / 6) + 1))]
            roads.append(dict(w=float(w), k=k, p=flat([(p.x, p.y) for p in seg]), n=name))
    for dk in decks:
        dk.pop("s"); dk.pop("route")

    # ---- Sackgassen-Stummel entfernen: nur Straßen, die an beiden Enden irgendwo anschließen ----
    def prune(roads):
        for _ in range(4):
            lines = [LineString(list(zip(r["p"][0::2], r["p"][1::2]))) for r in roads]
            keep = []
            for i, r in enumerate(roads):
                if r["k"] != 1 or r.get("n") in [n for n, *_ in ROUTES]:
                    keep.append(r); continue
                ln = lines[i]
                dead = 0
                for e in (Point(ln.coords[0]), Point(ln.coords[-1])):
                    near = any(j != i and roads[j]["k"] <= 1 and lines[j].distance(e) < roads[j]["w"] / 2 + 2.5 for j in range(len(roads)))
                    edge = e.x < 8 or e.y < 8 or e.x > W - 8 or e.y > H - 8
                    dead += 0 if (near or edge) else 1
                if dead and ln.length < (160 if dead == 2 else 75):
                    continue
                keep.append(r)
            if len(keep) == len(roads):
                break
            roads = keep
        return roads
    n0 = len(roads)
    roads[:] = prune(roads)
    print("Sackgassen entfernt:", n0 - len(roads), file=sys.stderr)

    # ---- Bodenflächen im Tal ----
    town_rects = [box(OFF[t][0], OFF[t][1], OFF[t][0] + towns[t]["w"], OFF[t][1] + towns[t]["h"]) for t in towns]
    meadow = world.difference(unary_union(town_rects))
    for g in (meadow.geoms if hasattr(meadow, "geoms") else [meadow]):
        if isinstance(g, Polygon) and g.area > 100:
            areas.append(dict(t="green", p=flat(list(g.exterior.coords)[:-1])))
    # ---- Dichtere Bebauung im Tal: Häuser mit Satteldach entlang der Straßen, gepflasterte Höfe ----
    from shapely.strtree import STRtree
    from shapely import affinity
    rlines = [(LineString(list(zip(r["p"][0::2], r["p"][1::2]))), r["w"]) for r in roads if r["k"] <= 1 and len(r["p"]) >= 4]
    rtree = STRtree([l for l, _ in rlines])
    road_buf = unary_union([l.buffer(w / 2 + 4.5) for l, w in rlines])
    keep_out = unary_union([river_line.buffer(46), plaza_area.buffer(10), tline.buffer(26),
                            *[Point(x, y).buffer(42) for x, y in BASES], *[Point(x, y).buffer(30) for x, y, _ in JUMP_RAMPS],
                            *[LineString(pp).buffer(w / 2 + 14) for (pp, _, w) in embank],
                            *[LineString([(dk["p"][0], dk["p"][1]), (dk["p"][3], dk["p"][4])]).buffer(dk["w"] / 2 + 14) for dk in decks]])
    occupied_b = STRtree([Polygon(list(zip(b["p"][0::2], b["p"][1::2]))).buffer(0) for b in buildings])
    gyy0, gxx0 = np.gradient(hz, RES)
    slope_g = np.hypot(gxx0, gyy0)
    houses = []
    G = 17.0
    for gyv in np.arange(8, H - 8, G):
        for gxv in np.arange(8, W - 8, G):
            cx, cy = gxv + rnd.uniform(-4, 4), gyv + rnd.uniform(-4, 4)
            c = Point(cx, cy)
            if not meadow.contains(c) or keep_out.contains(c):
                continue
            near = [i for i in rtree.query(c.buffer(64))]
            if not near:
                continue
            best = min(near, key=lambda i: rlines[i][0].distance(c))
            line, rw = rlines[best]
            dd = line.distance(c)
            if dd < rw / 2 + 9 or dd > rw / 2 + 50:
                continue
            ix, iy = int(cx / RES), int(cy / RES)
            if slope_g[min(iy, ny - 1), min(ix, nx - 1)] > 0.22:
                continue
            s_ = line.project(c); pa_, pb_ = line.interpolate(max(0, s_ - 2)), line.interpolate(s_ + 2)
            ang = math.atan2(pb_.y - pa_.y, pb_.x - pa_.x)
            bw, bd = rnd.uniform(10, 15), rnd.uniform(8.5, 11)
            fp = affinity.rotate(box(cx - bw / 2, cy - bd / 2, cx + bw / 2, cy + bd / 2), ang, origin=(cx, cy), use_radians=True)
            if fp.intersects(road_buf) or fp.intersects(keep_out) or not meadow.contains(fp):
                continue
            if any(occupied_b.geometries[i].distance(fp) < 7 for i in occupied_b.query(fp.buffer(8))) or any(h_.distance(fp) < 9 for h_ in houses[-60:]):
                continue
            zs = [sample(hz, x, y) for x, y in fp.exterior.coords[:-1]]
            if max(zs) - min(zs) > 2.5:
                continue
            houses.append(fp)
    for fp in houses:
        buildings.append(dict(p=flat([(R1(x), R1(y)) for x, y in fp.exterior.coords[:-1]]), h=R1(rnd.uniform(7, 11.5)), c=0))
    yards = unary_union([fp.buffer(6, join_style=2) for fp in houses]).intersection(meadow).difference(river_line.buffer(16))
    for g in ([yards] if isinstance(yards, Polygon) else getattr(yards, "geoms", [])):
        if isinstance(g, Polygon) and g.area > 40:
            areas.append(dict(t="paved", p=flat([(R1(x), R1(y)) for x, y in g.simplify(0.8).exterior.coords[:-1]])))
    for g in ([plaza_area] if isinstance(plaza_area, Polygon) else plaza_area.geoms):
        areas.append(dict(t="paved", p=flat([(R1(x), R1(y)) for x, y in g.simplify(0.5).exterior.coords[:-1]]), cob=1))
    print("Neue Häuser im Tal:", len(houses), file=sys.stderr)
    trees[:] = [(x, y) for x, y in trees if not plaza_area.buffer(4).contains(Point(x, y))]
    house_buf = unary_union([fp.buffer(3) for fp in houses]) if houses else None
    # Bäume (nur Deko) an Ufer und Hängen
    for _ in range(900):
        x, y = rnd.uniform(0, W), rnd.uniform(0, H)
        pt = Point(x, y)
        if any(r.contains(pt) for r in town_rects):
            continue
        dr = river_line.distance(pt)
        if dr < 12 or any(LineString(p).distance(pt) < w / 2 + 4 for _, w, _, p in ROUTES):
            continue
        hz_here = sample(hz - base, x, y)
        if house_buf is not None and house_buf.contains(pt):
            continue
        if dr < 40 or hz_here > 6 or rnd.random() < 0.12:
            trees.append((x, y))
    labels += [
        dict(t="Schussen", x=420, y=880, a=-0.08, k=1),
        dict(t="Schussen", x=980, y=878, a=0.05, k=1),
        dict(t="Schussentaler Höhe", x=1165, y=1110, a=0, k=1),
        dict(t="Martinsberg", x=120, y=330, a=0, k=1),
        dict(t="Schussentalstraße", x=262, y=830, a=-1.0, k=0),
        dict(t="B30", x=630, y=905, a=-1.2, k=0),
        dict(t="Querspange", x=440, y=784, a=0.0, k=0),
    ]

    # ---- Raster: Freiraum für Basen, Rampen, Kisten ----
    C = 1.0
    gw, gh = int(math.ceil(W / C)), int(math.ceil(H / C))
    from PIL import Image, ImageDraw
    img = Image.new("L", (gw, gh), 0)
    dr_ = ImageDraw.Draw(img)
    for b in buildings:
        dr_.polygon([(x / C, y / C) for x, y in zip(b["p"][0::2], b["p"][1::2])], fill=255)
    for w in water + [r["p"] for r in river_out]:
        dr_.polygon([(x / C, y / C) for x, y in zip(w[0::2], w[1::2])], fill=255)
    blocked = np.array(img) > 0
    gyy, gxx = np.gradient(hz, RES)
    steep = np.hypot(gxx, gyy) > 0.45
    steep_full = np.kron(steep, np.ones((int(RES), int(RES)), dtype=bool))[:gh, :gw]
    blocked |= steep_full
    # Brücken (inkl. Übergang zur Rampe) sind befahrbar
    dimg = Image.new("L", (gw, gh), 0); dd_ = ImageDraw.Draw(dimg)
    for dk in decks:
        p = dk["p"]
        ln = LineString([(p[0], p[1]), (p[3], p[4])])
        ux, uy = (p[3] - p[0]) / ln.length, (p[4] - p[1]) / ln.length
        ext = LineString([(p[0] - ux * 10, p[1] - uy * 10), (p[3] + ux * 10, p[4] + uy * 10)]).buffer(dk["w"] / 2 - 1, cap_style=2)
        dd_.polygon([(x / C, y / C) for x, y in ext.exterior.coords], fill=255)
    blocked &= ~(np.array(dimg) > 0)
    blocked[0, :] = blocked[-1, :] = blocked[:, 0] = blocked[:, -1] = True
    clear = ndimage.distance_transform_edt(~blocked) * C
    free = clear > 3.0
    lab, n = ndimage.label(free)
    sizes = ndimage.sum(free, lab, range(1, n + 1))
    main_c = lab == (int(np.argmax(sizes)) + 1)

    def snap(x, y, need):
        # nächster freier Punkt; bei engen Plätzen (Marienplatz) mit weniger Freiraum begnügen
        for nd in (need, need - 2, need - 3.5, need - 5):
            ys, xs = np.nonzero(main_c & (clear >= nd))
            dd = (xs * C - x) ** 2 + (ys * C - y) ** 2
            i = int(np.argmin(dd))
            if dd[i] < 45 ** 2:
                print("Basis", (x, y), "->", (xs[i], ys[i]), "Freiraum", nd, file=sys.stderr)
                return float(xs[i] * C), float(ys[i] * C)
        return float(xs[i] * C), float(ys[i] * C)

    bases = [BASES[0]] + [snap(x, y, 10) for x, y in BASES[1:]]
    base_out = [dict(x=R1(x), y=R1(y), n=n) for (x, y), n in zip(bases, ["Münsterplatz", "Marienplatz"])]

    occupied = [(x, y) for x, y, _ in JUMP_RAMPS]

    def far_ok(x, y, mind):
        if any(math.hypot(x - bx, y - by) < 45 for bx, by in bases):
            return False
        return all(math.hypot(x - ox, y - oy) >= mind for ox, oy in occupied)

    ramps = []
    # Breite Sprungschanzen direkt vor dem Ufer (neben den Brücken und auf den Wiesen), Blick quer über die Schussen
    rl = LineString(RIVER)
    bridge_x = [ (dk["p"][0] + dk["p"][3]) / 2 for dk in decks if abs((dk["p"][1] + dk["p"][4]) / 2 - 870) < 40]
    spots = sorted(set([bx + o for bx in bridge_x for o in (-34, 34)] + [100, 800]))
    for sx in spots:
        s = rl.project(Point(sx, 870))
        P0, P1 = rl.interpolate(max(0, s - 2)), rl.interpolate(s + 2)
        tx, ty = P1.x - P0.x, P1.y - P0.y; L = math.hypot(tx, ty) or 1
        nxx, nyy = -ty / L, tx / L
        c = rl.interpolate(s)
        for sgn in (1, -1):
            off = RIVER_W / 2 + 9.5
            x, y = c.x + nxx * off * sgn, c.y + nyy * off * sgn
            a = math.atan2(-nyy * sgn, -nxx * sgn)   # Richtung zum Fluss
            ix, iy = int(x / C), int(y / C)
            if not (0 <= ix < gw and 0 <= iy < gh) or clear[iy, ix] < 5.5:
                continue
            if any(math.hypot(x - dk["p"][0], y - dk["p"][1]) < 22 or math.hypot(x - dk["p"][3], y - dk["p"][4]) < 22 for dk in decks):
                continue
            ok = True
            for dd in range(-30, -4, 3):      # Anlauf frei und eben
                px, py = int((x + math.cos(a) * dd) / C), int((y + math.sin(a) * dd) / C)
                if not (0 <= px < gw and 0 <= py < gh) or clear[py, px] < 4.0:
                    ok = False; break
            if ok:
                ramps.append(dict(x=R1(x), y=R1(y), a=round(a, 3), l=9, w=10, b=1))
                occupied.append((x, y))
    print("Flussschanzen:", len(ramps), file=sys.stderr)
    cand = [r for r in roads if r["k"] <= 1]
    rnd.shuffle(cand)
    for rd_ in cand:
        if len(ramps) >= 26:
            break
        pts = list(zip(rd_["p"][0::2], rd_["p"][1::2]))
        for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
            L = math.hypot(x2 - x1, y2 - y1)
            if L < 10:
                continue
            cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
            ix, iy = int(cx / C), int(cy / C)
            if not (0 <= ix < gw and 0 <= iy < gh) or not main_c[iy, ix] or clear[iy, ix] < 6.5 or not far_ok(cx, cy, 80):
                continue
            if any(math.hypot(cx - dk["p"][0], cy - dk["p"][1]) < 60 for dk in decks) or rl.distance(Point(cx, cy)) < 90:
                continue
            a0 = math.atan2(y2 - y1, x2 - x1)

            def runway_ok(a):
                hs = []
                for dd in list(range(-18, 0, 3)) + list(range(4, 44, 3)):
                    px, py = int((cx + math.cos(a) * dd) / C), int((cy + math.sin(a) * dd) / C)
                    if not (0 <= px < gw and 0 <= py < gh) or clear[py, px] < (3.5 if dd > 0 else 4.5):
                        return False
                    hs.append(sample(hz, px, py))
                return max(hs) - min(hs) < 4.0
            opts = [a0, a0 + math.pi]
            rnd.shuffle(opts)
            a = next((o for o in opts if runway_ok(o)), None)
            if a is None:
                continue
            ramps.append(dict(x=R1(cx), y=R1(cy), a=round(math.atan2(math.sin(a), math.cos(a)), 3)))
            occupied.append((cx, cy))
            break

    ys, xs = np.nonzero(main_c & (clear >= 6))
    order = list(range(len(xs)))
    rnd.shuffle(order)
    crates, pickups = [], []
    for i in order:
        x, y = float(xs[i] * C), float(ys[i] * C)
        if len(crates) < 30 and far_ok(x, y, 45):
            crates.append(dict(x=R1(x), y=R1(y), a=round(rnd.random() * 3.14, 2), t=rnd.choice([0, 0, 1, 2])))
            occupied.append((x, y))
        elif len(pickups) < 20 and far_ok(x, y, 55):
            pickups.append(dict(x=R1(x), y=R1(y), t=len(pickups) % 3))
            occupied.append((x, y))
        if len(crates) >= 30 and len(pickups) >= 20:
            break

    # ---- Ausgabe ----
    hz_dm = np.clip(np.round(hz * 10), -32000, 32000).astype("<i2")
    for w in water:
        pass
    water_out = [dict(p=w, z=R1(sample(hz, sum(w[0::2]) / (len(w) / 2), sum(w[1::2]) / (len(w) / 2)) - 0.3)) for w in water] + river_out
    out = dict(
        id="schussental", name="Schussental", sub="Ravensburg – Weingarten", w=W, h=H,
        buildings=[{k: v for k, v in b.items() if v is not None} for b in buildings],
        roads=[{k: v for k, v in r.items() if k != "n" or r.get("k", 0) <= 0} for r in roads],
        areas=areas, water=water_out, trees=flat(trees), labels=labels, bases=base_out,
        ramps=ramps, crates=crates, pickups=pickups, decks=decks, rails=rails, tunnels=[tunnel], landmarks=LANDMARKS,
        terrain=dict(res=RES, nx=nx, ny=ny, data=base64.b64encode(hz_dm.tobytes()).decode()),
    )
    with open(out_js, "w", encoding="utf-8") as f:
        f.write("// Kartendaten (c) OpenStreetMap-Mitwirkende, ODbL – generiert von tools/build_world.py\n")
        f.write("window.MAPS=[" + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + "];\n")
    print(f"Karte {W}x{H} m, {len(buildings)} Gebäude, {len(roads)} Wege, {len(decks)} Brücken, Tunnel {len(tunnel['p']) // 3} Punkte, "
          f"{len(ramps)} Rampen, {len(crates)} Kisten, {len(pickups)} Pickups, Basen {base_out}, Höhe {hz.min():.1f}..{hz.max():.1f} m", file=sys.stderr)

    if preview:
        sc = 0.55
        im = Image.new("RGB", (int(W * sc), int(H * sc)))
        rel = (hz - hz.min()) / (hz.max() - hz.min())
        shade = (np.stack([rel * 120 + 60, rel * 140 + 80, rel * 80 + 50], -1)).astype(np.uint8)
        hm = Image.fromarray(shade).resize((int(W * sc), int(H * sc)))
        im.paste(hm)
        d = ImageDraw.Draw(im)
        for r in roads:
            pts = [(x * sc, y * sc) for x, y in zip(r["p"][0::2], r["p"][1::2])]
            d.line(pts, fill=(60, 60, 60) if r["k"] < 2 else (150, 140, 120), width=max(1, int(r["w"] * sc * (1 if r["k"] < 2 else 0.4))))
        for w in water_out:
            d.polygon([(x * sc, y * sc) for x, y in zip(w["p"][0::2], w["p"][1::2])], fill=(50, 90, 170))
        for b in buildings:
            d.polygon([(x * sc, y * sc) for x, y in zip(b["p"][0::2], b["p"][1::2])], fill=(255, 255, 255) if b.get("lm") else (190, 110, 90))
        for dk in decks:
            p = dk["p"]; d.line([(p[0] * sc, p[1] * sc), (p[3] * sc, p[4] * sc)], fill=(255, 220, 0), width=int(dk["w"] * sc))
        tp = tunnel["p"]
        d.line([(tp[i] * sc, tp[i + 1] * sc) for i in range(0, len(tp), 3)], fill=(255, 0, 255), width=6)
        for rp in ramps:
            d.rectangle([(rp["x"] - 4) * sc, (rp["y"] - 4) * sc, (rp["x"] + 4) * sc, (rp["y"] + 4) * sc], fill=(250, 200, 0))
        for i, bb in enumerate(base_out):
            col = (230, 40, 40) if i == 0 else (40, 80, 230)
            d.ellipse([(bb["x"] - 12) * sc, (bb["y"] - 12) * sc, (bb["x"] + 12) * sc, (bb["y"] + 12) * sc], outline=col, width=4)
        im.save(preview)


if __name__ == "__main__":
    main()
