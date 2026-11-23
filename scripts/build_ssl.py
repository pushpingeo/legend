"""Turn the published Shell Standard Legend (Esri style + SSL fonts) into a
machine-readable catalogue that a browser map, or an AI, can use.

    python scripts/build_ssl.py PATH/TO/SSL2012_GreenOil PATH/TO/SSL2012_RedOil

Each argument is an unzipped folder from the Esri styles gallery (it holds a
.stylx file and a "Shell Fonts" folder). Writes, per colour convention:

    ssl/<green|red>/catalogue.json   one entry per symbol: code, name, chapter,
                                     geometry and a simple, renderer-neutral style
    ssl/<green|red>/svg/<code>.svg   point symbols and fill patterns, drawn from
                                     the SSL font glyphs

The .stylx is ArcGIS Pro's style format: a SQLite file whose ITEMS table holds
each symbol as CIM JSON. We only read it. Needs fontTools.
"""

import json
import re
import sqlite3
import sys
from pathlib import Path

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont

OUT = Path(__file__).resolve().parent.parent / "ssl"
PT = 4 / 3  # 1 point = 1.333 CSS px

# Chapters we keep. Logos, colour ramps and the like are left out.
KEEP = re.compile(r"^\s*[2-7]\.")


def rgb(c):
    """CIM colour -> (#rrggbb, opacity)."""
    if not c:
        return None, 1
    v = c.get("values", [])
    t = c.get("type")
    if t == "CIMRGBColor":
        r, g, b = v[:3]
        a = v[3] if len(v) > 3 else 100
    elif t == "CIMCMYKColor":
        cc, m, y, k = v[:4]
        a = v[4] if len(v) > 4 else 100
        r = 255 * (1 - cc / 100) * (1 - k / 100)
        g = 255 * (1 - m / 100) * (1 - k / 100)
        b = 255 * (1 - y / 100) * (1 - k / 100)
    elif t == "CIMGrayColor":
        r = g = b = v[0]
        a = v[1] if len(v) > 1 else 100
    elif t == "CIMHSVColor":
        import colorsys

        h, s, val = v[:3]
        a = v[3] if len(v) > 3 else 100
        r, g, b = (x * 255 for x in colorsys.hsv_to_rgb(h / 360, s / 100, val / 100))
    else:
        return None, 1
    return "#%02x%02x%02x" % tuple(max(0, min(255, round(x))) for x in (r, g, b)), round(a / 100, 3)


class Fonts:
    def __init__(self, folder):
        self.fonts = {}
        for f in Path(folder).glob("*.ttf"):
            t = TTFont(f)
            self.fonts[t["name"].getDebugName(1)] = t

    def glyph(self, family, index):
        """SVG path (em units, y down, centred on the font's frame) for one character."""
        t = self.fonts.get(family)
        if not t:
            return None
        g = t.getBestCmap().get(index)
        if not g:
            return None
        gs = t.getGlyphSet()
        pen = SVGPathPen(gs)
        gs[g].draw(pen)
        hh = t["hhea"]
        asc, desc = hh.ascent, -abs(hh.descent)
        bp = BoundsPen(gs)
        gs[g].draw(bp)
        return {
            "d": pen.getCommands(),
            "upm": t["head"].unitsPerEm,
            "cx": gs[g].width / 2,
            "cy": (asc + desc) / 2,
            "bounds": bp.bounds,
        }


def first(layers, kind):
    return next((l for l in layers if l.get("type") == kind and l.get("enable", True)), None)


def fill_colour(sym):
    """Colour of the first solid fill inside a nested polygon symbol (used by markers)."""
    if not sym:
        return "#000000", 1
    f = first(sym.get("symbolLayers", []), "CIMSolidFill")
    return rgb(f["color"]) if f else ("#000000", 1)


