// Draw a layer the way its publisher does: translate the ArcGIS renderer from the
// service's drawingInfo into MapLibre layers. Covers simple and unique-value renderers
// with the common marker, line and fill symbols, which is what these services use.

const PT = 4 / 3;

function css(c, fallback = "rgba(0,0,0,0)") {
  if (!Array.isArray(c)) return fallback;
  const [r, g, b, a = 255] = c;
  return `rgba(${r},${g},${b},${(a / 255).toFixed(3)})`;
}

// Paint a simple marker symbol (esriSMS) onto a canvas.
function smsImage(sym) {
  const size = Math.max(4, (sym.size || 6) * PT);
  const ow = sym.outline ? Math.max(0, (sym.outline.width || 0) * PT) : 0;
  const px = Math.ceil(size + ow * 2 + 2);
  const k = 2;
  const cv = document.createElement("canvas");
  cv.width = cv.height = px * k;
  const ctx = cv.getContext("2d");
  ctx.scale(k, k);
  ctx.translate(px / 2, px / 2);
  if (sym.angle) ctx.rotate((-sym.angle * Math.PI) / 180);
  const r = size / 2;
  ctx.beginPath();
  switch (sym.style) {
    case "esriSMSSquare":
      ctx.rect(-r, -r, size, size);
      break;
    case "esriSMSDiamond":
      ctx.moveTo(0, -r); ctx.lineTo(r, 0); ctx.lineTo(0, r); ctx.lineTo(-r, 0); ctx.closePath();
      break;
    case "esriSMSTriangle":
      ctx.moveTo(0, -r); ctx.lineTo(r, r); ctx.lineTo(-r, r); ctx.closePath();
      break;
    case "esriSMSCross":
      ctx.moveTo(-r, 0); ctx.lineTo(r, 0); ctx.moveTo(0, -r); ctx.lineTo(0, r);
      break;
    case "esriSMSX":
      ctx.moveTo(-r, -r); ctx.lineTo(r, r); ctx.moveTo(r, -r); ctx.lineTo(-r, r);
      break;
    default:
      ctx.arc(0, 0, r, 0, Math.PI * 2);
  }
  const lineOnly = sym.style === "esriSMSCross" || sym.style === "esriSMSX";
  if (!lineOnly) {
    ctx.fillStyle = css(sym.color);
    ctx.fill();
  }
  if (ow > 0 || lineOnly) {
    ctx.lineWidth = Math.max(1, ow);
    ctx.strokeStyle = css(sym.outline?.color || sym.color, "#000");
    ctx.stroke();
  }
  return { data: ctx.getImageData(0, 0, cv.width, cv.height), px, url: cv.toDataURL() };
}

function pmsImage(sym) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const w = Math.max(4, (sym.width || 12) * PT);
      const h = Math.max(4, (sym.height || 12) * PT);
      const k = 2;
      const cv = document.createElement("canvas");
      cv.width = Math.ceil(w * k);
      cv.height = Math.ceil(h * k);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      resolve({ data: cv.getContext("2d").getImageData(0, 0, cv.width, cv.height), px: w, url: cv.toDataURL() });
    };
    img.onerror = () => resolve(null);
    img.src = `data:${sym.contentType || "image/png"};base64,${sym.imageData}`;
  });
}

async function markerImage(sym) {
  if (!sym) return null;
  if (sym.type === "esriPMS" && sym.imageData) return pmsImage(sym);
  if (sym.type === "esriSMS") return smsImage(sym);
  return smsImage({ style: "esriSMSCircle", size: 5, color: [120, 120, 120, 255] });
}

const DASH = {
  esriSLSDash: [4, 2],
  esriSLSDot: [1, 2],
  esriSLSDashDot: [4, 2, 1, 2],
  esriSLSDashDotDot: [4, 2, 1, 2, 1, 2],
  esriSLSShortDash: [3, 1],
  esriSLSShortDot: [1, 1],
  esriSLSLongDash: [8, 3],
};

// Values in a renderer that aren't in the data still get a legend line; values in the
// data that the renderer doesn't list use its default symbol (or nothing).
function cases(renderer) {
  if (!renderer) return { field: null, items: [], fallback: null };
  if (renderer.type === "uniqueValue") {
    const fields = [renderer.field1, renderer.field2, renderer.field3].filter(Boolean);
    return {
      field: fields.length === 1 ? fields[0] : null,
      fields,
      delim: renderer.fieldDelimiter || ",",
      items: (renderer.uniqueValueInfos || []).map((u) => ({ value: String(u.value), label: u.label || String(u.value), symbol: u.symbol })),
      fallback: renderer.defaultSymbol ? { label: renderer.defaultLabel || "Other", symbol: renderer.defaultSymbol } : null,
    };
  }
  const sym = renderer.symbol;
  return { field: null, items: [], fallback: sym ? { label: renderer.label || "All features", symbol: sym } : null };
}

