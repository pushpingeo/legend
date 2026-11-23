// The digital SSL: load a catalogue, draw its symbols in MapLibre, and describe it to Claude.

const cache = {};

export async function loadCatalogue(conv) {
  if (!cache[conv]) {
    cache[conv] = fetch(`ssl/${conv}/catalogue.json`)
      .then((r) => r.json())
      .then((cat) => {
        const byBase = new Map();
        for (const s of cat.symbols) {
          // When two symbols share a base code, keep the newer edition (2016 pipelines win).
          const prev = byBase.get(s.base);
          if (!prev || String(s.edition) >= String(prev.edition)) byBase.set(s.base, s);
        }
        return { ...cat, conv, byBase };
      });
  }
  return cache[conv];
}

// ---------- What Claude sees ----------

// Sections worth offering for offshore energy layers. The full SSL also covers lithology,
// fossils, sedimentary structures and so on, which would only add noise (and tokens) here.
const OFFER = [
  /^2\.4$/, // hydrocarbon fields and prospects
  /^3\.2\.2$/, // pipelines and cables (2016)
  /^3\.4\.4$/, // offshore structures and markers
  /^3\.3\.2$/, // concession boundaries
  /^3\.3\.3$/, // area limits offshore
  /^7\./, // wells
];

export function catalogueForClaude(cat) {
  const lines = [];
  let section = "";
  const rows = [...cat.byBase.values()]
    .filter((s) => OFFER.some((re) => re.test(s.section)))
    .sort((a, b) => a.section.localeCompare(b.section, "en", { numeric: true }) || a.base.localeCompare(b.base, "en", { numeric: true }));
  for (const s of rows) {
    if (s.section !== section) {
      section = s.section;
      lines.push(`\n## ${s.section} ${s.section_name} (${s.geometry}s)`);
    }
    lines.push(`${s.base} | ${s.name}`);
  }
  return lines.join("\n").trim();
}

export function isCode(cat, code) {
  return cat.byBase.has(code);
}

// ---------- Drawing ----------

function loadImage(url, px) {
  return new Promise((resolve, reject) => {
    const img = new Image(px * 2, px * 2);
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load " + url));
    img.src = url;
  });
}

// Make sure every symbol used on this map is registered as an image, in the current convention.
// Images are named by base code, so switching convention just swaps the pictures.
export async function ensureImages(map, cat, codes) {
  const jobs = [];
  for (const code of codes) {
    const s = cat.byBase.get(code);
    if (!s) continue;
    const id = `ssl:${cat.conv}:${code}`;
    if (map.hasImage(id)) continue;
    if (s.geometry === "point") {
      jobs.push(loadImage(`ssl/${cat.conv}/${s.point.svg}`, s.point.px).then((img) => {
        if (!map.hasImage(id)) map.addImage(id, img, { pixelRatio: 2 });
      }));
    } else if (s.geometry === "polygon" && s.polygon.pattern) {
      jobs.push(fetch(`ssl/${cat.conv}/${s.polygon.pattern}`).then((r) => r.text()).then((txt) => {
        const m = txt.match(/width="(\d+)"/);
        return loadImage(`ssl/${cat.conv}/${s.polygon.pattern}`, m ? +m[1] : 8);
      }).then((img) => {
        if (!map.hasImage(id)) map.addImage(id, img, { pixelRatio: 2 });
      }));
    }
  }
  await Promise.allSettled(jobs);
}

