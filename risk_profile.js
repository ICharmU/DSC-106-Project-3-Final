import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

/** ---------- CONFIG ---------- **/
const CSV_URL  = "./data/japan_prefecture_year_risk_profile_WITH_DECAY.csv";
const JSON_URL = "./data/risk_payload_WITH_DECAY.json";
const KEY_URL  = "./data/prefecture_key_from_kaggle.csv";

const MAP_SVG = d3.select("#map");
const LEGEND  = d3.select("#map-legend");
const DETAIL_SVG = d3.select("#detail-svg");
const DETAIL_TITLE = d3.select("#detail-title");
const DETAIL_SUMMARY = d3.select("#detail-summary");
const YEAR_SLIDER = document.getElementById("myRange");

const WHITE = "#ffffff";
const REDS  = d3.schemeReds[9];

let riskRows = [];
let riskByPrefYear = new Map(); // key `${pref_norm}::${year}`
let yearsDomain = [1960, 2018];
let percentilesSpec = { percentiles:[0,10,25,50,75,90,97,100], global_cutpoints:{} };
let thresholds = [];
let colorScale = d3.scaleThreshold();
let currentYear = 1960;

// Name canonicalization
let nameToNorm = new Map(); // many-keys -> prefecture_norm

// ---------- Name normalizer helpers ----------
const ALIAS_EXTRA = new Map([
  ["tokyo-to", "Tokyo"], ["tokyo", "Tokyo"],
  ["osaka-fu", "Osaka"], ["kyoto-fu", "Kyoto"],
  ["oita-ken", "Oita"],  ["ooita", "Oita"],
  ["miyazaki-ken", "Miyazaki"],
  ["hokkaido", "Hokkaido"], // already canonical
  // add ad-hoc fixes here if console shows misses
]);

function cleanName(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[’'`]/g, "")
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
function toNormKey(s) {
  return cleanName(s).toLowerCase();
}
function canonToPrefNorm(anyName) {
  const k = toNormKey(anyName);
  return nameToNorm.get(k) || null;
}
function getSliderYear() {
  const v = parseInt(YEAR_SLIDER?.value ?? currentYear, 10);
  return isNaN(v) ? currentYear : v;
}

// Build a look-up from your Kaggle key once loadAll() reads it:
//   keyCanon -> prefecture_norm
let CANON2NORM = null;

// Tries many candidate props from various JP GeoJSONs.
// Returns { norm, matched, raw, cleaned, keyUsed }
function resolvePrefectureNameFromProps(props = {}) {
  const rawCandidates = [
    props.name_en, props.NAME_1, props.name_1, props.name,
    props.prefecture, props.pref_name, props.N03_001, props.N03_004,
    props.nam, props.nam_ja, props.nam_ja_en
  ].filter(Boolean);

  // if nothing at all, return an empty miss (don’t crash init)
  if (rawCandidates.length === 0) {
    return { raw: "", cleaned: "", norm: "", matched: false, keyUsed: null };
  }

  // Generate cleaned variants & hyphenless (e.g., "aichi-ken" → "aichiken")
  const variants = [];
  for (const r of rawCandidates) {
    const base = cleanName(r);
    variants.push(base);
    variants.push(base.replace(/[-\s]/g, "")); // dehyphenate
    // try alias table (e.g., tokyo-to → Tokyo)
    if (ALIAS_EXTRA.has(base)) variants.push(cleanName(ALIAS_EXTRA.get(base)));
  }

  // Try to map to your canonical prefecture_norm via CANON2NORM
  if (CANON2NORM) {
    for (const v of variants) {
      if (CANON2NORM.has(v)) {
        return { raw: rawCandidates[0], cleaned: v, norm: CANON2NORM.get(v), matched: true, keyUsed: v };
      }
    }
  }

  // Last-ditch: title-case the first candidate and pray it matches CSV exactly
  const first = rawCandidates[0];
  const guess = first ? first.replace(/[-\s](ken|fu|to|do)$/i, "").trim() : "";
  return { raw: first || "", cleaned: cleanName(first || ""), norm: guess, matched: false, keyUsed: null };
}

/** ---------- WAIT FOR MAP ---------- **/
function waitForMapReady(maxWaitMs = 4000) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    (function tick() {
      const g = d3.select("g.map-group");
      const cnt = g.selectAll("path.prefecture").size();
      if (cnt > 0) return resolve(g);
      if (performance.now() - t0 > maxWaitMs) return reject(new Error("Map paths not found"));
      setTimeout(tick, 80);
    })();
  });
}

