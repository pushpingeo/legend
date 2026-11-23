import { CONFIG } from "./config.js";
import { liveMode, setUserKey, getUserKey, LimitReached } from "./claude.js";
import { loadCatalogue, ensureImages, sslLayers, swatch } from "./ssl.js";
import { nativeLayers } from "./native.js";
import { profileLayer, askClaude, applyMapping } from "./mapping.js";
import { ensureSwipe, showSwipe } from "./swipe.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const state = {
  mode: "ssl",
  conv: "green",
  cat: null,
  maps: {},
  layers: [], // { meta, data, mapping, saved, tally, legend, nativeIds, sslIds }
};

const THEME_ORDER = ["fields", "licences", "other", "pipelines", "platforms", "wells"];
const THEME_LABEL = { wells: "Wells", pipelines: "Pipelines", platforms: "Installations", fields: "Fields", licences: "Licences", other: "Other" };
const REGION_LABEL = { north_sea: "UK North Sea", gulf: "US Gulf", custom: "Your layer" };

// ---------- status ----------

function setStatus() {
  const m = liveMode();
  $("#status").textContent = m === "own-key" ? "Live · your key" : m === "proxy" ? "Live · shared proxy" : "Saved mappings only";
  $("#status").className = "status " + m;
}

// ---------- maps ----------

function makeMap(region, view) {
  let map;
  try {
    map = new maplibregl.Map({
    container: `map-${region}`,
    style: CONFIG.basemapStyle,
    center: view.center,
    zoom: view.zoom,
    attributionControl: { compact: true },
    cooperativeGestures: matchMedia("(pointer: coarse)").matches,
    });
  } catch (e) {
    // No WebGL (some locked-down or headless browsers). Claude's mappings and the legend still work.
    console.warn("Map unavailable:", e);
    $(`#map-${region}`).innerHTML = `<p class="nomap">This browser can't draw the map (WebGL is off or unavailable). The legend and Claude's mappings below still work.</p>`;
    return Promise.resolve(null);
  }
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  map.on("click", (e) => popup(map, e));
  state.maps[region] = map;
  return new Promise((resolve) => {
    if (map.loaded()) resolve(map);
    else map.once("load", () => resolve(map));
    // A basemap that won't load shouldn't stop the data from drawing.
    map.once("error", () => setTimeout(() => resolve(map), 1500));
  });
}

function popup(map, e, overlay = false) {
  const ids = overlay
    ? state.layers.flatMap((l) => l.swipeIds || [])
    : state.layers.filter((l) => l.map === map).flatMap((l) => (state.mode === "native" ? l.nativeIds : l.sslIds));
  const hits = map.queryRenderedFeatures([[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]], { layers: ids.filter((id) => map.getLayer(id)) });
  if (!hits.length) return;
  const f = hits[0];
  const layer = state.layers.find((l) => f.source === l.srcId);
  if (!layer) return;
  const p = f.properties;
  const s = state.cat.byBase.get(p._ssl);
  const rows = layer.meta.fields
    .filter((k) => p[k] !== undefined && p[k] !== null && p[k] !== "")
    .map((k) => `<tr><th>${esc(layer.meta.aliases?.[k] || k)}</th><td>${esc(fmt(p[k], layer.meta.fieldTypes?.[k]))}</td></tr>`)
    .join("");
  const ssl = s
    ? `<div class="pop-ssl">${swatch(state.cat, p._ssl, 26)}<div><b>${esc(s.name)}</b><br><span class="code">SSL ${esc(p._ssl)}</span> · ${confBadge(+p._conf)}</div></div>`
    : "";
  new maplibregl.Popup({ maxWidth: "320px" })
    .setLngLat(e.lngLat)
    .setHTML(`<div class="pop"><div class="pop-title">${esc(layer.meta.title)}</div>${ssl}<table>${rows}</table></div>`)
    .addTo(map);
}

function fmt(v, type) {
  if (type === "esriFieldTypeDate" && typeof v === "number") return new Date(v).toISOString().slice(0, 10);
  return v;
}

function confBadge(c) {
  if (!isFinite(c)) return "";
  const cls = c >= 0.85 ? "hi" : c >= 0.6 ? "mid" : "lo";
  return `<span class="conf ${cls}" title="Claude's confidence">${Math.round(c * 100)}%</span>`;
}