// MapLibre layers that draw one source in SSL. Features carry their SSL code in `_ssl`.
export function sslLayers(cat, srcId, geometry, codes) {
  const layers = [];
  const known = codes.filter((c) => cat.byBase.has(c));
  if (geometry === "point") {
    layers.push({
      id: `${srcId}-ssl`,
      type: "symbol",
      source: srcId,
      filter: ["in", ["get", "_ssl"], ["literal", known]],
      layout: {
        "icon-image": ["concat", `ssl:${cat.conv}:`, ["get", "_ssl"]],
        "icon-size": ["interpolate", ["linear"], ["zoom"], 4, 0.16, 6, 0.3, 8, 0.55, 10, 0.8, 12, 1],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
        // Producing and suspended wells on top of abandoned ones.
        "symbol-sort-key": ["coalesce", ["get", "_rank"], 0],
      },
      // Abandoned wells (most of them) recede when zoomed out, so the live ones read.
      paint: { "icon-opacity": ["interpolate", ["linear"], ["zoom"], 6, ["case", ["==", ["get", "_rank"], 1], 0.35, 1], 9, 1] },
    });
  } else if (geometry === "line") {
    // Dash patterns can't vary per feature in one MapLibre layer, so one layer per stroke style.
    const groups = new Map();
    for (const c of known) {
      cat.byBase.get(c).line.strokes.forEach((st, i) => {
        const key = `${i}|${st.color}|${st.width}|${(st.dash || []).join(",")}|${st.opacity}`;
        if (!groups.has(key)) groups.set(key, { i, st, codes: [] });
        groups.get(key).codes.push(c);
      });
    }
    [...groups.values()]
      .sort((a, b) => a.i - b.i)
      .forEach((g, n) => {
        const paint = {
          "line-color": g.st.color,
          "line-opacity": g.st.opacity ?? 1,
          "line-width": ["interpolate", ["linear"], ["zoom"], 4, Math.max(0.6, g.st.width * 0.5), 10, g.st.width * 1.2],
        };
        if (g.st.dash) paint["line-dasharray"] = g.st.dash;
        layers.push({
          id: `${srcId}-ssl-${n}`,
          type: "line",
          source: srcId,
          filter: ["in", ["get", "_ssl"], ["literal", g.codes]],
          layout: { "line-cap": g.st.dash ? "butt" : "round", "line-join": "round" },
          paint,
        });
      });
  } else if (geometry === "polygon") {
    for (const c of known) {
      const p = cat.byBase.get(c).polygon;
      const f = ["==", ["get", "_ssl"], c];
      if (p.pattern) {
        layers.push({ id: `${srcId}-ssl-${c}-p`, type: "fill", source: srcId, filter: f, paint: { "fill-pattern": `ssl:${cat.conv}:${c}`, "fill-opacity": 0.85 } });
      } else if (p.fill) {
        layers.push({ id: `${srcId}-ssl-${c}-f`, type: "fill", source: srcId, filter: f, paint: { "fill-color": p.fill, "fill-opacity": 0.75 * (p.opacity ?? 1) } });
      }
      if (p.outline) {
        const paint = { "line-color": p.outline.color, "line-width": Math.max(0.5, p.outline.width), "line-opacity": 0.8 };
        if (p.outline.dash) paint["line-dasharray"] = p.outline.dash;
        layers.push({ id: `${srcId}-ssl-${c}-o`, type: "line", source: srcId, filter: f, paint });
      }
    }
  }
  return layers;
}

// A small picture of a symbol for the legend and mapping tables (HTML string).
export function swatch(cat, code, size = 22) {
  const s = cat.byBase.get(code);
  if (!s) return `<span class="sw missing" title="Not in the SSL">?</span>`;
  if (s.geometry === "point") {
    return `<img class="sw" src="ssl/${cat.conv}/${s.point.svg}" alt="" width="${size}" height="${size}">`;
  }
  if (s.geometry === "line") {
    const paths = s.line.strokes
      .map((st) => `<line x1="2" y1="${size / 2}" x2="${size * 1.6 - 2}" y2="${size / 2}" stroke="${st.color}" stroke-opacity="${st.opacity ?? 1}" stroke-width="${Math.max(1, st.width)}"${st.dash ? ` stroke-dasharray="${st.dash.map((d) => d * Math.max(1, st.width)).join(" ")}"` : ""}/>`)
      .join("");
    return `<svg class="sw" width="${size * 1.6}" height="${size}" viewBox="0 0 ${size * 1.6} ${size}">${paths}</svg>`;
  }
  const p = s.polygon;
  const fill = p.pattern ? `url(ssl/${cat.conv}/${p.pattern})` : p.fill || "transparent";
  const border = p.outline ? `${Math.max(1, p.outline.width)}px ${p.outline.dash ? "dashed" : "solid"} ${p.outline.color}` : "1px solid #bbb";
  return `<span class="sw poly" style="width:${size * 1.4}px;height:${size * 0.8}px;background:${p.pattern ? fill + " repeat, " + (p.fill || "#fff") : fill};border:${border}"></span>`;
}
