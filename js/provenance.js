// "Earned polish": AI-classified layers render as a draft until a person approves the rules.

import { CONFIG } from "./config.js";
import { loadCatalogue, ensureImages, sslLayers, swatch } from "./ssl.js";
import { applyMapping } from "./mapping.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const LOW = 0.6; // decisions below this need a reviewer's eye
const DRAFT = "#e8590c";
const ORDER = ["fields", "pipelines", "platforms", "wells"];
const REGION = {
  north_sea: { title: "UK North Sea", pub: "North Sea Transition Authority", data: "NSTA open data" },
  gulf: { title: "US Gulf", pub: "Bureau of Ocean Energy Management", data: "BOEM open data" },
};

const state = { mode: "earned", region: "north_sea", cat: null, map: null, layers: [], approvals: {} };

// ---------- approvals (per viewer, in this browser) ----------

const STORE = "legend.approvals";
function loadApprovals() {
  try {
    return JSON.parse(localStorage.getItem(STORE) || "{}");
  } catch {
    return {};
  }
}
function saveApprovals() {
  try {
    localStorage.setItem(STORE, JSON.stringify(state.approvals));
  } catch {
    /* storage blocked: approvals last until the page reloads */
  }
}

// ---------- low-confidence decisions: what a reviewer should look at ----------

function lowDecisions(l) {
  const m = l.mapping;
  const out = [];
  (m.rules || []).forEach((r) => {
    if (r.confidence < LOW) out.push({ what: r.when.map((c) => `${c.field} = ${c.in.join(" / ") || "(empty)"}`).join(" and "), code: r.code, conf: r.confidence, note: r.note });
  });
  for (const p of m.composite?.parts || []) {
    for (const v of p.values) if (v.confidence < LOW) out.push({ what: `${p.field} = ${v.value}`, code: `{${p.name}} → ${v.token}`, conf: v.confidence, note: v.note });
  }
  if ((m.default_confidence ?? 1) < LOW && l.tally.some((t) => t.via.includes("default"))) {
    out.push({ what: "anything no rule covers", code: m.default_code, conf: m.default_confidence, note: "default" });
  }
  return out.sort((a, b) => a.conf - b.conf);
}

// ---------- drawing ----------

const approved = (l) => state.mode === "polish" || !!state.approvals[l.meta.id];

// Turn the full SSL layers into their draft look. Same symbols, same colours, so a reviewer
// is judging the real thing, just visibly unfinished.
function draftify(layers, geometry, srcId) {
  const conf = ["coalesce", ["to-number", ["get", "_conf"]], 0.5];
  const out = [];
  for (const l of layers) {
    const d = structuredClone(l);
    d.id = l.id + "-draft";
    d.paint = d.paint || {};
    if (geometry === "point") {
      d.paint["icon-opacity"] = ["interpolate", ["linear"], conf, 0, 0.2, 1, 0.6];
    } else if (d.type === "line") {
      d.paint["line-opacity"] = 0.55;
      d.paint["line-dasharray"] = [1.5, 1.5];
      d.layout = { ...(d.layout || {}), "line-cap": "butt" };
    } else if (d.type === "fill") {
      d.paint["fill-opacity"] = 0.22;
    }
    out.push(d);
  }
  if (geometry === "point") {
    out.unshift({
      id: `${srcId}-draft-ring`,
      type: "circle",
      source: srcId,
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 2.5, 9, 7, 12, 11],
        "circle-color": "rgba(0,0,0,0)",
        "circle-stroke-color": DRAFT,
        "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 5, 0.6, 10, 1.4],
        "circle-stroke-opacity": 0.8,
      },
    });
  } else if (geometry === "polygon") {
    out.push({ id: `${srcId}-draft-edge`, type: "line", source: srcId, paint: { "line-color": DRAFT, "line-width": 1.2, "line-dasharray": [3, 2] } });
  }
  return out;
}

async function drawLayer(l) {
  const map = state.map;
  for (const id of l.ids || []) if (map.getLayer(id)) map.removeLayer(id);
  const codes = l.tally.map((t) => t.code);
  await ensureImages(map, state.cat, codes);
  const full = sslLayers(state.cat, l.srcId, l.geometry, codes);
  const layers = approved(l) ? full : draftify(full, l.geometry, l.srcId);
  for (const ly of layers) map.addLayer(ly);
  l.ids = layers.map((x) => x.id);
}

async function redraw() {
  for (const l of [...state.layers].sort((a, b) => ORDER.indexOf(a.meta.theme) - ORDER.indexOf(b.meta.theme))) await drawLayer(l);
  renderChrome();
}

// ---------- page furniture ----------

function regionLayers() {
  return state.layers.filter((l) => l.meta.region === state.region);
}