// --- Decay helpers ---
function decayForward(prev, years, alpha) {
  // risk_t = risk_{t-Δ} * (1 - alpha)^{Δ}
  if (!Number.isFinite(prev) || prev <= 0) return 0;
  const a = Number.isFinite(alpha) ? Math.max(0, Math.min(1, +alpha)) : 0.1; // default 0.1
  const dt = Math.max(1, Math.round(years || 1));
  return prev * Math.pow(1 - a, dt);
}

// Build dense prefecture-year series by carrying forward with decay
function densifyRiskRows(riskRowsLocal, yearsDomain) {
  const [yMin, yMax] = yearsDomain;
  const byPref = d3.group(riskRowsLocal, d => d.prefecture_norm);

  const denseRows = [];
  const denseMap = new Map(); // key `${norm}::${year}` -> row

  for (const [pref, rows] of byPref.entries()) {
    // Sort existing rows by year
    const sorted = rows
      .map(r => ({ ...r, year: +r.year }))
      .sort((a, b) => a.year - b.year);

    // Pick a decay_alpha for this prefecture (fallback 0.1)
    // Prefer the most common or the latest non-null in rows
    let alpha = 0.1;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const cand = +sorted[i].decay_alpha;
      if (Number.isFinite(cand)) { alpha = cand; break; }
    }

    // Seed: last known year/value
    let lastYearWithRow = null;
    let lastRisk = 0;

    // Make a quick index for sparse lookups
    const rowsByYear = new Map(sorted.map(r => [r.year, r]));

    for (let y = yMin; y <= yMax; y++) {
      const k = `${pref}::${y}`;
      const src = rowsByYear.get(y);

      if (src) {
        // Use the CSV row as-is
        denseMap.set(k, src);
        denseRows.push(src);
        lastYearWithRow = y;
        lastRisk = +src.risk_final;
      } else {
        // No row this year — synthesize via decay from last known year
        const dt = (lastYearWithRow == null) ? 1 : (y - lastYearWithRow);
        const risk_final = decayForward(lastRisk, dt, alpha);

        const synthetic = {
          prefecture_norm: pref,
          year: y,
          population: null,
          n_events: 0,
          H_sum: 0, E_sum: 0,
          human_burden: 0, econ_burden: 0,
          H_pref_norm: 0, E_pref_norm: 0, logE_pref_norm: 0, N_norm: 0,
          risk_pref_raw: 0,
          risk_year_norm: 0,
          risk_cum_raw: null,
          risk_cum_norm: null,
          risk_final: risk_final,
          half_life_years: null,
          decay_alpha: alpha,
          blend_prev_weight: null,
          __synthetic: true
        };
        denseMap.set(k, synthetic);
        denseRows.push(synthetic);
      }
    }
  }

  return { denseRows, denseMap };
}

