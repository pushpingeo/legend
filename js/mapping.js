// Claude's job: read a layer's fields and values and write a mapping to SSL codes.
// The page's job: check that mapping against the catalogue and apply it to every feature.

import { callClaude } from "./claude.js";
import { catalogueForClaude, isCode } from "./ssl.js";

// ---------- 1. Describe a layer ----------

const MAX_VALUES = 60;

// A compact profile: what Claude needs to choose symbols, without sending the features.
// For a GIS person: this is the "describe layer" plus a frequency table per attribute.
export function profileLayer(meta, features) {
  const geomCounts = {};
  for (const f of features) {
    const t = f.geometry?.type || "none";
    geomCounts[t] = (geomCounts[t] || 0) + 1;
  }
  const fields = [];
  for (const name of meta.fields) {
    const type = (meta.fieldTypes?.[name] || "").replace("esriFieldType", "");
    const counts = new Map();
    let empty = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const f of features) {
      const v = f.properties?.[name];
      if (v === null || v === undefined || v === "") {
        empty++;
        continue;
      }
      if (typeof v === "number") {
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
      const k = String(v).trim();
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const entry = { field: name, alias: meta.aliases?.[name] || name, type, empty };
    if (type === "Date" && isFinite(min)) {
      entry.range = [new Date(min).toISOString().slice(0, 10), new Date(max).toISOString().slice(0, 10)];
      entry.filled = features.length - empty;
    } else if (counts.size > MAX_VALUES) {
      entry.distinct = counts.size;
      entry.examples = [...counts.keys()].slice(0, 5);
      entry.note = "too many distinct values to map on";
    } else {
      entry.values = Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]));
    }
    fields.push(entry);
  }
  return {
    name: meta.title,
    publisher: meta.publisher,
    service: meta.url,
    geometry: Object.entries(geomCounts).map(([t, n]) => `${n} ${t}`).join(" + "),
    features: features.length,
    fields,
  };
}

// ---------- 2. Ask Claude ----------

const TOOL = {
  name: "apply_ssl",
  description:
    "Record how this layer's features map to Shell Standard Legend codes. Called once per layer. The page applies it to every feature and draws the map from it.",
  input_schema: {
    type: "object",
    properties: {
      theme: { type: "string", enum: ["wells", "pipelines", "platforms", "fields", "licences", "other"] },
      summary: { type: "string", description: "One or two plain sentences: what the layer holds and how you mapped it." },
      rules: {
        type: "array",
        description: "Checked in order; the first rule whose conditions all match gives the code.",
        items: {
          type: "object",
          properties: {
            when: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  field: { type: "string" },
                  in: { type: "array", items: { type: "string" }, description: 'Exact values from the profile. "" matches empty, "*" matches any non-empty value.' },
                },
                required: ["field", "in"],
              },
            },
            code: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            note: { type: "string" },
          },
          required: ["when", "code", "confidence"],
        },
      },
      composite: {
        type: "object",
        description: "Used when no rule matches. Builds a code from a template such as W{oil}{gas}0{status}.",
        properties: {
          template: { type: "string" },
          parts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Placeholder name used in the template." },
                field: { type: "string" },
                values: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      value: { type: "string" },
                      token: { type: "string" },
                      confidence: { type: "number", minimum: 0, maximum: 1 },
                      note: { type: "string" },
                    },
                    required: ["value", "token", "confidence"],
                  },
                },
                default_token: { type: "string" },
                default_confidence: { type: "number", minimum: 0, maximum: 1 },
              },
              required: ["name", "field", "values", "default_token"],
            },
          },
        },
        required: ["template", "parts"],
      },
      default_code: { type: "string", description: "Code for anything no rule or composite covers." },
      default_confidence: { type: "number", minimum: 0, maximum: 1 },
      caveats: { type: "array", items: { type: "string" }, description: "Anything a map reader should know, e.g. information the layer doesn't hold." },
    },
    required: ["theme", "summary", "default_code", "default_confidence"],
  },
};

