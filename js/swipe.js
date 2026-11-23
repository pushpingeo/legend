// Swipe view: a second map stacked on top of each panel, drawn "as published" and clipped
// to the left of a draggable divider. The map underneath shows the SSL. The two cameras
// stay locked together, so dragging the divider reveals one styling over the other.

import { nativeLayers } from "./native.js";

const overlays = {}; // region -> { map, box, handle, x, ready }

function clip(o) {
  const w = o.box.clientWidth;
  const x = Math.max(0, Math.min(w, o.x * w));
  // Everything right of the divider is cut away, including for clicks and drags.
  o.top.style.clipPath = `inset(0 ${w - x}px 0 0)`;
  o.handle.style.left = `${x}px`;
}

function lockCameras(a, b) {
  let busy = false;
  const follow = (from, to) => () => {
    if (busy) return;
    busy = true;
    to.jumpTo({ center: from.getCenter(), zoom: from.getZoom(), bearing: from.getBearing(), pitch: from.getPitch() });
    busy = false;
  };
  a.on("move", follow(a, b));
  b.on("move", follow(b, a));
}

function dragHandle(o) {
  const move = (ev) => {
    const r = o.box.getBoundingClientRect();
    o.x = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    clip(o);
  };
  o.handle.addEventListener("pointerdown", (ev) => {
    ev.preventDefault();
    o.handle.setPointerCapture(ev.pointerId);
    o.handle.addEventListener("pointermove", move);
  });
  const stop = (ev) => {
    o.handle.removeEventListener("pointermove", move);
    if (o.handle.hasPointerCapture?.(ev.pointerId)) o.handle.releasePointerCapture(ev.pointerId);
  };
  o.handle.addEventListener("pointerup", stop);
  o.handle.addEventListener("pointercancel", stop);
  // Keyboard: arrow keys nudge the divider.
  o.handle.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowLeft" || ev.key === "ArrowRight") {
      o.x = Math.max(0, Math.min(1, o.x + (ev.key === "ArrowLeft" ? -0.05 : 0.05)));
      clip(o);
      ev.preventDefault();
    }
  });
}

// Create (once) the swipe overlay for a region and make sure it holds every layer.
export async function ensureSwipe(region, base, layers, { style, onClick }) {
  if (!base) return null;
  let o = overlays[region];
  if (!o) {
    const container = base.getContainer();
    const box = document.createElement("div");
    box.className = "swipe-box";
    container.parentNode.insertBefore(box, container);
    box.append(container);
    const top = document.createElement("div");
    top.className = "swipe-top map";
    const handle = document.createElement("div");
    handle.className = "swipe-handle";
    handle.tabIndex = 0;
    handle.setAttribute("role", "slider");
    handle.setAttribute("aria-label", "Drag to compare the published styling with the SSL");
    handle.innerHTML = `<span class="grip">⟷</span>`;
    const tagL = document.createElement("span");
    tagL.className = "swipe-tag l";
    tagL.textContent = "As published";
    const tagR = document.createElement("span");
    tagR.className = "swipe-tag r";
    tagR.textContent = "SSL";
    box.append(top, handle, tagL, tagR);
    const map = new maplibregl.Map({
      container: top,
      style,
      center: base.getCenter(),
      zoom: base.getZoom(),
      attributionControl: false,
      cooperativeGestures: matchMedia("(pointer: coarse)").matches,
    });
    o = overlays[region] = { map, box, top, handle, x: 0.5, srcs: new Set() };
    await new Promise((res) => {
      if (map.loaded()) res();
      else map.once("load", res);
      map.once("error", () => setTimeout(res, 1500));
    });
    lockCameras(base, map);
    map.on("click", (e) => onClick(map, e));
    dragHandle(o);
    new ResizeObserver(() => {
      map.resize();
      clip(o);
    }).observe(box);
    clip(o);
  }
  // Add any layer this overlay doesn't have yet (polygons first, points last).
  for (const l of layers) {
    if (o.srcs.has(l.srcId)) continue;
    o.srcs.add(l.srcId);
    o.map.addSource(l.srcId, { type: "geojson", data: l.data });
    const nat = await nativeLayers(o.map, l.srcId, l.geometry, l.meta.renderer);
    for (const ly of nat.layers) o.map.addLayer(ly);
    l.swipeIds = nat.layers.map((x) => x.id);
  }
  return o;
}

export function showSwipe(on) {
  for (const o of Object.values(overlays)) {
    o.box.classList.toggle("swiping", on);
    if (on) {
      o.map.resize();
      clip(o);
    }
  }
}

export function swipeMapOf(region) {
  return overlays[region]?.map || null;
}