/** ---------- LOAD ---------- **/
async function loadAll() {
    // paths
    const KEY_URL  = "./data/prefecture_key_from_kaggle.csv";
    const RISK_URL = "./data/japan_prefecture_year_risk_profile_WITH_DECAY.csv";
    const JSON_URL_LOCAL = "./data/risk_payload_WITH_DECAY.json"; // optional

    console.time("[risk_profile] loadAll");

    const [keyRows, riskRowsLocal] = await Promise.all([
        d3.csv(KEY_URL),
        d3.csv(RISK_URL)
    ]);

    if (!keyRows?.length) throw new Error(`Prefecture key CSV empty/missing at ${KEY_URL}`);
    if (!riskRowsLocal?.length) throw new Error(`Risk CSV empty/missing at ${RISK_URL}`);

    // Build canon→norm dictionary from Kaggle key.
    // Accept many forms: "aichi-ken", "aichiken", "aichi".
    CANON2NORM = new Map();
    keyRows.forEach(r => {
        const norm = r.prefecture_norm?.trim();
        if (!norm) return;
        const p = r.prefecture?.trim() || ""; // e.g., "Aichi-ken"
        const variants = new Set([
        cleanName(p),
        cleanName(p).replace(/[-\s]/g, ""),
        cleanName(norm),
        cleanName(norm).replace(/[-\s]/g, "")
        ]);
        variants.forEach(v => CANON2NORM.set(v, norm));
    });

    // Years domain from sparse CSV
    const yearsSparse = riskRowsLocal.map(r => +r.year).filter(Number.isFinite);
    yearsDomain = [d3.min(yearsSparse) || 1960, d3.max(yearsSparse) || 2018];   // <-- set local

    // Densify series
    const { denseRows, denseMap } = densifyRiskRows(riskRowsLocal, yearsDomain);

    // Expose both (local AND window to be safe for other scripts/devtools)
    riskRows           = denseRows;     window.riskRows           = denseRows;
    riskByPrefYear     = denseMap;      window.riskByPrefYear     = denseMap;
    window.riskRowsSparse = riskRowsLocal;

    // Diagnostics
    const synthCount = denseRows.filter(r => r.__synthetic).length;
    console.log(`[risk_profile] densify: ${synthCount} synthetic rows (decay carry-forward)`);

    // Build color scale domain from DENSE values
    const values = denseRows.map(r => +r.risk_final).filter(Number.isFinite);
    const vMin = d3.min(values) ?? 0, vMax = d3.max(values) ?? 1;

    // Quantile bins (9)
    const colorBins = d3.range(0.1, 1.0, 0.1).map(q => d3.quantile(values, q));
    colorScale = d3.scaleThreshold().domain(colorBins).range(d3.schemeReds[9]);  // <-- set local
    window.colorBins = colorBins;                                                // (optional)
    window.colorScale = colorScale;                                              // (optional)

    console.log("[risk_profile] key rows:", keyRows.length);
    console.log("[risk_profile] risk rows:", riskRowsLocal.length, "min/max risk_final", vMin, vMax);
    console.log("[risk_profile] years:", yearsDomain);

    // Keep these for legend/ticks
    window.vMin = vMin;
    window.vMax = vMax;

    // (Optional) expose a cutpoint map the old code expected
    window.percentilesSpec = {
    percentiles: [0,10,20,30,40,50,60,70,80,90,100],
    // Turn our 9 bins into a 0..100 map; use linear spacing to label
    global_cutpoints: (() => {
        const cuts = {};
        const stops = [vMin, ...colorBins, vMax]; // 10 edges → 9 bins
        // map them to 0,10,...,100 so labels are monotone & nice
        const labels = d3.range(0, 110, 10);
        stops.forEach((s, i) => { cuts[labels[i]] = s; });
        return cuts;
    })()
    };

    // Optional formulas json
    try {
        window.widgetJSON = await d3.json(JSON_URL_LOCAL);
        console.log("[risk_profile] formulas json loaded");
    } catch (e) {
        console.log("[risk_profile] formulas json not found (ok)");
    }

    console.timeEnd("[risk_profile] loadAll");
}

/** ---------- PAINT ---------- **/
function shadePrefectures(year) {
  window.currentYear = year;
  const g = d3.select("g.map-group");
  const pts = g.select("g.points");

  let total = 0, hits = 0, misses = 0;
  const missList = [];

  g.selectAll("path.prefecture").each(function(d) {
    total += 1;
    const norm = d?.properties?.__prefNorm || "";
    const row  = norm ? riskByPrefYear.get(`${norm}::${year}`) : null;
    const val  = row ? +row.risk_final : NaN;
    const sel  = d3.select(this);
    if (Number.isFinite(val)) {
      sel.attr("fill", colorScale(val));
      hits += 1;
    } else {
      sel.attr("fill", "#f9fbfd");
      misses += 1;
      missList.push(norm || "(unnamed)");
    }
  });

  if (!pts.empty()) pts.raise();
  console.log(`[risk_profile] shade ${year}: ${hits}/${total} joined (${misses} misses)`);
  if (misses) console.debug(`[risk_profile] sample misses ${year}:`, missList.slice(0, 8));
}

/** ---------- LEGEND ---------- **/
function drawLegend() {
  LEGEND.selectAll("*").remove();

  // If the scale isn't ready, bail silently
  if (!colorScale || !colorScale.domain || !colorScale.range) return;

  const thresholds = colorScale.domain();      // length 8 for Reds[9]
  const colors     = colorScale.range();       // length 9
  const minVal     = (typeof window.vMin === "number") ? window.vMin : 0;
  const maxVal     = (typeof window.vMax === "number") ? window.vMax : 1;

  // Bin edges = [min, t1, t2, ..., t8, max]
  const edges = [minVal, ...thresholds, maxVal];

  // Container
  const box = LEGEND.append("div")
    .attr("class", "legend");

  // Title (optional)
  box.append("div")
    .attr("class", "legend-title")
    .text("Risk (final) — percentile bins");

  // Bar
  const bar = box.append("div").attr("class", "legend-bar");
  const nBins = colors.length;
  const totalWidth = 100;
  const each = totalWidth / nBins;

  for (let i = 0; i < nBins; i++) {
    bar.append("div")
      .attr("class", "legend-swatch")
      .style("width", `${each}%`)
      .style("background", colors[i]);
  }

  // Tick labels under the edges (integers, risk × 100)
  const ticks = box.append("div").attr("class", "legend-ticks");
  edges.forEach((v, i) => {
    ticks.append("span")
      .attr("class", "legend-tick")
      .style("left", `${(i / (edges.length - 1)) * 100}%`)
      .text(String(Math.round(v * 100)));
  });

  // Note
  box.append("div")
    .attr("class", "legend-note")
    .text("Numbers are risk × 100; colors are global percentiles.");
}