def marker_svg(layers, fonts):
    """Stack a point symbol's marker layers into one SVG. Returns (svg, size_px) or None."""
    parts, size = [], 0
    # CIM draws the first layer on top, so paint in reverse.
    for l in reversed(layers):
        if not l.get("enable", True):
            continue
        s = l.get("size", 10) * PT
        ox, oy = l.get("offsetX", 0) * PT, -l.get("offsetY", 0) * PT
        rot = -l.get("rotation", 0)
        if l["type"] == "CIMCharacterMarker":
            g = fonts.glyph(l.get("fontFamilyName"), l.get("characterIndex"))
            if not g or not g["d"]:
                continue
            col, op = fill_colour(l.get("symbol"))
            k = s / g["upm"]
            parts.append(
                f'<g transform="translate({ox:.2f},{oy:.2f}) rotate({rot}) scale({k:.5f},{-k:.5f}) '
                f'translate({-g["cx"]:.1f},{-g["cy"]:.1f})"><path d="{g["d"]}" fill="{col}" '
                f'fill-opacity="{op}"/></g>'
            )
            size = max(size, s * max(1, (g["bounds"][2] - g["bounds"][0]) / g["upm"], (g["bounds"][3] - g["bounds"][1]) / g["upm"]) if g["bounds"] else s)
        elif l["type"] == "CIMVectorMarker":
            fr = l.get("frame") or {"xmin": -5, "ymin": -5, "xmax": 5, "ymax": 5}
            w = max(fr["xmax"] - fr["xmin"], fr["ymax"] - fr["ymin"]) or 1
            k = s / w
            cx, cy = (fr["xmax"] + fr["xmin"]) / 2, (fr["ymax"] + fr["ymin"]) / 2
            for mg in l.get("markerGraphics", []):
                geom = mg.get("geometry", {})
                d = ""
                for key, close in (("rings", True), ("paths", False)):
                    for ring in geom.get(key, []):
                        pts = [p for p in ring if isinstance(p, list) and len(p) >= 2]
                        if pts:
                            d += "M" + "L".join(f"{p[0]:.3f},{p[1]:.3f}" for p in pts) + ("Z" if close else "")
                if "x" in geom and "y" in geom:
                    d += f"M{geom['x']-0.5},{geom['y']}a0.5,0.5 0 1,0 1,0a0.5,0.5 0 1,0 -1,0"
                for ring in geom.get("curveRings", []):
                    # Arcs and Béziers in curveRings: keep the straight vertices only (close enough at symbol size).
                    pts = [p for p in ring if isinstance(p, list) and len(p) >= 2]
                    for p in ring:
                        if isinstance(p, dict):
                            for v in p.values():
                                if isinstance(v, list) and v and isinstance(v[0], list):
                                    pts.append(v[0])
                                elif isinstance(v, dict) and "c" in v:
                                    pts.append(v["c"][0])
                    if pts:
                        d += "M" + "L".join(f"{p[0]:.3f},{p[1]:.3f}" for p in pts) + "Z"
                if not d:
                    continue
                sl = (mg.get("symbol") or {}).get("symbolLayers", [])
                f = first(sl, "CIMSolidFill")
                st = first(sl, "CIMSolidStroke")
                fc, fo = rgb(f["color"]) if f else ("none", 1)
                sc, so = rgb(st["color"]) if st else ("none", 1)
                sw = (st.get("width", 1) * PT / k) if st else 0
                parts.append(
                    f'<g transform="translate({ox:.2f},{oy:.2f}) rotate({rot}) scale({k:.5f},{-k:.5f}) translate({-cx},{-cy})">'
                    f'<path d="{d}" fill="{fc}" fill-opacity="{fo}" stroke="{sc}" stroke-opacity="{so}" '
                    f'stroke-width="{sw:.3f}" stroke-linejoin="round"/></g>'
                )
            size = max(size, s)
        elif l["type"] == "CIMPictureMarker" and str(l.get("url", "")).startswith("data:"):
            parts.append(f'<image href="{l["url"]}" x="{ox - s/2:.2f}" y="{oy - s/2:.2f}" width="{s:.2f}" height="{s:.2f}"/>')
            size = max(size, s)
    if not parts:
        return None
    half = max(4, size * 0.75)
    view = f"{-half:.1f} {-half:.1f} {2*half:.1f} {2*half:.1f}"
    svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{view}" width="{2*half:.0f}" height="{2*half:.0f}">' + "".join(parts) + "</svg>"
    return svg, round(2 * half)