// ---------- layers ----------

async function addLayer(layer) {
  const map = layer.map;
  layer.srcId = `src-${layer.meta.id}`;
  if (layer.mapping) layer.tally = applyMapping(state.cat, layer.mapping, layer.data.features);
  layer.nativeIds = layer.nativeIds || [];
  layer.sslIds = layer.sslIds || [];
  if (!map) return applyMode();
  if (map.getSource(layer.srcId)) map.getSource(layer.srcId).setData(layer.data);
  else map.addSource(layer.srcId, { type: "geojson", data: layer.data });

  const geom = layer.geometry;
  const nat = await nativeLayers(map, layer.srcId, geom, layer.meta.renderer);
  layer.legend = nat.legend;
  layer.nativeIds = nat.layers.map((l) => l.id);
  for (const l of nat.layers) if (!map.getLayer(l.id)) map.addLayer(l, beforeId(map, layer));
  await drawSSL(layer);
  applyMode();
}

async function drawSSL(layer) {
  const map = layer.map;
  if (!map) return;
  for (const id of layer.sslIds || []) if (map.getLayer(id)) map.removeLayer(id);
  layer.sslIds = [];
  if (!layer.tally) return;
  const codes = layer.tally.map((t) => t.code);
  await ensureImages(map, state.cat, codes);
  const ls = sslLayers(state.cat, layer.srcId, layer.geometry, codes);
  for (const l of ls) map.addLayer(l, beforeId(map, layer));
  layer.sslIds = ls.map((l) => l.id);
}

// Keep polygons under lines under points, whatever order layers arrive in.
function beforeId(map, layer) {
  const rank = THEME_ORDER.indexOf(layer.meta.theme);
  const above = state.layers
    .filter((l) => l.map === map && l !== layer && THEME_ORDER.indexOf(l.meta.theme) > rank)
    .flatMap((l) => [...(l.nativeIds || []), ...(l.sslIds || [])])
    .find((id) => map.getLayer(id));
  return above;
}

function applyMode() {
  for (const l of state.layers.filter((x) => x.map)) {
    for (const id of l.nativeIds || []) l.map.getLayer(id) && l.map.setLayoutProperty(id, "visibility", state.mode === "native" ? "visible" : "none");
    for (const id of l.sslIds || []) l.map.getLayer(id) && l.map.setLayoutProperty(id, "visibility", state.mode !== "native" ? "visible" : "none");
  }
  document.body.dataset.mode = state.mode;
  renderLegend();
  syncSwipe();
}

// Swipe: the SSL underneath, each publisher's own styling on top, clipped at the divider.
let swipeJob = Promise.resolve();
function syncSwipe() {
  swipeJob = swipeJob.then(async () => {
    if (state.mode !== "swipe") return showSwipe(false);
    for (const [region, map] of Object.entries(state.maps)) {
      if (!map) continue;
      const layers = [...state.layers.filter((l) => l.region === region)].sort((a, b) => THEME_ORDER.indexOf(a.meta.theme) - THEME_ORDER.indexOf(b.meta.theme));
      await ensureSwipe(region, map, layers, { style: CONFIG.basemapStyle, onClick: (m, e) => popup(m, e, true) });
    }
    showSwipe(state.mode === "swipe");
  }).catch((e) => console.warn("Swipe unavailable:", e));
}

// ---------- legend ----------

function nativeLegendHTML() {
  const regions = [...new Set(state.layers.map((l) => l.region))];
  return regions
      .map((r) => {
        const ls = state.layers.filter((l) => l.region === r).sort((a, b) => THEME_ORDER.indexOf(b.meta.theme) - THEME_ORDER.indexOf(a.meta.theme));
        return `<div class="lg-region"><h3>${esc(REGION_LABEL[r])}</h3>${ls
          .map((l) => `<div class="lg-layer"><div class="lg-lname">${esc(l.meta.title)}</div>${(l.legend || []).map((it) => `<div class="lg-row">${it.html}<span>${esc(it.label)}</span></div>`).join("")}</div>`)
          .join("")}</div>`;
      })
      .join("");
}