/** ---------- DETAIL ---------- **/
function renderDetail(prefRawName) {
  // Find the stamped norm from any polygon whose raw name cleans to the same string
  let norm = null;
  const rawClean = cleanName(prefRawName);
  d3.select("g.map-group").selectAll("path.prefecture").each(function(d) {
    const p = d?.properties || {};
    const raw = p.name_en || p.NAME_1 || p.name || p.prefecture || p.pref_name || p.N03_001 || p.N03_004 || "";
    if (cleanName(raw) === rawClean) norm = p.__prefNorm || null;
  });

  if (!norm) {
    // Fall back to resolver if click came from elsewhere
    const r = resolvePrefectureNameFromProps({ name_en: prefRawName });
    norm = r.norm;
  }

  const rows = window.riskRows.filter(r => r.prefecture_norm === norm);
  if (rows.length === 0) {
    d3.select("#detail-title").text(`No data for ${prefRawName}`);
    d3.select("#detail-svg").selectAll("*").remove();
    d3.select("#detail-summary").text("");
    console.warn("[risk_profile] detail: no rows for", prefRawName, "→", norm);
    return;
  }

  const DETAIL_SVG = d3.select("#detail-svg");
  const DETAIL_TITLE = d3.select("#detail-title");
  const DETAIL_SUMMARY = d3.select("#detail-summary");

  DETAIL_TITLE.text(`${norm} — risk over time`);

  const margin = { top: 20, right: 18, bottom: 28, left: 38 };
  const W = Math.max(520, parseInt(DETAIL_SVG.style("width")) || 560);
  const H = 280;
  const width  = W - margin.left - margin.right;
  const height = H - margin.top - margin.bottom;

  DETAIL_SVG.attr("viewBox", `0 0 ${W} ${H}`).selectAll("*").remove();
  const gg = DETAIL_SVG.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  const x = d3.scaleLinear().domain(yearsDomain).range([0, width]);
  const y = d3.scaleLinear().domain([0, 1]).nice().range([height, 0]);

  gg.append("g").attr("transform", `translate(0,${height})`).call(d3.axisBottom(x).ticks(8).tickFormat(d3.format("d")));
  gg.append("g").call(d3.axisLeft(y).ticks(5));

  gg.selectAll("circle")
    .data(rows)
    .join("circle")
    .attr("cx", d => x(+d.year))
    .attr("cy", d => y(+d.risk_final))
    .attr("r", d => (+d.year === +window.currentYear ? 4 : 3))
    .attr("fill", d => colorScale(+d.risk_final))
    .attr("stroke", d => d.__synthetic ? "#666" : "#333")
    .attr("stroke-dasharray", d => d.__synthetic ? "2,2" : null)
    .attr("stroke-width", 0.7)
    .append("title")
    .text(d => `Year ${d.year}\nRisk ${(d.risk_final*100).toFixed(1)}${d.__synthetic ? " (decayed)" : ""}`);

  gg.append("line")
    .attr("x1", x(window.currentYear)).attr("x2", x(window.currentYear))
    .attr("y1", 0).attr("y2", height)
    .attr("stroke", "#bc002d").attr("stroke-dasharray", "3,3");

  const latest = rows.find(r => +r.year === +window.currentYear);
  const txt = latest
    ? `Year ${window.currentYear} • Risk ${(latest.risk_final*100).toFixed(1)} • Events ${latest.n_events ?? "—"}`
    : `Year ${window.currentYear} • Risk —`;
  DETAIL_SUMMARY.text(txt);
}