function renderChrome() {
  const ls = regionLayers();
  const allOk = ls.every(approved);
  $("#stamp").classList.toggle("hidden", state.mode === "polish" || allOk);
  $("#titleblock").classList.toggle("hidden", state.mode === "polish");
  $("#map-title").textContent = REGION[state.region].title;
  $("#map-pub").textContent = REGION[state.region].pub;

  const r = REGION[state.region];
  const run = ls.find((l) => l.saved)?.saved;
  const reviewed = ls.filter((l) => state.approvals[l.meta.id]);
  const who = [...new Set(reviewed.map((l) => state.approvals[l.meta.id].by))].join(", ");
  const when = reviewed.map((l) => state.approvals[l.meta.id].on).sort().pop();
  const fetched = ls[0]?.meta.fetched || "";
  $("#titleblock").innerHTML = `
    <tr><th>Data</th><td>${esc(r.data)}, fetched ${esc(fetched)}</td><td class="by person">source</td></tr>
    <tr><th>Classified</th><td>${esc(run ? run.model : "")}${run ? ", " + esc(run.created) : ""}</td><td class="by ai">AI</td></tr>
    <tr><th>Reviewed</th><td>${reviewed.length ? `${esc(who)}, ${esc(when)} (${reviewed.length} of ${ls.length} layers)` : "Not reviewed"}</td><td class="by ${reviewed.length === ls.length ? "person" : "none"}">${reviewed.length === ls.length ? "person" : reviewed.length ? "partial" : "none"}</td></tr>
    <tr><th>Symbology</th><td>Shell Standard Legend (oil = green)</td><td class="by person">standard</td></tr>`;

  if (state.mode === "polish") {
    $("#mode-title").textContent = "Polish without provenance";
    $("#mode-text").innerHTML = `<p>This is what AI makes cheap: every layer in full Shell Standard Legend, as finished as a drawing-office map. Nothing on it says that the classification behind the symbols was done by a model in seconds and that no one has checked it.</p><p>A map reader used to take this level of finish as a sign of care. Here it isn't one.</p>`;
  } else {
    const pending = ls.filter((l) => !approved(l)).length;
    $("#mode-title").textContent = "Earned polish";
    $("#mode-text").innerHTML = `<p>Same data, same symbols, same AI classification. The difference is that a layer only gets its full rendering once a person has reviewed and approved the rules behind it. Until then it draws as a draft.</p><p class="${pending ? "warnline" : "okline"}">${pending ? `${pending} of ${ls.length} layers in this map are still drafts.` : "Every layer in this map has been reviewed."}</p>`;
  }
  renderReviews();
}