def line_style(sym):
    """Line symbol -> list of strokes, bottom first. Markers along lines are noted, not drawn."""
    strokes, markers = [], False
    for l in reversed(sym.get("symbolLayers", [])):
        if not l.get("enable", True):
            continue
        if l["type"] == "CIMSolidStroke":
            col, op = rgb(l.get("color"))
            s = {"color": col, "opacity": op, "width": round(l.get("width", 1) * PT, 2)}
            for e in l.get("effects", []) or []:
                if e.get("type") == "CIMGeometricEffectDashes" and e.get("dashTemplate"):
                    s["dash"] = [round(x / max(l.get("width", 1), 0.1), 2) for x in e["dashTemplate"]]
                if e.get("type") == "CIMGeometricEffectOffset":
                    s["offset"] = round(e.get("offset", 0) * PT, 2)
            strokes.append(s)
        elif l["type"] in ("CIMCharacterMarker", "CIMVectorMarker", "CIMPictureMarker"):
            markers = True
    return {"strokes": strokes, "has_markers": markers}


def hatch_tile(h, fonts):
    """A hatch fill (parallel lines) as a small repeating SVG tile."""
    sep = max(2, h.get("separation", 5) * PT)
    rot = h.get("rotation", 0)
    ls = (h.get("lineSymbol") or {}).get("symbolLayers", [])
    st = first(ls, "CIMSolidStroke")
    col, op = rgb(st["color"]) if st else ("#000000", 1)
    w = (st.get("width", 0.5) if st else 0.5) * PT
    n = round(sep)
    # Draw horizontal lines and rotate the tile content; use a square tile big enough to repeat cleanly
    # for 0/45/90/135 degrees, which covers the SSL's hatches.
    if rot % 90 == 0:
        if rot % 180 == 0:
            body = f'<line x1="0" y1="{n/2}" x2="{n}" y2="{n/2}" stroke="{col}" stroke-opacity="{op}" stroke-width="{w:.2f}"/>'
        else:
            body = f'<line x1="{n/2}" y1="0" x2="{n/2}" y2="{n}" stroke="{col}" stroke-opacity="{op}" stroke-width="{w:.2f}"/>'
        return n, body
    n = round(sep * 1.4142)
    if (rot % 180) == 45:
        body = f'<path d="M0,{n} L{n},0 M{-n},{n} L{n},{-n} M0,{2*n} L{2*n},0" stroke="{col}" stroke-opacity="{op}" stroke-width="{w:.2f}"/>'
    else:
        body = f'<path d="M0,0 L{n},{n} M{-n},0 L{n},{2*n} M0,{-n} L{2*n},{n}" stroke="{col}" stroke-opacity="{op}" stroke-width="{w:.2f}"/>'
    return n, body