const INSTRUCTIONS = `You apply the Shell Standard Legend (SSL) to GIS layers. You get a profile of one layer: its name, publisher, geometry and fields, with the distinct values of each text field and how many features have each. Decide which SSL symbol each feature should get.

Answer by calling the apply_ssl tool exactly once. Don't write anything else.

How the page uses your answer, for every feature:
1. rules, in order: the first rule whose conditions all match gives the code. A condition matches when the field's value is one of the listed values, compared as exact text. "" matches an empty value and "*" matches any non-empty value.
2. if no rule matches and you gave a composite, the code is the template with each {part} replaced by that part's token for the feature's value.
3. otherwise default_code.

Use only codes from the catalogue below, and only symbols for the layer's geometry (point layers get point symbols, line layers line symbols, polygon layers polygon symbols). Use the base codes as listed: the page handles the oil=green and oil=red editions.

Well codes follow a grammar: W{oil}{gas}0{status}.
- oil and gas: "0" none, "1" shows, "2" interpreted productive, "3" proven productive (also used for producing wells)
- status: "P" producing or active, "S" closed in or shut in, "X" suspended, "A" plugged and abandoned
So W300P is a producing oil well, W030A an abandoned gas well, W000A an abandoned well with no recorded hydrocarbons. For well layers use a composite with that template and parts named oil, gas and status, plus rules for special cases that have their own symbols (wells being drilled DRILNG, planned LOCPRO, injectors W000I and its variants, status unknown STATUN). If the layer has no field recording test results or shows, give oil and gas the token "0" and say so in caveats: never invent results.

Pipelines: pick by product and status. Buried and not-in-use pipelines have their own codes. Umbilicals, control lines and cables are not pipelines: use the cable codes or pipeline other.

Confidence is 0 to 1 for each decision: about 0.9 or more when the value means exactly what the symbol shows, lower when the value is ambiguous or you had to guess what a code or abbreviation means. Add a short note (under 15 words) to any decision that isn't obvious, especially guesses at abbreviations. Map every value that covers more than a handful of features. Don't map on fields marked as having too many distinct values.

SSL catalogue (code | name):
`;

function systemPrompt(cat) {
  // The instructions and catalogue are identical for every layer, so mark them for prompt
  // caching: repeat calls reuse the processed prefix instead of paying for it again.
  return [{ type: "text", text: INSTRUCTIONS + catalogueForClaude(cat), cache_control: { type: "ephemeral" } }];
}

// Returns { mapping, check, usage, rounds }. Throws on API errors.
export async function askClaude(cat, profile, features, onStep = () => {}) {
  const system = systemPrompt(cat);
  const messages = [{ role: "user", content: "Layer profile:\n```json\n" + JSON.stringify(profile, null, 1) + "\n```" }];
  const usage = [];
  for (let round = 1; round <= 2; round++) {
    onStep(round === 1 ? "Claude is reading the layer…" : "Claude is fixing codes that aren't in the SSL…");
    const res = await callClaude({ system, messages, tools: [TOOL] });
    usage.push(res.usage);
    if (res.stop_reason === "max_tokens") throw new Error("Claude ran out of room before finishing (max_tokens). Try again.");
    const call = (res.content || []).find((b) => b.type === "tool_use" && b.name === "apply_ssl");
    if (!call) throw new Error("Claude answered without a mapping. Try again.");
    const mapping = call.input;
    const check = validate(cat, mapping, profile, features);
    if (!check.errors.length || round === 2) return { mapping, check, usage, rounds: round };
    // Tell Claude what was wrong and let it try once more. Every tool_use needs a matching
    // tool_result in the next message; is_error tells Claude its call didn't work.
    messages.push({ role: "assistant", content: res.content });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: call.id, is_error: true, content: "Not applied:\n- " + check.errors.join("\n- ") + "\nCall apply_ssl again with a corrected mapping." }],
    });
  }
}

// ---------- 3. Check and apply ----------