function keyExpr(c) {
  if (c.field) return ["to-string", ["coalesce", ["get", c.field], ""]];
  if (c.fields && c.fields.length > 1) {
    const parts = [];
    c.fields.forEach((f, i) => {
      if (i) parts.push(c.delim);
      parts.push(["to-string", ["coalesce", ["get", f], ""]]);
    });
    return ["concat", ...parts];
  }
  return null;
}

// Returns { layers, legend:[{label, html}] } and registers marker images on the map.
export async function nativeLayers(map, srcId, geometry, renderer) {
  const c = cases(renderer);
  const key = keyExpr(c);
  const legend = [];
  const layers = [];

  if (geometry === "point") {
    const imgs = [];
    const entries = [...c.items.map((it, i) => ({ ...it, id: `nat:${srcId}:${i}` }))];
    if (c.fallback) entries.push({ ...c.fallback, value: null, id: `nat:${srcId}:default` });
    for (const e of entries) {
      const im = await markerImage(e.symbol);
      if (!im) continue;
      if (!map.hasImage(e.id)) map.addImage(e.id, im.data, { pixelRatio: 2 });
      imgs.push(e);
      legend.push({ label: e.label, html: `<img class="sw" src="${im.url}" width="${Math.min(22, im.px)}" alt="">` });
    }
    let image;
    if (key && c.items.length) {
      image = ["match", key];
      imgs.filter((e) => e.value !== null).forEach((e) => image.push(e.value, e.id));
      image.push(imgs.find((e) => e.value === null)?.id || "");
    } else {
      image = imgs[0]?.id || "";
    }
    layers.push({
      id: `${srcId}-nat`,
      type: "symbol",
      source: srcId,
      layout: {
        "icon-image": image,
        "icon-size": ["interpolate", ["linear"], ["zoom"], 3, 0.6, 8, 1],
        "icon-allow-overlap": true,
        "icon-ignore-placement": true,
      },
    });
  } else if (geometry === "line") {
    const all = [...c.items, ...(c.fallback ? [{ ...c.fallback, value: null }] : [])];
    const color = key && c.items.length ? ["match", key] : null;
    const width = key && c.items.length ? ["match", key] : null;
    for (const e of c.items) {
      color.push(e.value, css(e.symbol?.color, "#888"));
      width.push(e.value, Math.max(0.5, (e.symbol?.width || 1) * PT));
    }
    const fb = c.fallback?.symbol;
    if (color) {
      color.push(fb ? css(fb.color) : "rgba(0,0,0,0)");
      width.push(fb ? Math.max(0.5, (fb.width || 1) * PT) : 0);
    }
    const paint = { "line-color": color || css(fb?.color, "#888"), "line-width": width || Math.max(0.5, (fb?.width || 1) * PT) };
    const dash = DASH[(c.items[0] || c.fallback)?.symbol?.style];
    if (dash) paint["line-dasharray"] = dash;
    layers.push({ id: `${srcId}-nat`, type: "line", source: srcId, layout: { "line-join": "round", "line-cap": "round" }, paint });
    for (const e of all) {
      const w = Math.max(1.5, (e.symbol?.width || 1) * PT);
      legend.push({ label: e.label, html: `<svg class="sw" width="34" height="20"><line x1="2" y1="10" x2="32" y2="10" stroke="${css(e.symbol?.color, "#888")}" stroke-width="${w}"/></svg>` });
    }
  } else {
    const all = [...c.items, ...(c.fallback ? [{ ...c.fallback, value: null }] : [])];
    const fill = key && c.items.length ? ["match", key] : null;
    const line = key && c.items.length ? ["match", key] : null;
    for (const e of c.items) {
      fill.push(e.value, css(e.symbol?.color));
      line.push(e.value, css(e.symbol?.outline?.color, "rgba(0,0,0,0)"));
    }
    const fb = c.fallback?.symbol;
    if (fill) {
      fill.push(fb ? css(fb.color) : "rgba(0,0,0,0)");
      line.push(fb ? css(fb.outline?.color, "rgba(0,0,0,0)") : "rgba(0,0,0,0)");
    }
    layers.push({ id: `${srcId}-nat-f`, type: "fill", source: srcId, paint: { "fill-color": fill || css(fb?.color), "fill-opacity": 0.75 } });
    layers.push({ id: `${srcId}-nat-o`, type: "line", source: srcId, paint: { "line-color": line || css(fb?.outline?.color, "#666"), "line-width": 0.8 } });
    for (const e of all) {
      legend.push({ label: e.label, html: `<span class="sw poly" style="width:30px;height:16px;background:${css(e.symbol?.color)};border:1px solid ${css(e.symbol?.outline?.color, "#999")}"></span>` });
    }
  }
  return { layers, legend };
}
