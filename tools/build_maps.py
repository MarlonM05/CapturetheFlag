"""Baut die Spielkarten aus OpenStreetMap-Daten.

Aufruf:  python build_maps.py <osm-ordner> <ausgabe maps.js> [preview-ordner]

Erwartet pro Karte eine Datei <id>.osm (Export von api.openstreetmap.org/api/0.6/map).
Kartendaten (c) OpenStreetMap-Mitwirkende, ODbL.
"""
import json
import math
import random
import sys
import xml.etree.ElementTree as ET

import numpy as np
from scipy import ndimage
from shapely.geometry import LineString, Polygon, MultiPolygon, box, Point
from shapely.ops import unary_union, polygonize, linemerge

MAPS = [
    dict(id="ravensburg", name="Ravensburg", sub="Altstadt & Marienplatz",
         bbox=(9.60710, 47.77850, 9.61790, 47.78450),
         bases_m=[(125, 345), (493, 420)]),
    dict(id="weingarten", name="Weingarten", sub="Basilika & Löwenplatz",
         bbox=(9.63860, 47.80620, 9.64940, 47.81220),
         bases_m=[(250, 180), (667, 455)]),
    dict(id="friedrichshafen", name="Friedrichshafen", sub="Hafen & Uferpromenade",
         bbox=(9.47460, 47.64900, 9.48540, 47.65500),
         bases_m=[(110, 390), (690, 250)]),
]

ROAD_W = {
    "motorway": 14, "trunk": 13, "primary": 12, "secondary": 11, "tertiary": 10,
    "unclassified": 8, "residential": 8, "living_street": 7, "service": 6,
    "pedestrian": 8, "footway": 3, "path": 3, "cycleway": 3, "steps": 3,
    "track": 4, "primary_link": 9, "secondary_link": 8, "tertiary_link": 7,
}
ROAD_KIND = {  # 0 = Hauptstraße, 1 = Nebenstraße, 2 = Fußweg/Platz
    "motorway": 0, "trunk": 0, "primary": 0, "secondary": 0, "tertiary": 0,
    "primary_link": 0, "secondary_link": 0, "tertiary_link": 0,
    "unclassified": 1, "residential": 1, "living_street": 1, "service": 1, "track": 1,
    "pedestrian": 2, "footway": 2, "path": 2, "cycleway": 2, "steps": 2,
}
GREEN = {("leisure", "park"), ("landuse", "grass"), ("leisure", "garden"), ("landuse", "meadow"),
         ("landuse", "village_green"), ("leisure", "playground"), ("natural", "scrub"),
         ("landuse", "forest"), ("natural", "wood"), ("leisure", "pitch"), ("landuse", "cemetery"),
         ("natural", "grassland"), ("landuse", "recreation_ground"), ("natural", "shrubbery")}
PAVED = {("amenity", "parking"), ("highway", "pedestrian"), ("place", "square"),
         ("area:highway", "pedestrian"), ("leisure", "marina"), ("man_made", "pier"),
         ("amenity", "marketplace")}
SAND = {("natural", "beach"), ("leisure", "beach_resort"), ("natural", "sand")}


def r1(v):
    return round(v, 1)


def flat(coords):
    out = []
    for x, y in coords:
        out += [r1(x), r1(y)]
    return out