/** ---------- FORMULAS (LaTeX) ---------- **/
function drawFormulas(formulas) {
  d3.select("#formula-box").remove();
  const box = d3.select("#detail-container").append("div").attr("id", "formula-box");
  const human = formulas?.human_event?.latex || "";
  const econ  = formulas?.econ_event?.latex || "";
  const risk  = formulas?.risk_pref_year?.latex || "";
  const decay = formulas?.decay_blend?.latex || "";
  box.html(`
    <h3>Current risk definitions</h3>
    <div>Event (human): \\(${human}\\)</div>
    <div>Event (economic): \\(${econ}\\)</div>
    <div>Prefecture-year risk: \\(${risk}\\)</div>
    <div>Decay & blend: \\(${decay}\\)</div>
  `);
  if (window.MathJax?.typesetPromise) window.MathJax.typesetPromise([box.node()]);
}

/** ---------- YEAR CHANGES ---------- **/
function hookYearChanges() {
  if (YEAR_SLIDER) {
    YEAR_SLIDER.addEventListener("input", () => {
      const y = getSliderYear();
      shadePrefectures(y);
      // keep detail in sync
      const title = DETAIL_TITLE.text();
      const pref = title.split(" — ")[0];
      if (pref && pref !== "Click a prefecture to explore its profile") renderDetail(pref);
    });
  }
  // polling to catch autoplay
  let lastYear = getSliderYear();
  setInterval(() => {
    const y = getSliderYear();
    if (y !== lastYear) {
      lastYear = y;
      shadePrefectures(y);
      const title = DETAIL_TITLE.text();
      const pref = title.split(" — ")[0];
      if (pref && pref !== "Click a prefecture to explore its profile") renderDetail(pref);
    }
    // keep points above polygons during autoplay
    const g = d3.select("g.map-group");
    const points = g.select("g.points");
    if (!points.empty()) points.raise();
  }, 180);
}

/** ---------- CLICK BIND (after map is ready) ---------- **/
function bindClicks() {
  const g = d3.select("g.map-group");
  g.selectAll("path.prefecture").on("click.risk", function (event, d) {
    const p = d?.properties || {};
    const raw = p.name_en || p.NAME_1 || p.name || p.prefecture || p.pref_name || p.N03_001 || p.N03_004 || "";
    renderDetail(raw || p.__prefNorm || "Prefecture");
  });
}

/** ---------- INIT ---------- **/
(async function init() {
  try {
    await loadAll();
    const g = await waitForMapReady(); // ensure paths exist

    // Spot-check a few keys exist in the map
    ["Tokyo","Osaka","Hokkaido","Okinawa","Aichi"].forEach(p => {
        const k = `${p}::${yearsDomain[0]}`;
        if (!riskByPrefYear.has(k)) console.warn("[risk_profile] missing key", k);
    });


    g.selectAll("path.prefecture").each(function(d) {
        const props = d?.properties || {};
        const r = resolvePrefectureNameFromProps(props);

        // If we truly have no name props at all, skip stamping (tiny islets / artifacts)
        if (!r.raw && !r.cleaned) {
            props.__prefNorm = ""; // leaves it unjoinable (renders default fill)
            return;
        }

        props.__prefNorm = r.norm || "";
        props.__engName  = r.norm || r.raw || ""; // used by other scripts

        if (!r.matched) {
            console.warn("[risk_profile] name miss:", { raw: r.raw, cleaned: r.cleaned, fallbackNorm: r.norm });
        }
    });

    (function () {
        let empty = 0;
        const sample = [];
        d3.select("g.map-group").selectAll("path.prefecture").each(function(d) {
            const norm = d?.properties?.__prefNorm || "";
            if (!norm) empty++;
            else if (sample.length < 6) sample.push(norm);
        });
        if (empty) console.warn(`[risk_profile] polygons missing __prefNorm: ${empty}`);
        console.debug("[risk_profile] sample stamped norms:", sample);
    })();

    // First draw
    shadePrefectures(currentYear);
    drawLegend();

    // Quick sanity log: how many joins succeeded for the initial year?
    (function () {
    const y = currentYear;
    let have = 0, total = 0;
    d3.select("g.map-group").selectAll("path.prefecture").each(function(d) {
        total += 1;
        const norm = d?.properties?.__prefNorm || "";
        if (riskByPrefYear.has(`${norm}::${y}`)) have += 1;
    });
    console.log(`[risk_profile] year ${y}: ${have}/${total} prefectures joined`);
    })();

    // formulas come from JSON payload emitted by your notebook
    try {
      const j = await d3.json(JSON_URL);
      drawFormulas(j?.formulas || {});
    } catch (e) {
      // ignore if JSON already loaded above
    }

    // bind clicks and year changes
    bindClicks();
    hookYearChanges();

    // ensure points on top now
    const points = g.select("g.points");
    if (!points.empty()) points.raise();

  } catch (err) {
    console.error("[risk_profile_layer] init error:", err);
  }
})();