function renderLegend() {
  const box = $("#legend");
  if (state.mode === "native") {
    $("#legend-title").textContent = "Legend, as each publisher draws it";
    box.innerHTML = nativeLegendHTML();
    return;
  }
  $("#legend-title").textContent = state.mode === "swipe" ? "SSL legend (right of the divider)" : "One legend for both maps";
  const regions = [...new Set(state.layers.map((l) => l.region))];
  const byTheme = new Map();
  for (const l of state.layers) {
    for (const t of l.tally || []) {
      const theme = l.meta.theme;
      if (!byTheme.has(theme)) byTheme.set(theme, new Map());
      const m = byTheme.get(theme);
      if (!m.has(t.code)) m.set(t.code, {});
      m.get(t.code)[l.region] = (m.get(t.code)[l.region] || 0) + t.n;
    }
  }
  if (!byTheme.size) {
    box.innerHTML = `<p class="muted">No layer has been mapped yet.</p>`;
    return;
  }
  const head = `<tr><th></th><th></th>${regions.map((r) => `<th class="n">${esc(REGION_LABEL[r])}</th>`).join("")}</tr>`;
  box.innerHTML =
    `<p class="muted small">SSL ${state.conv === "green" ? "GREEN edition: oil green, gas red" : "RED edition: oil red, gas green"}. Counts are features per map.</p>` +
    [...byTheme.entries()]
      .sort((a, b) => THEME_ORDER.indexOf(b[0]) - THEME_ORDER.indexOf(a[0]))
      .map(([theme, codes]) => {
        const rows = [...codes.entries()]
          .sort((a, b) => sumv(b[1]) - sumv(a[1]))
          .map(([code, n]) => {
            const s = state.cat.byBase.get(code);
            return `<tr><td class="sw-cell">${swatch(state.cat, code)}</td><td>${esc(s?.name || code)} <span class="code">${esc(code)}</span></td>${regions
              .map((r) => `<td class="n">${n[r] ? n[r].toLocaleString() : "·"}</td>`)
              .join("")}</tr>`;
          })
          .join("");
        return `<h3>${esc(THEME_LABEL[theme] || theme)}</h3><table class="lg-table">${head}${rows}</table>`;
      })
      .join("");
  if (state.mode === "swipe") box.innerHTML += `<details class="lg-native"><summary>As published, for comparison</summary>${nativeLegendHTML()}</details>`;
}

const sumv = (o) => Object.values(o).reduce((a, b) => a + b, 0);

// ---------- mapping cards ----------

function renderMappings() {
  $("#mappings-note").textContent =
    "Claude saw a profile of each layer (fields, values and counts, not the features) and the SSL catalogue, then wrote these rules. Confidence is Claude's own estimate.";
  $("#mappings").innerHTML = state.layers.map(mappingCard).join("");
  for (const btn of document.querySelectorAll("[data-remap]")) btn.onclick = () => remap(btn.dataset.remap);
}