def build(m, osm_dir, preview_dir=None):
    root = ET.parse(f"{osm_dir}/{m['id']}.osm").getroot()
    minlon, minlat, maxlon, maxlat = m["bbox"]
    lat0 = (minlat + maxlat) / 2
    kx = 111320 * math.cos(math.radians(lat0))
    ky = 110540

    def proj(lon, lat):
        return ((lon - minlon) * kx, (maxlat - lat) * ky)

    W = (maxlon - minlon) * kx
    H = (maxlat - minlat) * ky
    world = box(0, 0, W, H)

    nodes, ways, rels = {}, {}, []
    node_tags = []
    for el in root:
        if el.tag == "node":
            p = proj(float(el.get("lon")), float(el.get("lat")))
            nodes[el.get("id")] = p
            t = {c.get("k"): c.get("v") for c in el if c.tag == "tag"}
            if t:
                node_tags.append((p, t))
        elif el.tag == "way":
            t = {c.get("k"): c.get("v") for c in el if c.tag == "tag"}
            ways[el.get("id")] = ([c.get("ref") for c in el if c.tag == "nd"], t)
        elif el.tag == "relation":
            t = {c.get("k"): c.get("v") for c in el if c.tag == "tag"}
            mem = [(c.get("type"), c.get("ref"), c.get("role")) for c in el if c.tag == "member"]
            rels.append((t, mem))

    def way_pts(wid):
        refs, _ = ways[wid]
        return [nodes[r] for r in refs if r in nodes]

    def way_poly(wid):
        pts = way_pts(wid)
        if len(pts) < 4 or pts[0] != pts[-1]:
            return None
        p = Polygon(pts)
        if not p.is_valid:
            p = p.buffer(0)
        return p

    def rel_poly(mem):
        outers = [LineString(way_pts(r)) for ty, r, role in mem
                  if ty == "way" and r in ways and role in ("outer", "") and len(way_pts(r)) >= 2]
        inners = [LineString(way_pts(r)) for ty, r, role in mem
                  if ty == "way" and r in ways and role == "inner" and len(way_pts(r)) >= 2]
        if not outers:
            return None
        merged = linemerge(outers)
        polys = list(polygonize(merged))
        if polys:
            g = unary_union(polys)
            if inners:
                ip = list(polygonize(linemerge(inners)))
                if ip:
                    g = g.difference(unary_union(ip))
            return g
        return None

    def keep_polys(g, min_area=4.0):
        g = g.intersection(world)
        if g.is_empty:
            return []
        geoms = list(g.geoms) if hasattr(g, "geoms") else [g]
        out = []
        for gg in geoms:
            if isinstance(gg, Polygon) and gg.area >= min_area:
                out.append(gg)
        return out

    rnd = random.Random(m["id"])
    buildings, areas, roads, labels = [], [], [], []
    water_geoms = []
    bld_geoms = []

    def height_of(t):
        try:
            if "height" in t:
                return max(3.0, min(60.0, float(t["height"].split()[0].replace(",", "."))))
        except ValueError:
            pass
        try:
            if "building:levels" in t:
                lv = float(t["building:levels"].split(";")[0])
                return 3.2 * lv + (2.5 if t.get("roof:shape", "gabled") != "flat" else 0.5)
        except ValueError:
            pass
        b = t.get("building", "yes")
        if b in ("garage", "garages", "shed", "carport", "kiosk", "hut", "roof"):
            return 3.0
        if b in ("church", "cathedral", "chapel"):
            return 22.0
        if b in ("tower",) or t.get("man_made") == "tower":
            return 30.0
        return 9.0 + rnd.random() * 6

    def color_of(t):
        b = t.get("building", "yes")
        if b in ("church", "cathedral", "chapel") or t.get("amenity") == "place_of_worship":
            return 3
        if b in ("garage", "garages", "shed", "carport", "industrial", "warehouse", "roof"):
            return 4
        if t.get("historic") or b in ("tower",):
            return 5
        return rnd.choice([0, 0, 1, 1, 2, 6])

    for wid, (refs, t) in ways.items():
        if ("building" in t and t["building"] not in ("no", "construction")) or (
                t.get("man_made") == "tower" and len(refs) > 3):
            p = way_poly(wid)
            if p is None:
                continue
            for pp in keep_polys(p, 6):
                pp = pp.simplify(0.35)
                bld_geoms.append(pp)
                buildings.append(dict(p=flat(list(pp.exterior.coords)[:-1]), h=r1(height_of(t)), c=color_of(t),
                                      n=t.get("name")))
            continue
        kv = set(t.items())
        if ("natural", "water") in kv or ("waterway", "riverbank") in kv or ("leisure", "swimming_pool") in kv:
            p = way_poly(wid)
            if p is not None:
                water_geoms += keep_polys(p, 3)
            continue
        if t.get("area") == "yes" and "highway" in t or kv & PAVED:
            p = way_poly(wid)
            if p is not None:
                for pp in keep_polys(p, 10):
                    areas.append(("paved", pp))
            if "highway" not in t or t.get("area") == "yes":
                continue
        if kv & GREEN:
            p = way_poly(wid)
            if p is not None:
                for pp in keep_polys(p, 10):
                    areas.append(("green", pp))
            continue
        if kv & SAND:
            p = way_poly(wid)
            if p is not None:
                for pp in keep_polys(p, 10):
                    areas.append(("sand", pp))
            continue
        hw = t.get("highway")
        if hw in ROAD_W and t.get("area") != "yes":
            pts = way_pts(wid)
            if len(pts) < 2:
                continue
            ls = LineString(pts).intersection(world.buffer(20))
            if ls.is_empty:
                continue
            segs = list(ls.geoms) if hasattr(ls, "geoms") else [ls]
            for s in segs:
                if isinstance(s, LineString) and len(s.coords) >= 2:
                    s = s.simplify(0.5)
                    roads.append(dict(w=ROAD_W[hw], k=ROAD_KIND[hw], p=flat(s.coords), n=t.get("name")))
            continue
        if t.get("railway") in ("rail", "light_rail", "tram"):
            pts = way_pts(wid)
            if len(pts) >= 2:
                s = LineString(pts).intersection(world.buffer(20))
                for g in (list(s.geoms) if hasattr(s, "geoms") else [s]):
                    if isinstance(g, LineString) and len(g.coords) >= 2:
                        roads.append(dict(w=3, k=3, p=flat(g.simplify(0.5).coords)))
        if t.get("waterway") in ("river", "stream", "canal", "ditch") and "tunnel" not in t:
            pts = way_pts(wid)
            if len(pts) >= 2:
                if t["waterway"] in ("river", "canal"):
                    water_geoms += keep_polys(LineString(pts).buffer(4), 1)
                else:  # Bach: nur Optik, befahrbar
                    s = LineString(pts).intersection(world.buffer(20))
                    for g in (list(s.geoms) if hasattr(s, "geoms") else [s]):
                        if isinstance(g, LineString) and len(g.coords) >= 2:
                            roads.append(dict(w=2.5, k=4, p=flat(g.simplify(0.5).coords)))

    for t, mem in rels:
        kv = set(t.items())
        if t.get("type") not in ("multipolygon",):
            continue
        if "building" in t:
            g = rel_poly(mem)
            if g is not None:
                for pp in keep_polys(g, 6):
                    pp = pp.simplify(0.35)
                    bld_geoms.append(pp)
                    buildings.append(dict(p=flat(list(pp.exterior.coords)[:-1]), h=r1(height_of(t)),
                                          c=color_of(t), n=t.get("name")))
        elif ("natural", "water") in kv:
            g = rel_poly(mem)
            if g is not None:
                water_geoms += keep_polys(g, 3)
            else:
                # Großer See (z.B. Bodensee): Uferlinien im Ausschnitt + Kartenrand polygonisieren
                lines = [LineString(way_pts(r)) for ty, r, role in mem
                         if ty == "way" and r in ways and len(way_pts(r)) >= 2]
                if lines:
                    shore = unary_union(lines).intersection(world)
                    cells = list(polygonize(unary_union([shore, world.exterior])))
                    for c in cells:
                        # Seite des Sees bestimmen: Wasser liegt dort, wo keine Gebäude/Straßen sind
                        rp = c.representative_point()
                        hits = sum(1 for b in bld_geoms[:4000] if c.contains(b.representative_point()))
                        if hits == 0 and c.area > 2000:
                            water_geoms.append(c)
        elif kv & GREEN:
            g = rel_poly(mem)
            if g is not None:
                for pp in keep_polys(g, 10):
                    areas.append(("green", pp))
        elif kv & PAVED:
            g = rel_poly(mem)
            if g is not None:
                for pp in keep_polys(g, 10):
                    areas.append(("paved", pp))

    water = unary_union(water_geoms) if water_geoms else None
    water_polys = []
    if water is not None and not water.is_empty:
        for pp in keep_polys(water, 3):
            water_polys.append(pp.simplify(0.4))

    # Bäume (Hindernisse)
    trees = []
    for (x, y), t in node_tags:
        if t.get("natural") == "tree" and 3 < x < W - 3 and 3 < y < H - 3:
            pt = Point(x, y)
            trees.append((x, y))

    # Labels: POIs & Plätze
    for (x, y), t in node_tags:
        nm = t.get("name")
        if not nm or not (0 < x < W and 0 < y < H):
            continue
        if t.get("place") == "square" or t.get("tourism") in ("attraction", "museum") or t.get("historic") in (
                "monument", "tower", "building", "city_gate", "fountain") or t.get("amenity") in (
                "place_of_worship", "townhall", "fountain"):
            labels.append(dict(t=nm, x=r1(x), y=r1(y), a=0, k=1))
    for b in buildings:
        if b.get("n") and len(b["n"]) < 32 and (b["c"] in (3, 5) or b["h"] > 15):
            pts = b["p"]
            cx = sum(pts[0::2]) / (len(pts) / 2)
            cy = sum(pts[1::2]) / (len(pts) / 2)
            labels.append(dict(t=b["n"], x=r1(cx), y=r1(cy), a=0, k=2))
    for k, pp in areas:
        pass
    # Straßennamen
    seen = {}
    for rd in sorted(roads, key=lambda r: -len(r["p"])):
        nm = rd.get("n")
        if not nm or rd["k"] > 2:
            continue
        pts = list(zip(rd["p"][0::2], rd["p"][1::2]))
        best, bl = None, 0
        for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
            l = math.hypot(x2 - x1, y2 - y1)
            if l > bl:
                bl, best = l, (x1, y1, x2, y2)
        if bl < len(nm) * 1.6:
            continue
        x1, y1, x2, y2 = best
        cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
        if not (10 < cx < W - 10 and 10 < cy < H - 10):
            continue
        if any(math.hypot(cx - px, cy - py) < 140 for px, py in seen.get(nm, [])):
            continue
        a = math.atan2(y2 - y1, x2 - x1)
        if a > math.pi / 2:
            a -= math.pi
        if a < -math.pi / 2:
            a += math.pi
        seen.setdefault(nm, []).append((cx, cy))
        labels.append(dict(t=nm, x=r1(cx), y=r1(cy), a=round(a, 3), k=0))
    # Doppelte POI-Labels entfernen
    dedup, out_labels = set(), []
    for l in labels:
        key = (l["t"], l["k"] == 0 and round(l["x"] / 140) or 0)
        if l["k"] != 0 and l["t"] in dedup:
            continue
        dedup.add(l["t"])
        out_labels.append(l)
    labels = out_labels

    # ---------- Raster für Freiraum / Basenplatzierung ----------
    C = 1.0  # m pro Zelle
    gw, gh = int(math.ceil(W / C)), int(math.ceil(H / C))
    from PIL import Image, ImageDraw
    img = Image.new("L", (gw, gh), 0)
    d = ImageDraw.Draw(img)
    for b in bld_geoms:
        d.polygon([(x / C, y / C) for x, y in b.exterior.coords], fill=255)
    for wp in water_polys:
        d.polygon([(x / C, y / C) for x, y in wp.exterior.coords], fill=255)
    for x, y in trees:
        d.ellipse([x / C - 1, y / C - 1, x / C + 1, y / C + 1], fill=255)
    blocked = np.array(img) > 0
    blocked[0, :] = blocked[-1, :] = blocked[:, 0] = blocked[:, -1] = True
    clear = ndimage.distance_transform_edt(~blocked) * C
    free = clear > 3.2
    lab, n = ndimage.label(free)
    sizes = ndimage.sum(free, lab, range(1, n + 1))
    main = lab == (int(np.argmax(sizes)) + 1)

    def snap(x, y, need=9.0):
        best, bd = None, 1e9
        ys, xs = np.nonzero(main & (clear >= need))
        if len(xs) == 0:
            ys, xs = np.nonzero(main & (clear >= 5))
        dd = (xs * C - x) ** 2 + (ys * C - y) ** 2
        i = int(np.argmin(dd))
        return float(xs[i] * C), float(ys[i] * C)

    if m.get("bases_m"):
        bases = [snap(x, y, 9) for x, y in m["bases_m"]]
    else:
        ys, xs = np.nonzero(main & (clear >= 11))
        if len(xs) < 2:
            ys, xs = np.nonzero(main & (clear >= 7))
        pts = np.stack([xs * C, ys * C], 1)
        # Paar mit großem Abstand (Ost/West- bzw. Nord/Süd-Enden), möglichst offene Plätze
        sc = clear[ys, xs]
        idx = np.argsort(-sc)[:4000]
        pts2 = pts[idx]
        best, bd = None, -1
        for i in range(0, len(pts2), 3):
            dist = np.hypot(*(pts2 - pts2[i]).T)
            j = int(np.argmax(dist))
            if dist[j] > bd:
                bd, best = dist[j], (pts2[i], pts2[j])
        a, b = best
        # etwas zur Mitte ziehen, damit Basen nicht am Rand kleben
        cx, cy = W / 2, H / 2
        bases = [snap(a[0] + (cx - a[0]) * 0.12, a[1] + (cy - a[1]) * 0.12, 9),
                 snap(b[0] + (cx - b[0]) * 0.12, b[1] + (cy - b[1]) * 0.12, 9)]
    if bases[0][0] > bases[1][0]:
        bases.reverse()

    def nearest_name(x, y):
        best, bd = None, 1e9
        for l in labels:
            dd = math.hypot(l["x"] - x, l["y"] - y)
            if dd < bd and len(l["t"]) < 26:
                bd, best = dd, l["t"]
        return best if bd < 160 else None

    base_out = [dict(x=r1(x), y=r1(y), n=nearest_name(x, y)) for x, y in bases]

    # Rampen, Kisten, Pickups
    occupied = []

    def far_ok(x, y, mind):
        if any(math.hypot(x - bx, y - by) < 40 for bx, by in bases):
            return False
        return all(math.hypot(x - ox, y - oy) >= mind for ox, oy in occupied)

    ramps = []
    cand = [r for r in roads if r["k"] <= 2]
    rnd.shuffle(cand)
    for rd in cand:
        if len(ramps) >= 12:
            break
        pts = list(zip(rd["p"][0::2], rd["p"][1::2]))
        for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
            l = math.hypot(x2 - x1, y2 - y1)
            if l < 20:
                continue
            cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
            ix, iy = int(cx / C), int(cy / C)
            if not (0 <= ix < gw and 0 <= iy < gh) or not main[iy, ix] or clear[iy, ix] < 5.5:
                continue
            if not far_ok(cx, cy, 70):
                continue
            a = math.atan2(y2 - y1, x2 - x1)
            if rnd.random() < 0.5:
                a += math.pi
            ramps.append(dict(x=r1(cx), y=r1(cy), a=round(a, 3)))
            occupied.append((cx, cy))
            break

    ys, xs = np.nonzero(main & (clear >= 6))
    order = list(range(len(xs)))
    rnd.shuffle(order)
    crates, pickups = [], []
    for i in order:
        x, y = float(xs[i] * C), float(ys[i] * C)
        if len(crates) < 18 and far_ok(x, y, 45):
            crates.append(dict(x=r1(x), y=r1(y), a=round(rnd.random() * 3.14, 2), t=rnd.choice([0, 0, 1, 2])))
            occupied.append((x, y))
        elif len(pickups) < 12 and far_ok(x, y, 50):
            pickups.append(dict(x=r1(x), y=r1(y), t=len(pickups) % 3))
            occupied.append((x, y))
        if len(crates) >= 18 and len(pickups) >= 12:
            break

    out = dict(
        id=m["id"], name=m["name"], sub=m["sub"], w=r1(W), h=r1(H),
        buildings=[{k: v for k, v in b.items() if v is not None} for b in buildings],
        roads=[{k: v for k, v in r.items() if k != "n"} for r in roads],
        areas=[dict(t=k, p=flat(list(pp.exterior.coords)[:-1])) for k, pp in areas],
        water=[flat(list(pp.exterior.coords)[:-1]) for pp in water_polys],
        trees=flat(trees),
        labels=labels, bases=base_out, ramps=ramps, crates=crates, pickups=pickups,
    )

    if preview_dir:
        sc = 1.5
        im = Image.new("RGB", (int(W * sc), int(H * sc)), (70, 75, 70))
        dr = ImageDraw.Draw(im)
        for k, pp in areas:
            dr.polygon([(x * sc, y * sc) for x, y in pp.exterior.coords],
                       fill={"paved": (120, 115, 105), "green": (70, 120, 60), "sand": (200, 180, 120)}[k])
        for r in roads:
            pts = [(x * sc, y * sc) for x, y in zip(r["p"][0::2], r["p"][1::2])]
            dr.line(pts, fill=(100, 100, 100) if r["k"] < 2 else (130, 125, 115), width=max(1, int(r["w"] * sc)))
        for wp in water_polys:
            dr.polygon([(x * sc, y * sc) for x, y in wp.exterior.coords], fill=(40, 90, 160))
        for b in bld_geoms:
            dr.polygon([(x * sc, y * sc) for x, y in b.exterior.coords], fill=(190, 110, 90), outline=(60, 30, 30))
        for x, y in trees:
            dr.ellipse([(x - 1.5) * sc, (y - 1.5) * sc, (x + 1.5) * sc, (y + 1.5) * sc], fill=(30, 90, 30))
        for i, bb in enumerate(base_out):
            col = (230, 40, 40) if i == 0 else (40, 80, 230)
            dr.ellipse([(bb["x"] - 9) * sc, (bb["y"] - 9) * sc, (bb["x"] + 9) * sc, (bb["y"] + 9) * sc], outline=col,
                       width=4)
        for rp in ramps:
            dr.rectangle([(rp["x"] - 3) * sc, (rp["y"] - 3) * sc, (rp["x"] + 3) * sc, (rp["y"] + 3) * sc],
                         fill=(250, 200, 0))
        for c in crates:
            dr.rectangle([(c["x"] - 1.5) * sc, (c["y"] - 1.5) * sc, (c["x"] + 1.5) * sc, (c["y"] + 1.5) * sc],
                         fill=(150, 90, 30))
        im.save(f"{preview_dir}/{m['id']}.png")
    print(m["id"], f"{W:.0f}x{H:.0f}m", len(buildings), "Gebäude", len(roads), "Wege", len(water_polys), "Wasser",
          len(trees), "Bäume", len(labels), "Labels", "Basen:", base_out, file=sys.stderr)
    return out


if __name__ == "__main__":
    osm_dir, out_js = sys.argv[1], sys.argv[2]
    prev = sys.argv[3] if len(sys.argv) > 3 else None
    data = [build(m, osm_dir, prev) for m in MAPS]
    with open(out_js, "w", encoding="utf-8") as f:
        f.write("// Kartendaten (c) OpenStreetMap-Mitwirkende, ODbL – generiert von tools/build_maps.py\n")
        f.write("window.MAPS=" + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n")
