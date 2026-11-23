"""Download the built-in layers from the NSTA (UK North Sea) and BOEM (US Gulf)
open-data services and save them as small GeoJSON files, together with each
service's own drawing rules, so the page can show them exactly as published.

    python scripts/fetch_data.py

Writes data/<layer>.geojson and data/layers.json. Standard library only.
Re-run it to refresh the data.
"""

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data"

NSTA = "https://services-eu1.arcgis.com/OZMfUznmLTnWccBc/ArcGIS/rest/services"
BOEM = "https://services7.arcgis.com/G5Ma95RzqJRPKsWL/ArcGIS/rest/services"  # BOEM's own ArcGIS Online
FED = "https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services"  # Esri US Federal Data (BOEM data)

LAYERS = [
    {
        "id": "nsta_wells", "region": "north_sea", "theme": "wells", "title": "Wellbores",
        "publisher": "North Sea Transition Authority",
        "url": f"{NSTA}/UKCS_offshore_wellbore_top_holes_(WGS84)/FeatureServer/0",
        "fields": ["WELLREGNO", "COMPLESTAT", "WELLOPSTAT", "FLOWCLASS", "OTHERCLASS", "ORIGINTENT", "DEVTYPE", "FLUIDTYPES"],
    },
    {
        "id": "nsta_fields", "region": "north_sea", "theme": "fields", "title": "Hydrocarbon fields",
        "publisher": "North Sea Transition Authority",
        "url": f"{NSTA}/Offshore_hydrocarbon_fields_(WGS84)/FeatureServer/0",
        "fields": ["FIELDNAME", "FIELDTYPE", "STATUS", "CURR_OPER"], "offset": 0.0005,
    },
    {
        "id": "nsta_pipelines", "region": "north_sea", "theme": "pipelines", "title": "Pipelines and umbilicals",
        "publisher": "North Sea Transition Authority",
        "url": f"{NSTA}/UKCS_offshore_infrastructure_pipeline_linear_(WGS84)/FeatureServer/1",
        "fields": ["PIPE_NAME", "INF_TYPE", "FLUID", "STATUS", "EXPOSED", "UNTRENCHED"],
        "where": "INF_TYPE IN ('PIPELINE','UMBILICAL','RISER')", "offset": 0.0005,
    },
    {
        "id": "nsta_platforms", "region": "north_sea", "theme": "platforms", "title": "Surface installations",
        "publisher": "North Sea Transition Authority",
        "url": f"{NSTA}/UKCS offshore infrastructure surface points WGS84/FeatureServer/1",
        "fields": ["NAME", "INF_TYPE", "STATUS", "REP_GROUP"],
    },
    {
        "id": "boem_wells", "region": "gulf", "theme": "wells", "title": "OCS wells",
        "publisher": "Bureau of Ocean Energy Management",
        "url": f"{BOEM}/Outer_Continental_Shelf_Oil_and_Natural_Gas_Wells_Gulf_of_Mexico_Region_NAD_27/FeatureServer/0",
        "fields": ["WELL_NAME", "STATUS", "STATUS_DES", "TYPE_CODE_"],
        # Sidetracks share their parent's surface location, so leave them out (about 17,000 points).
        "where": "STATUS <> 'ST'", "precision": 4,
    },
    {
        "id": "boem_pipelines", "region": "gulf", "theme": "pipelines", "title": "OCS pipelines",
        "publisher": "Bureau of Ocean Energy Management (via Esri US Federal Data)",
        "url": f"{FED}/Oil_And_Natural_Gas_Pipelines_Gulf_2024Q4/FeatureServer/0",
        "fields": ["SEGMENT_NUM", "STATUS_CODE", "PROD_CODE", "PPL_SIZE_CODE", "SDE_COMPANY_DESG"],
        "where": "STATUS_CODE NOT IN ('REM','CNCL')", "offset": 0.0008,
    },
    {
        "id": "boem_platforms", "region": "gulf", "theme": "platforms", "title": "OCS platforms",
        "publisher": "Bureau of Ocean Energy Management (via Esri US Federal Data)",
        "url": f"{FED}/OCS_Oil_And_Natural_Gas_Platforms_Gulf_2024Q4/FeatureServer/0",
        "fields": ["COMPLEX_ID_NUM", "INSTALL_DATE", "REMOVAL_DATE"],
    },
]


def get(url, params=None):
    u = urllib.parse.quote(url, safe=":/()") + ("?" + urllib.parse.urlencode(params) if params else "")
    for attempt in range(4):
        try:
            with urllib.request.urlopen(u, timeout=180) as r:
                return json.load(r)
        except Exception as e:  # services are flaky now and then
            if attempt == 3:
                raise
            print("   retry:", e)
            time.sleep(3)


def fetch(layer, page=2000):
    feats, start = [], 0
    while True:
        q = {
            "where": layer.get("where", "1=1"),
            "outFields": ",".join(layer["fields"]),
            "outSR": 4326, "geometryPrecision": layer.get("precision", 5),
            "resultOffset": start, "resultRecordCount": page, "f": "geojson",
        }
        if layer.get("offset"):
            q["maxAllowableOffset"] = layer["offset"]
        got = get(layer["url"] + "/query", q).get("features", [])
        feats += [f for f in got if f.get("geometry")]
        print(f"  {layer['id']}: {len(feats)}")
        if len(got) < page:
            return feats
        start += len(got)
        time.sleep(0.2)


def tidy(v):
    if isinstance(v, str):
        v = " ".join(v.split())
        return v or None
    return v


def main():
    OUT.mkdir(exist_ok=True)
    index = []
    for layer in LAYERS:
        meta = get(layer["url"], {"f": "json"})
        feats = fetch(layer)
        for f in feats:
            p = f.get("properties") or {}
            f["properties"] = {k: tidy(p.get(k)) for k in layer["fields"]}
            f.pop("id", None)
        path = OUT / f"{layer['id']}.geojson"
        path.write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")))
        index.append({
            **{k: v for k, v in layer.items() if k not in ("offset", "precision")},
            "file": f"data/{path.name}",
            "count": len(feats),
            "geometryType": meta.get("geometryType"),
            "aliases": {f["name"]: f.get("alias") for f in meta["fields"] if f["name"] in layer["fields"]},
            "fieldTypes": {f["name"]: f["type"] for f in meta["fields"] if f["name"] in layer["fields"]},
            "renderer": meta.get("drawingInfo", {}).get("renderer"),
            "fetched": time.strftime("%Y-%m-%d"),
        })
        print(f"wrote {path.name}: {len(feats)} features, {path.stat().st_size / 1e6:.1f} MB")
    (OUT / "layers.json").write_text(json.dumps(index, indent=1))


if __name__ == "__main__":
    main()