function mappingCard(l) {
  const m = l.mapping;
  const origin = l.saved
    ? `Saved run · ${esc(l.saved.model)} · ${esc(l.saved.created)}`
    : l.live
      ? `Live run · ${esc(CONFIG.model)} · just now`
      : "Not mapped yet";
  const btn = liveMode() === "offline" ? "" : `<button class="ghost small" data-remap="${esc(l.meta.id)}">${m ? "Ask Claude again" : "Map with Claude"}</button>`;
  if (!m) {
    return `<details class="mcard"><summary><b>${esc(REGION_LABEL[l.region])} · ${esc(l.meta.title)}</b><span class="muted small">${origin}</span></summary>${btn}</details>`;
  }
  const rows = [];
  (m.rules || []).forEach((r, i) => {
    const t = l.tally?.find((x) => x.code === r.code && x.via.includes(`rule:${i}`));
    rows.push(`<tr><td>${r.when.map((c) => `<span class="cond">${esc(c.field)} = ${c.in.map((v) => esc(v === "" ? "(empty)" : v)).join(" / ")}</span>`).join(" and ")}</td><td class="sw-cell">${swatch(state.cat, r.code)}</td><td><span class="code">${esc(r.code)}</span> ${confBadge(r.confidence)}${r.note ? `<div class="note">${esc(r.note)}</div>` : ""}</td></tr>`);
  });
  let comp = "";
  if (m.composite?.parts?.length) {
    comp =
      `<p class="small">Otherwise build the code <span class="code">${esc(m.composite.template)}</span> from:</p>` +
      m.composite.parts
        .map(
          (p) =>
            `<div class="part"><div class="part-h">{${esc(p.name)}} from <span class="code">${esc(p.field)}</span></div>${p.values
              .map((v) => `<div class="pv"><span>${esc(v.value || "(empty)")}</span><span class="tok">${esc(v.token)}</span>${confBadge(v.confidence)}${v.note ? `<span class="note">${esc(v.note)}</span>` : ""}</div>`)
              .join("")}<div class="pv muted"><span>anything else</span><span class="tok">${esc(p.default_token)}</span></div></div>`,
        )
        .join("");
  }
  const tally = (l.tally || [])
    .slice(0, 14)
    .map((t) => `<span class="tchip" title="${esc(state.cat.byBase.get(t.code)?.name || t.code)}">${swatch(state.cat, t.code, 18)}${t.n.toLocaleString()}${t.fell ? ` <i class="warn" title="${t.fell} fell back to the default">!</i>` : ""}</span>`)
    .join("");
  const caveats = (m.caveats || []).map((c) => `<li>${esc(c)}</li>`).join("");
  return `<details class="mcard"><summary><b>${esc(REGION_LABEL[l.region])} · ${esc(l.meta.title)}</b><span class="muted small">${origin}</span></summary>
    <p>${esc(m.summary)}</p>
    ${rows.length ? `<table class="rules">${rows.join("")}</table>` : ""}
    ${comp}
    <p class="small">Default: <span class="code">${esc(m.default_code)}</span> ${swatch(state.cat, m.default_code, 18)}</p>
    ${caveats ? `<ul class="caveats">${caveats}</ul>` : ""}
    <div class="tally">${tally}</div>
    ${btn}
  </details>`;
}

// ---------- Claude ----------

async function runClaude(layer, log) {
  const profile = profileLayer(layer.meta, layer.data.features);
  const r = await askClaude(state.cat, profile, layer.data.features, log);
  layer.mapping = r.mapping;
  layer.live = true;
  layer.saved = null;
  layer.lastRun = { model: CONFIG.model, created: new Date().toISOString().slice(0, 10), mapping: r.mapping, usage: r.usage, rounds: r.rounds, unresolved: r.check.errors };
  exportRuns();
  return r;
}

async function remap(id) {
  const layer = state.layers.find((l) => l.meta.id === id);
  const btn = document.querySelector(`[data-remap="${id}"]`);
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Claude is reading the layer…";
  }
  try {
    const r = await runClaude(layer, (s) => btn && (btn.textContent = s));
    layer.tally = applyMapping(state.cat, layer.mapping, layer.data.features);
    layer.map?.getSource(layer.srcId)?.setData(layer.data);
    await drawSSL(layer);
    applyMode();
    renderMappings();
    if (r.check.errors.length) console.warn("Unresolved after retry:", r.check.errors);
  } catch (e) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = e instanceof LimitReached ? e.message : "Failed: " + e.message;
    }
  }
}

// For the repo: the latest live run of each layer, as JSON, at ?export.
function exportRuns() {
  if (!location.search.includes("export")) return;
  let pre = $("#export");
  if (!pre) {
    pre = document.createElement("pre");
    pre.id = "export";
    document.body.append(pre);
  }
  const runs = Object.fromEntries(state.layers.filter((l) => l.lastRun).map((l) => [l.meta.id, l.lastRun]));
  pre.textContent = JSON.stringify(runs);
  window.__runs = runs;
}

// ---------- another service ----------

const SKIP_TYPES = new Set(["esriFieldTypeOID", "esriFieldTypeGlobalID", "esriFieldTypeGeometry", "esriFieldTypeBlob", "esriFieldTypeRaster", "esriFieldTypeXML"]);