function str(v) {
  return v === null || v === undefined ? "" : String(v).trim();
}

function matches(cond, props) {
  const v = str(props[cond.field]);
  return cond.in.some((x) => (x === "*" ? v !== "" : str(x) === v));
}

// Work out one feature's code. Returns { code, conf, via }.
export function codeFor(mapping, props) {
  for (const [i, r] of (mapping.rules || []).entries()) {
    if (r.when.every((c) => matches(c, props))) return { code: r.code, conf: r.confidence, via: `rule:${i}` };
  }
  const comp = mapping.composite;
  if (comp?.template && comp.parts?.length) {
    let code = comp.template;
    let conf = 1;
    for (const p of comp.parts) {
      const v = str(props[p.field]);
      const hit = p.values.find((x) => str(x.value) === v);
      const token = hit ? hit.token : p.default_token;
      conf = Math.min(conf, hit ? hit.confidence : p.default_confidence ?? 0.5);
      code = code.split(`{${p.name}}`).join(token);
    }
    return { code, conf, via: "composite" };
  }
  return { code: mapping.default_code, conf: mapping.default_confidence, via: "default" };
}

const GEOM = { Point: "point", MultiPoint: "point", LineString: "line", MultiLineString: "line", Polygon: "polygon", MultiPolygon: "polygon" };

export function validate(cat, mapping, profile, features) {
  const errors = [];
  const fieldNames = new Set(profile.fields.map((f) => f.field));
  const geom = GEOM[features.find((f) => f.geometry)?.geometry?.type] || null;
  const badCode = (code, where) => {
    const s = cat.byBase.get(code);
    if (!s) errors.push(`${where}: "${code}" is not an SSL code in the catalogue.`);
    else if (geom && s.geometry !== geom) errors.push(`${where}: "${code}" is a ${s.geometry} symbol but this is a ${geom} layer.`);
  };
  (mapping.rules || []).forEach((r, i) => {
    badCode(r.code, `Rule ${i + 1}`);
    r.when.forEach((c) => fieldNames.has(c.field) || errors.push(`Rule ${i + 1}: there is no field "${c.field}".`));
  });
  (mapping.composite?.parts || []).forEach((p) => fieldNames.has(p.field) || errors.push(`Part ${p.name}: there is no field "${p.field}".`));
  badCode(mapping.default_code, "default_code");
  // Composite codes are only known once applied, so test them against the real features.
  const missing = new Map();
  for (const f of features) {
    const r = codeFor(mapping, f.properties || {});
    if (!isCode(cat, r.code)) missing.set(r.code, (missing.get(r.code) || 0) + 1);
  }
  for (const [code, n] of missing) errors.push(`The composite produces "${code}" for ${n} features, which is not in the catalogue. Add a rule for that combination or change a token.`);
  return { errors, missing: Object.fromEntries(missing) };
}

const STATUS_RANK = { P: 4, S: 3, X: 2, A: 1 };

// Write each feature's code into its properties; return a tally for the UI.
export function applyMapping(cat, mapping, features) {
  const tally = new Map();
  for (const f of features) {
    const p = f.properties || (f.properties = {});
    let { code, conf, via } = codeFor(mapping, p);
    let fell = false;
    if (!isCode(cat, code)) {
      code = mapping.default_code;
      conf = Math.min(conf, mapping.default_confidence ?? 0.3);
      fell = true;
    }
    p._ssl = code;
    p._conf = conf;
    p._rank = code.startsWith("W") ? STATUS_RANK[code.slice(-1)] || 0 : 0;
    const t = tally.get(code) || { code, n: 0, conf: 0, fell: 0, via: new Set() };
    t.n++;
    t.conf += conf;
    if (fell) t.fell++;
    t.via.add(via);
    tally.set(code, t);
  }
  return [...tally.values()].map((t) => ({ ...t, conf: t.conf / t.n, via: [...t.via] })).sort((a, b) => b.n - a.n);
}