def polygon_style(sym, fonts):
    out = {"fill": None, "opacity": 1, "outline": None, "pattern": None}
    tiles, tile_n = [], 0
    for l in reversed(sym.get("symbolLayers", [])):
        if not l.get("enable", True):
            continue
        t = l["type"]
        if t == "CIMSolidFill" and out["fill"] is None and not tiles:
            out["fill"], out["opacity"] = rgb(l.get("color"))
        elif t == "CIMSolidFill":
            # A second solid fill above a pattern: put it in the tile as background is wrong; keep the first.
            pass
        elif t == "CIMSolidStroke":
            col, op = rgb(l.get("color"))
            o = {"color": col, "opacity": op, "width": round(l.get("width", 0.4) * PT, 2)}
            for e in l.get("effects", []) or []:
                if e.get("type") == "CIMGeometricEffectDashes" and e.get("dashTemplate"):
                    o["dash"] = [round(x / max(l.get("width", 1), 0.1), 2) for x in e["dashTemplate"]]
            out["outline"] = o
        elif t == "CIMHatchFill":
            n, body = hatch_tile(l, fonts)
            tiles.append(body)
            tile_n = max(tile_n, n)
        elif t == "CIMCharacterMarker":
            g = fonts.glyph(l.get("fontFamilyName"), l.get("characterIndex"))
            if g and g["d"]:
                col, op = fill_colour(l.get("symbol"))
                s = l.get("size", 8) * PT
                pl = l.get("markerPlacement") or {}
                step = max(s, (pl.get("stepX") or s * 2) * PT)
                k = s / g["upm"]
                n = round(step)
                tiles.append(
                    f'<g transform="translate({n/2:.2f},{n/2:.2f}) scale({k:.5f},{-k:.5f}) translate({-g["cx"]:.1f},{-g["cy"]:.1f})">'
                    f'<path d="{g["d"]}" fill="{col}" fill-opacity="{op}"/></g>'
                )
                tile_n = max(tile_n, n)
    if tiles:
        out["pattern_svg"] = (
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{tile_n}" height="{tile_n}" viewBox="0 0 {tile_n} {tile_n}" overflow="hidden">'
            + (f'<rect width="{tile_n}" height="{tile_n}" fill="{out["fill"]}" fill-opacity="{out["opacity"]}"/>' if out["fill"] else "")
            + "".join(tiles)
            + "</svg>"
        )
    return out


def safe(code):
    return re.sub(r"[^A-Za-z0-9_-]", "_", code)


def build(folder, variant):
    folder = Path(folder)
    stylx = next(folder.glob("*.stylx"))
    fonts = Fonts(folder / "Shell Fonts")
    db = sqlite3.connect(stylx)
    out_dir = OUT / variant
    (out_dir / "svg").mkdir(parents=True, exist_ok=True)
    cat, seen, skipped = [], set(), 0
    for cls, category, name, content in db.execute("select CLASS, CATEGORY, NAME, CONTENT from ITEMS where CLASS in (3,4,5) order by ID"):
        category = " ".join((category or "").split())
        if not KEEP.match(category):
            continue
        name = " ".join(name.split())
        code, _, desc = name.partition(" ")
        if code in seen:
            code = f"{code}~{len([c for c in seen if c.split('~')[0] == code])}"
        seen.add(code)
        sym = json.loads(content.strip().split("\n")[0].rstrip("\x00 "))
        section, _, section_name = category.partition(" ")
        e = {"code": code, "name": desc or code, "section": section, "section_name": section_name}
        if cls == 3:
            r = marker_svg(sym.get("symbolLayers", []), fonts)
            if not r:
                skipped += 1
                continue
            svg, px = r
            f = f"svg/{safe(code)}.svg"
            (out_dir / f).write_text(svg)
            e.update(geometry="point", point={"svg": f, "px": px})
        elif cls == 4:
            e.update(geometry="line", line=line_style(sym))
            if not e["line"]["strokes"]:
                skipped += 1
                continue
        else:
            p = polygon_style(sym, fonts)
            if p.pop("pattern_svg", None) is not None:
                f = f"svg/{safe(code)}.fill.svg"
                (out_dir / f).write_text(polygon_style(sym, fonts)["pattern_svg"])
                p["pattern"] = f
            if not (p["fill"] or p["pattern"] or p["outline"]):
                skipped += 1
                continue
            e.update(geometry="polygon", polygon=p)
        cat.append(e)
    meta = {
        "title": "Shell Standard Legend (SSL2012), machine-readable",
        "convention": "oil=green, gas=red" if variant == "green" else "oil=red, gas=green",
        "source": "Esri styles gallery item '" + folder.name + "', as released by Shell via IOGP",
        "note": "Generated by scripts/build_ssl.py. Styles are simplified for web maps: markers along lines are not drawn.",
        "count": len(cat),
    }
    (out_dir / "catalogue.json").write_text(json.dumps({"meta": meta, "symbols": cat}, separators=(",", ":")))
    print(f"{variant}: {len(cat)} symbols ({skipped} skipped, no drawable layers)")