async function tryService(url) {
  const log = (t) => ($("#try-log").innerHTML = t);
  url = url.trim().replace(/\/+$/, "").replace(/\/query.*$/, "");
  if (!/\/(Feature|Map)Server\/\d+$/i.test(url)) {
    log(`That doesn't look like a layer URL. It should end in <span class="code">/FeatureServer/0</span> (or another layer number).`);
    return;
  }
  $("#try-go").disabled = true;
  try {
    log("Reading the service…");
    const meta = await fetch(url + "?f=json").then((r) => r.json());
    if (meta.error) throw new Error(meta.error.message || "The service returned an error.");
    if (!meta.geometryType) throw new Error("That layer has no geometry (it may be a table).");
    // Profile a manageable number of fields: drop IDs and geometry, keep the rest up to 30.
    const fields = (meta.fields || []).filter((f) => !SKIP_TYPES.has(f.type) && !/^shape(_|$)/i.test(f.name)).slice(0, 30);
    log("Fetching up to 2,000 features…");
    const q = new URLSearchParams({ where: "1=1", outFields: fields.map((f) => f.name).join(","), outSR: "4326", f: "geojson", resultRecordCount: "2000", geometryPrecision: "5" });
    if (meta.geometryType !== "esriGeometryPoint") q.set("maxAllowableOffset", "0.001");
    const data = await fetch(url + "/query?" + q).then((r) => r.json());
    if (!data.features?.length) throw new Error("No features came back from that layer.");
    data.features = data.features.filter((f) => f.geometry);
    const layerMeta = {
      id: "custom",
      region: "custom",
      theme: "other",
      title: meta.name || "Layer",
      publisher: new URL(url).hostname,
      url,
      fields: fields.map((f) => f.name),
      aliases: Object.fromEntries(fields.map((f) => [f.name, f.alias])),
      fieldTypes: Object.fromEntries(fields.map((f) => [f.name, f.type])),
      renderer: meta.drawingInfo?.renderer,
    };
    // Replace any previous custom layer.
    const old = state.layers.find((l) => l.region === "custom");
    if (old) {
      if (old.map) {
        for (const id of [...old.nativeIds, ...old.sslIds]) old.map.getLayer(id) && old.map.removeLayer(id);
        old.map.removeSource(old.srcId);
      }
      state.layers = state.layers.filter((l) => l !== old);
    }
    $("#panel-custom").classList.remove("hidden");
    $("#custom-title").textContent = layerMeta.title;
    $("#custom-pub").textContent = layerMeta.publisher;
    if (!state.maps.custom) await makeMap("custom", { center: [0, 20], zoom: 1 });
    const map = state.maps.custom || null;
    if (map) {
      map.resize();
      fitTo(map, data.features);
    }
    const layer = { meta: layerMeta, data, region: "custom", map, geometry: geomOf(meta.geometryType) };
    log("Claude is reading the layer…");
    const r = await runClaude(layer, log);
    layer.meta.theme = r.mapping.theme || "other";
    state.layers.push(layer);
    await addLayer(layer);
    renderMappings();
    const n = data.features.length;
    log(`Mapped ${n.toLocaleString()} features${data.exceededTransferLimit || n >= 2000 ? " (the first 2,000)" : ""}. ${r.check.errors.length ? "A few combinations had no SSL symbol and use the default. " : ""}See the mapping below, and click a feature to see why it got its symbol.`);
    $("#panel-custom").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    log(e instanceof LimitReached ? esc(e.message) + " You can add your own API key with ⚙." : "Couldn't map that layer: " + esc(e.message));
  } finally {
    $("#try-go").disabled = false;
  }
}

function geomOf(t) {
  return { esriGeometryPoint: "point", esriGeometryMultipoint: "point", esriGeometryPolyline: "line", esriGeometryPolygon: "polygon" }[t] || "point";
}

function fitTo(map, features) {
  let b = [180, 90, -180, -90];
  const walk = (c) => {
    if (typeof c[0] === "number") {
      b = [Math.min(b[0], c[0]), Math.min(b[1], c[1]), Math.max(b[2], c[0]), Math.max(b[3], c[1])];
    } else c.forEach(walk);
  };
  features.slice(0, 5000).forEach((f) => walk(f.geometry.coordinates));
  if (b[0] <= b[2]) map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 30, maxZoom: 9, duration: 0 });
}

// ---------- start ----------

