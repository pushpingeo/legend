# One legend

**Live: https://pushpingeo.github.io/legend/**

The UK and US regulators publish their offshore wells, pipelines and platforms as open ArcGIS services. Each draws them its own way: NSTA colours wells by mechanical status, BOEM draws every well as the same red ball. This page puts the two side by side and lets Claude apply the **Shell Standard Legend** (SSL) to both. Flip the toggle and two very different maps become one map language, or choose **Swipe** and drag the divider to compare each publisher's own styling with the SSL on the same view.

The point: a symbol standard used to need a drawing office to apply it. Once data arrived faster than anyone could code it, the SSL mostly stopped being used. If an AI does the coding step, from whatever fields a service happens to have, the standard becomes usable again, on data nobody prepared for it.

## How it works

1. **The SSL as data.** `scripts/build_ssl.py` reads the SSL2012 Esri style that Shell released through IOGP (an ArcGIS Pro `.stylx`, which is a SQLite file of CIM symbol JSON, plus 22 TrueType fonts) and writes `ssl/<green|red>/catalogue.json` and an SVG per symbol, drawn from the font glyphs. About 1,100 symbols in each edition.
2. **Layer profile.** For each layer the page builds a profile: field names and aliases, and for each text field its distinct values with counts. No features are sent.
3. **Claude writes a mapping.** Claude (Haiku 5.5) gets the profile and the relevant part of the catalogue (fields, pipelines, offshore structures, licences and wells: about 250 codes, roughly 2,500 tokens) and calls one tool, `apply_ssl`, with ordered rules ("FLUID = OIL and STATUS = NOT IN USE → 322021") and, for wells, a composite that follows the SSL's own grammar: `W{oil}{gas}0{status}`. Every decision has a confidence and, where it isn't obvious, a short reason.
4. **The page checks it.** Every code is checked against the catalogue and the layer's geometry. If anything is wrong, the errors go back to Claude as a `tool_result` with `is_error` and it gets one more try.
5. **The map draws from the mapping.** Each feature gets its SSL code; MapLibre draws the SVG symbols, line styles and fill patterns. "As published" translates each service's own ArcGIS renderer instead.

The saved runs in `mappings/` are Claude's real output from the live page, kept so the page works without an API call. "Ask Claude again" on any layer, or "Apply it to another service", runs it live.

## Things the build turned up

- **The colour convention is baked into the codes.** The GREEN edition (oil green, gas red) adds `001` or `1` to codes whose colour depends on the convention (`2402001` oil field vs `2402` in RED). The catalogue gives every symbol a convention-neutral `base` code, so one mapping works with either edition.
- **The 2012 Esri style doesn't follow its own convention for pipelines.** Oil pipelines are red in both editions. The 2016 PDF fixed this (and renumbered the pipelines chapter), so the 2016 pipeline symbols are added by hand from the PDF.
- **The 2012 style has no suspended-well series.** The 2016 PDF does (W010X…W330X). Because the well symbols are a grammar, the build makes them: producing symbol plus a diagonal stroke.
- **A standard shows what the data doesn't hold.** BOEM's well layer has status but no test results, so its wells come out as plain circles while NSTA's show oil and gas. That's correct, not a failure.

## Run it locally

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

Live mapping goes through the same Cloudflare Worker as [north-sea-geo-demo](https://github.com/pushpingeo/north-sea-geo-demo), which only accepts requests from pushpingeo.github.io. Locally, add your own API key with ⚙.

## Refresh or rebuild

```bash
python3 scripts/fetch_data.py                       # NSTA + BOEM layers into data/
pip install fonttools
python3 scripts/build_ssl.py SSL2012_GreenOil SSL2012_RedOil   # unzipped Esri style folders
```

To refresh the saved mappings, open the page with `?export`, press "Run Claude on all built-in layers" and save the JSON per layer into `mappings/<layer id>.json`.

## Files

```
index.html, css/, js/
  js/ssl.js        load the catalogue, draw SSL symbols in MapLibre, describe the SSL to Claude
  js/native.js     ArcGIS renderer -> MapLibre, for the "as published" view
  js/mapping.js    layer profile, the apply_ssl tool and prompt, validation, applying a mapping
  js/swipe.js      swipe view: a second, camera-locked map drawn as published, clipped at a draggable divider
  js/app.js        maps, legend, mapping cards, "apply it to another service"
ssl/green, ssl/red catalogue.json + svg/ (generated)
data/              GeoJSON + layers.json with each service's own renderer (generated)
mappings/          Claude's saved mapping per layer
scripts/           build_ssl.py, fetch_data.py
```

## Sources and caveats

- Symbols: Shell Standard Legend, SSL2012 Esri style (green-oil and red-oil) and the 2016 Discipline Quality Standard PDFs (SR.12.12047, SR.12.12048), released by Shell to industry and academia via [IOGP](https://www.iogp.org/blog/geomatics/shell-releases-its-standard-legend-to-industry-and-academia/). The published documents note that IOGP and its members give no warranty and accept no liability. This repo is an independent demo, not a Shell product.
- Data: [NSTA open data](https://opendata-nstauthority.hub.arcgis.com/) and BOEM (its own ArcGIS Online services, and its platform and pipeline data as published by Esri US Federal Data). BOEM sidetracks are left out because they share their parent's surface location.
- Styles are simplified for the web: markers along lines aren't drawn, curved vector-marker segments are straightened, and hatches are tiled patterns.