function renderReviews() {
  const box = $("#reviews");
  box.innerHTML = regionLayers()
    .sort((a, b) => ORDER.indexOf(b.meta.theme) - ORDER.indexOf(a.meta.theme))
    .map((l) => {
      const ok = state.approvals[l.meta.id];
      const low = lowDecisions(l);
      const lowFeatures = l.data.features.filter((f) => (f.properties._conf ?? 1) < LOW).length;
      const lows = low
        .slice(0, 8)
        .map((d) => `<li><span class="cond">${esc(d.what)}</span> → <span class="code">${esc(d.code)}</span> <span class="conf lo">${Math.round(d.conf * 100)}%</span>${d.note && d.note !== "default" ? `<div class="note">${esc(d.note)}</div>` : ""}</li>`)
        .join("");
      return `<div class="rv ${ok ? "ok" : ""}">
        <div class="rv-h"><b>${esc(l.meta.title)}</b><span class="badge ${ok ? "ok" : "draft"}">${ok ? "Approved" : "Draft"}</span></div>
        <p class="small">${esc(l.mapping.summary)}</p>
        <p class="small"><b>${lowFeatures.toLocaleString()}</b> of ${l.data.features.length.toLocaleString()} features rest on decisions under ${LOW * 100}% confidence.${low.length ? " Check these first:" : ""}</p>
        ${lows ? `<ul class="lows">${lows}</ul>` : ""}
        ${(l.mapping.caveats || []).length ? `<details class="small"><summary>Claude's caveats (${l.mapping.caveats.length})</summary><ul>${l.mapping.caveats.map((c) => `<li>${esc(c)}</li>`).join("")}</ul></details>` : ""}
        ${ok ? `<p class="small muted">Approved by ${esc(ok.by)} on ${esc(ok.on)}.</p><button class="ghost small" data-revoke="${l.meta.id}">Withdraw approval</button>` : `<button class="small" data-approve="${l.meta.id}">Approve rules</button>`}
      </div>`;
    })
    .join("");
  for (const b of box.querySelectorAll("[data-approve]")) b.onclick = () => approve(b.dataset.approve);
  for (const b of box.querySelectorAll("[data-revoke]")) b.onclick = () => revoke(b.dataset.revoke);
}

async function approve(id) {
  const by = $("#reviewer").value.trim();
  if (!by) {
    $("#reviewer").focus();
    $("#reviewer").classList.add("need");
    return;
  }
  try {
    localStorage.setItem("legend.reviewer", by);
  } catch {}
  state.approvals[id] = { by, on: new Date().toISOString().slice(0, 10) };
  saveApprovals();
  await drawLayer(state.layers.find((l) => l.meta.id === id));
  renderChrome();
}

async function revoke(id) {
  delete state.approvals[id];
  saveApprovals();
  await drawLayer(state.layers.find((l) => l.meta.id === id));
  renderChrome();
}

// ---------- why this symbol ----------

function popup(e) {
  const ids = state.layers.flatMap((l) => l.ids || []).filter((id) => state.map.getLayer(id));
  const hits = state.map.queryRenderedFeatures([[e.point.x - 6, e.point.y - 6], [e.point.x + 6, e.point.y + 6]], { layers: ids });
  const f = hits.find((h) => h.properties._ssl);
  if (!f) return;
  const l = state.layers.find((x) => x.srcId === f.source);
  const p = f.properties;
  const s = state.cat.byBase.get(p._ssl);
  const ok = approved(l);
  const rows = l.meta.fields
    .filter((k) => p[k] !== undefined && p[k] !== null && p[k] !== "")
    .map((k) => `<tr><th>${esc(l.meta.aliases?.[k] || k)}</th><td>${esc(p[k])}</td></tr>`)
    .join("");
  const conf = +p._conf;
  new maplibregl.Popup({ maxWidth: "320px" })
    .setLngLat(e.lngLat)
    .setHTML(
      `<div class="pop"><div class="pop-title">${esc(l.meta.title)}</div>
      <div class="pop-ssl">${swatch(state.cat, p._ssl, 26)}<div><b>${esc(s?.name)}</b><br><span class="code">SSL ${esc(p._ssl)}</span> · <span class="conf ${conf >= 0.85 ? "hi" : conf >= LOW ? "mid" : "lo"}">${Math.round(conf * 100)}%</span></div></div>
      <div class="pop-prov ${ok ? "ok" : "draft"}">${state.mode === "polish" ? "Classified by AI. No review recorded, and nothing on the map says so." : ok ? `Classified by AI · rules approved by ${esc(state.approvals[l.meta.id]?.by)}` : "Classified by AI · not reviewed"}</div>
      <table>${rows}</table></div>`,
    )
    .addTo(state.map);
}

// ---------- start ----------

async function main() {
  state.approvals = loadApprovals();
  try {
    $("#reviewer").value = localStorage.getItem("legend.reviewer") || "";
  } catch {}
  const [index, cat] = await Promise.all([fetch("data/layers.json").then((r) => r.json()), loadCatalogue("green")]);
  state.cat = cat;
  const metas = index.filter((m) => ["north_sea", "gulf"].includes(m.region));
  const [data, saved] = await Promise.all([
    Promise.all(metas.map((m) => fetch(m.file).then((r) => r.json()))),
    Promise.all(metas.map((m) => fetch(`mappings/${m.id}.json`).then((r) => (r.ok ? r.json() : null)))),
  ]);
  metas.forEach((meta, i) => {
    if (!saved[i]) return;
    const l = { meta, data: data[i], mapping: saved[i].mapping, saved: { model: saved[i].model, created: saved[i].created }, srcId: `src-${meta.id}` };
    l.geometry = { esriGeometryPoint: "point", esriGeometryPolyline: "line", esriGeometryPolygon: "polygon" }[meta.geometryType] || "point";
    l.tally = applyMapping(cat, l.mapping, l.data.features);
    state.layers.push(l);
  });

  try {
    state.map = new maplibregl.Map({ container: "map", style: CONFIG.basemapStyle, ...CONFIG.regions.north_sea, attributionControl: { compact: true }, cooperativeGestures: matchMedia("(pointer: coarse)").matches });
  } catch (e) {
    $("#map").innerHTML = `<p class="nomap">This browser can't draw the map (WebGL is off or unavailable). The review panel still works.</p>`;
    wire();
    renderChrome();
    document.body.classList.add("ready");
    return;
  }
  state.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  await new Promise((res) => {
    state.map.once("load", res);
    state.map.once("error", () => setTimeout(res, 1500));
  });
  for (const l of state.layers) state.map.addSource(l.srcId, { type: "geojson", data: l.data });
  state.map.on("click", popup);
  wire();
  await redraw();
  window.__prov = state;
  document.body.classList.add("ready");
}

function wire() {
  for (const b of document.querySelectorAll("[data-mode]")) {
    b.onclick = async () => {
      state.mode = b.dataset.mode;
      for (const x of document.querySelectorAll("[data-mode]")) {
        x.classList.toggle("on", x === b);
        x.setAttribute("aria-checked", x === b);
      }
      if (state.map) await redraw();
      else renderChrome();
    };
  }
  for (const b of document.querySelectorAll("[data-region]")) {
    b.onclick = () => {
      state.region = b.dataset.region;
      for (const x of document.querySelectorAll("[data-region]")) x.classList.toggle("on", x === b);
      state.map?.jumpTo(CONFIG.regions[state.region]);
      renderChrome();
    };
  }
  $("#reviewer").oninput = () => $("#reviewer").classList.remove("need");
}

main().catch((e) => console.error(e));