async function main() {
  setStatus();
  const [index, cat] = await Promise.all([fetch("data/layers.json").then((r) => r.json()), loadCatalogue("green")]);
  state.cat = cat;
  loadCatalogue("red"); // warm the other edition
  $("#fetched").textContent = index[0]?.fetched || "";

  const saved = await Promise.all(index.map((m) => fetch(`mappings/${m.id}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
  const datasets = Promise.all(index.map((m) => fetch(m.file).then((r) => r.json())));
  const [mapNS, mapGulf] = await Promise.all([makeMap("north_sea", CONFIG.regions.north_sea), makeMap("gulf", CONFIG.regions.gulf)]);
  const data = await datasets;

  index.forEach((meta, i) => {
    state.layers.push({
      meta,
      data: data[i],
      region: meta.region,
      map: meta.region === "north_sea" ? mapNS : mapGulf,
      geometry: geomOf(meta.geometryType),
      mapping: saved[i]?.mapping || null,
      saved: saved[i] ? { model: saved[i].model, created: saved[i].created } : null,
    });
  });
  // Bottom layers first.
  const ordered = [...state.layers].sort((a, b) => THEME_ORDER.indexOf(a.meta.theme) - THEME_ORDER.indexOf(b.meta.theme));
  for (const l of ordered) await addLayer(l);
  if (!state.layers.some((l) => l.mapping)) {
    state.mode = "native";
    syncButtons();
    applyMode();
  }
  renderMappings();
  setStatus();
  wire();
  window.__legend = state;
  if (location.search.includes("export")) {
    // Maintenance mode: run Claude on every built-in layer, one after another, and show the
    // results as JSON for saving into mappings/. Used to produce the saved runs.
    const b = document.createElement("button");
    b.id = "run-all";
    b.textContent = "Run Claude on all built-in layers";
    b.onclick = async () => {
      b.disabled = true;
      for (const l of state.layers.filter((x) => x.region !== "custom")) {
        b.textContent = `Running ${l.meta.id}…`;
        await remap(l.meta.id);
      }
      b.textContent = "Done";
    };
    $("#mappings-card").prepend(b);
  }
  document.body.classList.add("ready");
}

function syncButtons() {
  for (const b of document.querySelectorAll("[data-mode]")) {
    const on = b.dataset.mode === state.mode;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", on);
  }
  for (const b of document.querySelectorAll("[data-conv]")) {
    const on = b.dataset.conv === state.conv;
    b.classList.toggle("on", on);
    b.setAttribute("aria-checked", on);
  }
}

function wire() {
  for (const b of document.querySelectorAll("[data-mode]")) {
    b.onclick = () => {
      state.mode = b.dataset.mode;
      syncButtons();
      applyMode();
    };
  }
  for (const b of document.querySelectorAll("[data-conv]")) {
    b.onclick = async () => {
      if (state.conv === b.dataset.conv) return;
      state.conv = b.dataset.conv;
      syncButtons();
      state.cat = await loadCatalogue(state.conv);
      for (const l of state.layers) await drawSSL(l);
      applyMode();
      renderMappings();
    };
  }
  let syncing = false;
  const regions = () => Object.values(state.maps).filter(Boolean);
  for (const m of regions()) {
    m.on("zoomend", () => {
      if (!$("#sync").checked || syncing) return;
      syncing = true;
      for (const o of regions()) if (o !== m) o.setZoom(m.getZoom());
      syncing = false;
    });
  }
  $("#try-examples").innerHTML = CONFIG.tryExamples.map((e, i) => `<button type="button" class="chip" data-i="${i}">${esc(e.label)}</button>`).join("");
  for (const c of document.querySelectorAll("#try-examples .chip")) {
    c.onclick = () => {
      $("#try-url").value = CONFIG.tryExamples[+c.dataset.i].url;
      tryService($("#try-url").value);
    };
  }
  $("#try").onsubmit = (e) => {
    e.preventDefault();
    tryService($("#try-url").value);
  };
  if (liveMode() === "offline") $("#try-log").innerHTML = `<span class="muted">Live mapping needs Claude: add your own API key with ⚙.</span>`;
  $("#gear").onclick = () => {
    $("#key").value = getUserKey();
    $("#settings").showModal();
  };
  $("#settings").addEventListener("close", () => {
    const v = $("#settings").returnValue;
    if (v === "save") setUserKey($("#key").value.trim());
    if (v === "clear") setUserKey("");
    setStatus();
    renderMappings();
  });
  addEventListener("resize", () => regions().forEach((m) => m.resize()));
}

main().catch((e) => {
  console.error(e);
  $("#status").textContent = "Something went wrong";
  $("#status").title = e.message;
});