# The 2012 Esri style predates the 2016 revision of the pipelines chapter, and its
# pipeline symbols didn't follow the oil colour convention (oil is red in both
# editions). These are the 2016 pipeline symbols (SSL 2016, section 3.2.2, pages 10-11),
# transcribed by hand from the two PDFs. Codes are the RED edition's; the GREEN
# edition adds a "1" to codes whose colour depends on the convention.
OIL_G, GAS_R, OIL_R, GAS_G = "#6abd45", "#ec2227", "#ec2227", "#6abd45"
P2016 = [
    # base code, name, colour in green edition, colour in red edition, kind
    ("322006", "Pipeline oil", OIL_G, OIL_R, "solid"),
    ("322007", "Pipeline condensate", "#faa51a", "#faa51a", "solid"),
    ("322008", "Pipeline gas", GAS_R, GAS_G, "solid"),
    ("322009", "Pipeline water", "#41bbec", "#41bbec", "solid"),
    ("322011", "Pipeline chemical", "#8b8b8b", "#8b8b8b", "solid"),
    ("322012", "Pipeline gas water condensate", "#6f80a2", "#6f80a2", "solid"),
    ("322013", "Pipeline other", "#6b6b6b", "#6b6b6b", "solid"),
    ("322005", "Pipeline proposed", "#000000", "#000000", "dotted"),
    ("322014", "Pipeline oil (buried)", OIL_G, OIL_R, "dashed"),
    ("322015", "Pipeline condensate (buried)", "#faa51a", "#faa51a", "dashed"),
    ("322016", "Pipeline gas (buried)", GAS_R, GAS_G, "dashed"),
    ("322017", "Pipeline water (buried)", "#41bbec", "#41bbec", "dashed"),
    ("322019", "Pipeline chemical (buried)", "#8b8b8b", "#8b8b8b", "dashed"),
    ("322020", "Pipeline gas water condensate (buried)", "#6f80a2", "#6f80a2", "dashed"),
    ("322021", "Pipeline oil (not in use)", OIL_G, OIL_R, "disused"),
    ("322022", "Pipeline condensate (not in use)", "#faa51a", "#faa51a", "disused"),
    ("322023", "Pipeline gas (not in use)", GAS_R, GAS_G, "disused"),
    ("322024", "Pipeline water (not in use)", "#41bbec", "#41bbec", "disused"),
    ("322025", "Pipeline chemical (not in use)", "#8b8b8b", "#8b8b8b", "disused"),
    ("322026", "Pipeline water condensate (not in use)", "#6f80a2", "#6f80a2", "disused"),
    ("322027", "Pipeline other (not in use)", "#6b6b6b", "#6b6b6b", "disused"),
    ("322028", "Pipeline not in use", "#a5a5a5", "#a5a5a5", "disused"),
    ("322001", "Cable (power, telecom)", "#8b8b8b", "#8b8b8b", "thin"),
    ("322002", "Cable (power, telecom) buried", "#8b8b8b", "#8b8b8b", "thindash"),
    ("322003", "Cable proposed", "#8b8b8b", "#8b8b8b", "dotted"),
    ("322004", "Cable (not in use)", "#8b74a9", "#8b74a9", "disused"),
]


def pipeline_2016(variant):
    out = []
    for base, name, cg, cr, kind in P2016:
        col = cg if variant == "green" else cr
        flips = cg != cr
        code = base + ("1" if flips and variant == "green" else "")
        if kind == "solid":
            strokes = [{"color": col, "opacity": 1, "width": 2}]
        elif kind == "dashed":
            strokes = [{"color": col, "opacity": 1, "width": 2, "dash": [3, 2]}]
        elif kind == "dotted":
            strokes = [{"color": col, "opacity": 1, "width": 1.5, "dash": [0.6, 1.2]}]
        elif kind == "thin":
            strokes = [{"color": col, "opacity": 1, "width": 1}]
        elif kind == "thindash":
            strokes = [{"color": col, "opacity": 1, "width": 1, "dash": [4, 3]}]
        else:  # not in use: grey casing with a thin coloured core
            strokes = [{"color": "#a5a5a5", "opacity": 1, "width": 3.5}, {"color": col, "opacity": 1, "width": 1}]
        out.append({
            "code": code, "base": base, "name": name, "section": "3.2.2", "section_name": "Pipelines and Cables",
            "edition": "2016", "geometry": "line", "line": {"strokes": strokes, "has_markers": False},
        })
    return out


def suspended_series(variant, symbols):
    """The 2012 style has no 'suspended' well series (the 2016 PDF does: W010X ... W330X).
    The SSL's well symbols are a grammar: the producing symbol plus a diagonal stroke
    means suspended. So build them from that rule rather than drawing them by hand."""
    out, have = [], {s["code"] for s in symbols}
    for s in symbols:
        c = s["code"]
        if not (s.get("section") == "7.4" and c.startswith("W") and c.endswith("P")):
            continue
        x = c[:-1] + "X"
        if x in have:
            continue
        svg = (OUT / variant / s["point"]["svg"]).read_text()
        r = 24 * 0.275 * 1.4  # circle radius of an 18 pt well glyph, plus a little overhang
        svg = svg.replace("</svg>", f'<line x1="{-r:.1f}" y1="{r:.1f}" x2="{r:.1f}" y2="{-r:.1f}" stroke="#000" stroke-width="1.6" stroke-linecap="round"/></svg>')
        f = f"svg/{x}.svg"
        (OUT / variant / f).write_text(svg)
        out.append({
            "code": x, "base": x, "name": s["name"].replace("Producing", "Suspended"),
            "section": "7.5b", "section_name": "Suspended Wells", "edition": "2016 (built from the 2012 glyphs)",
            "geometry": "point", "point": {"svg": f, "px": s["point"]["px"]},
        })
    return out


def add_bases():
    """Give every symbol a convention-neutral 'base' code (the RED edition's code), so a
    mapping written once works with either colour convention."""
    cats = {v: json.loads((OUT / v / "catalogue.json").read_text()) for v in ("green", "red")}
    red_by_name = {(s["section"], s["name"]): s["code"] for s in cats["red"]["symbols"]}
    red_codes = {s["code"] for s in cats["red"]["symbols"]}
    for v, cat in cats.items():
        for s in cat["symbols"]:
            s.setdefault("edition", "2012")
            if v == "red" or s["code"] in red_codes:
                s["base"] = s["code"]
            else:
                s["base"] = red_by_name.get((s["section"], s["name"]), s["code"])
        cat["symbols"] += pipeline_2016(v)
        cat["symbols"] += suspended_series(v, cat["symbols"])
        cat["meta"]["count"] = len(cat["symbols"])
        (OUT / v / "catalogue.json").write_text(json.dumps(cat, separators=(",", ":")))
    differ = sum(1 for s in cats["green"]["symbols"] if s["base"] != s["code"])
    print(f"{differ} green-edition codes differ from their red-edition base code")


if __name__ == "__main__":
    green, red = sys.argv[1:3]
    build(green, "green")
    build(red, "red")
    add_bases()
