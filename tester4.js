import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

// --- small contract ---
// Inputs: optional CSV at ./data/2022-epi-raw-data-time-series/POP_raw.csv (not required for the map)
// Output: a responsive SVG world map rendered into #map
// Error modes: fetch failures logged to console

// Try to load the CSV (if present) but continue even if it's missing.
let rawData = null;
try {
  rawData = await d3.csv("./data/pend-gdis-1960-2018-disasterlocations.csv");
  console.log("Loaded CSV rows:", rawData.length);
} catch (err) {
  console.warn("CSV not loaded (this is optional for the map):", err.message);
}

// Map drawing
const container = d3.select('#map');

const width = 960;
const height = 600;

// If the #map element is already an <svg>, reuse it; otherwise append one.
let svg;
if (container.node() && container.node().nodeName && container.node().nodeName.toLowerCase() === 'svg') {
  svg = container;
  svg.attr('viewBox', `0 0 ${width} ${height}`)
     .attr('preserveAspectRatio', 'xMidYMid')
     .attr('role', 'img')
     .attr('aria-label', 'World map')
     .style('width', '100%')
     .style('height', 'auto');
} else {
  svg = container.append('svg')
    .attr('viewBox', `0 0 ${width} ${height}`)
    .attr('preserveAspectRatio', 'xMidYMid')
    .attr('role', 'img')
    .attr('aria-label', 'World map')
    .style('width', '100%')
    .style('height', 'auto');
}

// add a subtle border to the SVG container for visual separation
svg.style('border', '1px solid #ccc')
   .style('border-radius', '4px');

// create or reuse a single group for map content
let g = svg.select('g');
if (g.empty()) g = svg.append('g');

const projection = d3.geoNaturalEarth1()
  .scale(160)
  .translate([width / 2, height / 2]);

const path = d3.geoPath().projection(projection);

// GeoJSON source (public). If you prefer a local copy, download and point here.
const worldGeoUrl = 'https://raw.githubusercontent.com/holtzy/D3-graph-gallery/master/DATA/world.geojson';

async function drawMap() {
  try {
    const world = await d3.json(worldGeoUrl);

    // helper to get iso3 from GeoJSON feature
    // This is robust: it checks common iso3 properties, normalizes to uppercase,
    // and applies an alias map for known mismatches (e.g. GeoJSON uses "SDS" while CSV uses "SSD").
    function featureIso3(f) {
      const p = f.properties || {};
      // small alias map: geojson-id/name -> CSV iso3
      const aliasMap = {
        // South Sudan: geojson file uses "SDS" but CSV uses "SSD"
        'SDS': 'SSD'
        // add more entries here if you discover other mismatches, e.g. 'ROM': 'ROU'
      };

      // candidate fields that commonly hold a 3-letter ISO code
      const candidates = [f.id, p.iso_a3, p.ISO_A3, p.iso3, p.ISO3, p.adm0_a3, p.ADM0_A3, p.iso, p.ISO];
      let iso = null;
      for (const c of candidates) {
        if (!c) continue;
        const s = c.toString().trim();
        // accept only 3-letter alpha codes
        if (/^[A-Za-z]{3}$/.test(s)) {
          iso = s.toUpperCase();
          break;
        }
      }

      if (!iso) return null;
      // apply alias mapping if present
      if (aliasMap[iso]) return aliasMap[iso];
      return iso;
    }
    // prepare variables for population bins and lookups; these will be built per-year
    let popLookup = new Map();
    let nameLookup = new Map();
    let pops = [];
    const numBins = 10;
    let quantileScale = null;
    let binThresholds = [];

    // color accessor for bins using a perceptual interpolator (Greens)
    function binColor(binIndex) {
      const t = 0.15 + (binIndex / (numBins - 1)) * 0.8;
      return d3.interpolateGreens(t);
    }

    // tooltip
    const tip = d3.select('body').append('div')
      .attr('class', 'd3-tooltip')
      .style('position', 'absolute')
      .style('pointer-events', 'none')
      .style('padding', '6px 8px')
      .style('background', 'rgba(0,0,0,0.7)')
      .style('color', '#fff')
      .style('font-size', '13px')
      .style('border-radius', '4px')
      .style('display', 'none')
      .style('z-index', 1000);

    // optional: add graticule (non-interactable) BEFORE countries so gridlines render under country shapes
    const graticule = d3.geoGraticule();
    g.append('path')
      .datum(graticule())
      .attr('d', path)
      .attr('fill', 'none')
      .attr('stroke', '#ddd')
      .attr('stroke-width', 0.4)
      .attr('pointer-events', 'none');

    // --- swatch state persistence ---
    // Keep user toggles across year changes and across page reloads (localStorage).
    let swatchState = {};
    try {
      const s = localStorage.getItem('swatchState');
      if (s) swatchState = JSON.parse(s);
    } catch (e) {
      swatchState = {};
    }
    function setSwatchState(key, val) {
      swatchState[key] = val ? 1 : 0;
      try { localStorage.setItem('swatchState', JSON.stringify(swatchState)); } catch (e) {}
    }

    // draw country paths (classed so graticule remains separate)
    const countryPaths = g.selectAll('path.country')
      .data(world.features)
      .join('path')
      .attr('class', 'country')
      .attr('d', path)
      .attr('fill', '#eee')
      .attr('fill-opacity', 1)
      .attr('stroke', '#555')
      .attr('stroke-width', 0.3)
      .on('mouseover', function (event, d) {
        d3.select(this).attr('stroke-width', 0.8);
        // lookup population
        const pName = (d.properties && (d.properties.name || d.properties.ADMIN || d.properties.NAME)) || 'Unknown';
        const iso = (featureIso3(d) || '').toString().toUpperCase();
        let p = popLookup.get(iso);
        if (p == null) {
          // try matching by name (case-insensitive)
          const lower = pName.toLowerCase();
          const entry = nameLookup.get(lower);
          if (entry) p = entry.val;
        }
        const valText = p == null ? 'No data' : d3.format(',')(p);
        let binLabel = 'No data';
        if (p != null && pops.length) {
          const binIndex = quantileScale(p);
          binLabel = `${binIndex * 10}-${(binIndex + 1) * 10}%`;
        }
        tip.style('display', 'block')
          .html(`<strong>${pName}</strong><br>POP ${currentYear}: ${valText}<br>Decile: ${binLabel}`);
      })
      .on('mousemove', function (event) {
        tip.style('left', (event.pageX + 12) + 'px')
          .style('top', (event.pageY + 12) + 'px');
      })
      .on('mouseout', function () {
        d3.select(this).attr('stroke-width', 0.3);
        tip.style('display', 'none');
      });

      // helper: parse slider and selected year
      const yearSlider = d3.select('#year-slider');
      const yearValueSpan = d3.select('#year-value');
      // derive available years.
      // Prefer POP.raw.YYYY column names if this CSV is a POP timeseries; otherwise
      // extract unique numeric years from the loaded rows (useful for the disaster CSV).
      let availableYears = [];
      if (rawData && rawData.columns) {
        // try POP-style columns first
        availableYears = rawData.columns
          .map(c => {
            const m = c.match(/^POP\.raw\.(\d{4})$/);
            return m ? +m[1] : null;
          })
          .filter(y => y && y <= 2020)
          .sort((a, b) => a - b);
      }
      // If POP-style columns weren't found, derive years from row values (e.g. disaster CSV)
      if (!availableYears.length && rawData && rawData.length) {
        const yrs = Array.from(new Set(rawData.map(d => {
          const y = d.year ?? d.Year ?? d.YEAR ?? d['year'] ?? null;
          const n = parseInt(y, 10);
          return isFinite(n) ? n : null;
        }).filter(Boolean)));
        yrs.sort((a, b) => a - b);
        availableYears = yrs.filter(y => y && y <= 2020);
      }
  // Always ensure 1960 is present (per request). If it's outside dataset range
  // we'll still expose it so the slider can be used to inspect that year.
  if (!availableYears.includes(1960)) availableYears.push(1960);
      availableYears = Array.from(new Set(availableYears)).sort((a, b) => a - b);
  if (!availableYears.length) availableYears = [1960];
      const minYear = availableYears[0];
      const maxYear = availableYears[availableYears.length - 1];
      // choose a default start year: prefer 1960 if available, otherwise use minYear
      const defaultStart = availableYears.includes(1960) ? 1960 : minYear;
      if (!yearSlider.empty()) {
        yearSlider.attr('min', minYear).attr('max', maxYear).attr('step', 1);
        // set the slider to the chosen default start year on initial load
        yearSlider.node().value = defaultStart;
      }
      const selectedYear = yearSlider.empty() ? defaultStart : +yearSlider.node().value;
      let currentYear = selectedYear;

    // render function: builds popLookup for a year, computes quantile bins, updates fills and legend
    function renderForYear(year) {
      currentYear = year;
      // build lookups
      popLookup = new Map();
      nameLookup = new Map();
      if (rawData) {
        rawData.forEach(d => {
          const iso = (d.iso || '').toString().trim();
          const name = (d.country || '').toString().trim();
          const key = `POP.raw.${year}`;
          let val = +d[key];
          if (!isFinite(val) || val < 0) val = null;
          if (iso) popLookup.set(iso, val);
          if (name) nameLookup.set(name.toLowerCase(), { iso, val, name });
        });
      }
      pops = Array.from(popLookup.values()).filter(v => v != null);
      if (pops.length) {
        quantileScale = d3.scaleQuantile().domain(pops).range(d3.range(numBins));
        binThresholds = quantileScale.quantiles();
      } else {
        quantileScale = () => null;
        binThresholds = [];
      }

      // recolor countries (try iso3 first, then fallback to name-based lookup)
      countryPaths.attr('fill', d => {
        const iso = (featureIso3(d) || '') ? (featureIso3(d) || '').toString().toUpperCase() : '';
        let p = iso ? popLookup.get(iso) : null;
        if (p == null) {
          // try matching by country name (case-insensitive)
          const pName = (d.properties && (d.properties.name || d.properties.ADMIN || d.properties.NAME)) || '';
          const entry = nameLookup.get(pName.toLowerCase());
          if (entry) p = entry.val;
        }
        if (p == null) return '#eee';
        const bin = quantileScale(p);
        return binColor(bin);
      });

      // update HTML legend row (under the slider)
      // Simplified: show a single red swatch (non-interactive) as requested.
        const htmlLegend = d3.select('#legend-row');
        if (!htmlLegend.empty()) {
          htmlLegend.html('');
          const col = htmlLegend.append('div')
            .attr('class', 'legend-column')
            .style('display', 'flex')
            .style('flex-direction', 'column')
            .style('align-items', 'center')
            .style('gap', '6px');


          // top row: three red swatches
          const topRow = col.append('div')
            .attr('class', 'swatch-top-row')
            .style('display', 'flex')
            .style('flex-direction', 'row')
            .style('gap', '6px');

          // row 1: mass movement, landslide, earthquake
          // row 1 pairs: swatch + label
          const topPair1 = topRow.append('div')
            .style('display', 'flex')
            .style('align-items', 'center')
            .style('gap', '8px');
          // mass movement swatch (UI-only click sets it to gray)
          const massSw = topPair1.append('div')
            .attr('class', 'swatch mass-movement')
            .style('width', '28px')
            .style('height', '16px')
            .style('border', '1px solid #ccc')
            .style('background', '#6ec6ff')
            .attr('title', 'Mass movement')
            // store original color and a toggle flag as attributes so we can restore later
            .attr('data-orig', '#6ec6ff')
            .attr('data-toggled', '0')
            .style('cursor', 'pointer')
            .on('click', function () {
              // UI-only toggle: gray <-> original color
              const el = d3.select(this);
              const toggled = el.attr('data-toggled') === '1';
              if (toggled) {
                el.style('background', el.attr('data-orig'))
                  .attr('data-toggled', '0');
              } else {
                el.style('background', '#888')
                  .attr('data-toggled', '1');
              }
              if (typeof plotPoints === 'function') plotPoints(currentYear);
            });
          topPair1.append('div')
            .attr('class', 'swatch-label')
            .style('font-size', '12px')
            .style('color', '#333')
            .text('Mass movement');

          const topPair2 = topRow.append('div')
            .style('display', 'flex')
            .style('align-items', 'center')
            .style('gap', '8px');
          topPair2.append('div')
            .attr('class', 'swatch landslide')
            .style('width', '28px')
            .style('height', '16px')
            .style('border', '1px solid #ccc')
            .style('background', '#8b5a2b')
            .attr('title', 'Landslide')
            .attr('data-orig', '#8b5a2b')
            .attr('data-toggled', '0')
            .style('cursor', 'pointer')
            .on('click', function () {
              const el = d3.select(this);
              const toggled = el.attr('data-toggled') === '1';
              if (toggled) {
                el.style('background', el.attr('data-orig')).attr('data-toggled', '0');
              } else {
                el.style('background', '#888').attr('data-toggled', '1');
              }
            });
          topPair2.append('div')
            .attr('class', 'swatch-label')
            .style('font-size', '12px')
            .style('color', '#333')
            .text('Landslide');

          const topPair3 = topRow.append('div')
            .style('display', 'flex')
            .style('align-items', 'center')
            .style('gap', '8px');
          topPair3.append('div')
            .attr('class', 'swatch earthquake')
            .style('width', '28px')
            .style('height', '16px')
            .style('border', '1px solid #ccc')
            .style('background', '#8b4513')
            .attr('title', 'Earthquake')
            .attr('data-orig', '#8b4513')
            .attr('data-toggled', '0')
            .style('cursor', 'pointer')
            .on('click', function () {
              const el = d3.select(this);
              const toggled = el.attr('data-toggled') === '1';
              if (toggled) {
                el.style('background', el.attr('data-orig')).attr('data-toggled', '0');
              } else {
                el.style('background', '#888').attr('data-toggled', '1');
              }
            });
          topPair3.append('div')
            .attr('class', 'swatch-label')
            .style('font-size', '12px')
            .style('color', '#333')
            .text('Earthquake');

          // middle row: three blue swatches (directly below the red row)
          const midRow = col.append('div')
            .attr('class', 'swatch-mid-row')
            .style('display', 'flex')
            .style('flex-direction', 'row')
            .style('gap', '6px');

          // row 2: drought, flood, storm
          // row 2 pairs: swatch + label
          const midPair1 = midRow.append('div')
            .style('display', 'flex')
            .style('align-items', 'center')
            .style('gap', '8px');
          midPair1.append('div')
            .attr('class', 'swatch drought')
            .style('width', '28px')
            .style('height', '16px')
            .style('border', '1px solid #ccc')
            .style('background', '#d99058')
            .attr('title', 'Drought')
            .attr('data-orig', '#d99058')
            .attr('data-toggled', '0')
            .style('cursor', 'pointer')
            .on('click', function () {
              const el = d3.select(this);
              const toggled = el.attr('data-toggled') === '1';
              if (toggled) {
                el.style('background', el.attr('data-orig')).attr('data-toggled', '0');
              } else {
                el.style('background', '#888').attr('data-toggled', '1');
              }
            });
          midPair1.append('div')
            .attr('class', 'swatch-label')
            .style('font-size', '12px')
            .style('color', '#333')
            .text('Drought');

          const midPair2 = midRow.append('div')
            .style('display', 'flex')
            .style('align-items', 'center')
            .style('gap', '8px');
          midPair2.append('div')
            .attr('class', 'swatch flood')
            .style('width', '28px')
            .style('height', '16px')
            .style('border', '1px solid #ccc')
            .style('background', '#1f78b4')
            .attr('title', 'Flood')
            .attr('data-orig', '#1f78b4')
            .attr('data-toggled', '0')
            .style('cursor', 'pointer')
            .on('click', function () {
              const el = d3.select(this);
              const toggled = el.attr('data-toggled') === '1';
              if (toggled) {
                el.style('background', el.attr('data-orig')).attr('data-toggled', '0');
              } else {
                el.style('background', '#888').attr('data-toggled', '1');
              }
            });
          midPair2.append('div')
            .attr('class', 'swatch-label')
            .style('font-size', '12px')
            .style('color', '#333')
            .text('Flood');

          const midPair3 = midRow.append('div')
            .style('display', 'flex')
            .style('align-items', 'center')
            .style('gap', '8px');
          midPair3.append('div')
            .attr('class', 'swatch storm')
            .style('width', '28px')
            .style('height', '16px')
            .style('border', '1px solid #ccc')
            .style('background', '#6a0dad')
            .attr('title', 'Storm')
            .attr('data-orig', '#6a0dad')
            .attr('data-toggled', '0')
            .style('cursor', 'pointer')
            .on('click', function () {
              const el = d3.select(this);
              const toggled = el.attr('data-toggled') === '1';
              if (toggled) {
                el.style('background', el.attr('data-orig')).attr('data-toggled', '0');
              } else {
                el.style('background', '#888').attr('data-toggled', '1');
              }
            });
          midPair3.append('div')
            .attr('class', 'swatch-label')
            .style('font-size', '12px')
            .style('color', '#333')
            .text('Storm');

          // bottom row: three green swatches (directly below the blue row)
          const bottomRow = col.append('div')
            .attr('class', 'swatch-bottom-row')
            .style('display', 'flex')
            .style('flex-direction', 'row')
            .style('gap', '6px');

          // row 3: severe temperature, volcanic activity, other/unknown
          // row 3 pairs: swatch + label
          const botPair1 = bottomRow.append('div')
            .style('display', 'flex')
            .style('align-items', 'center')
            .style('gap', '8px');
          botPair1.append('div')
            .attr('class', 'swatch temperature')
            .style('width', '28px')
            .style('height', '16px')
            .style('border', '1px solid #ccc')
            .style('background', '#ffd700')
            .attr('title', 'Severe temperature')
            .attr('data-orig', '#ffd700')
            .attr('data-toggled', '0')
            .style('cursor', 'pointer')
            .on('click', function () {
              const el = d3.select(this);
              const toggled = el.attr('data-toggled') === '1';
              if (toggled) {
                el.style('background', el.attr('data-orig')).attr('data-toggled', '0');
              } else {
                el.style('background', '#888').attr('data-toggled', '1');
              }
            });
          
          // legend DOM built; the swatch-specific initialization and handlers
          // will be attached after all swatches are created (see below).
          botPair1.append('div')
            .attr('class', 'swatch-label')
            .style('font-size', '12px')
            .style('color', '#333')
            .text('Severe temperature');

          const botPair2 = bottomRow.append('div')
            .style('display', 'flex')
            .style('align-items', 'center')
            .style('gap', '8px');
          botPair2.append('div')
            .attr('class', 'swatch volcano')
            .style('width', '28px')
            .style('height', '16px')
            .style('border', '1px solid #ccc')
            .style('background', '#ff8c00')
            .attr('title', 'Volcanic activity')
            .attr('data-orig', '#ff8c00')
            .attr('data-toggled', '0')
            .style('cursor', 'pointer')
            .on('click', function () {
              const el = d3.select(this);
              const toggled = el.attr('data-toggled') === '1';
              if (toggled) {
                el.style('background', el.attr('data-orig')).attr('data-toggled', '0');
              } else {
                el.style('background', '#888').attr('data-toggled', '1');
              }
            });
          botPair2.append('div')
            .attr('class', 'swatch-label')
            .style('font-size', '12px')
            .style('color', '#333')
            .text('Volcanic activity');

          const botPair3 = bottomRow.append('div')
            .style('display', 'flex')
            .style('align-items', 'center')
            .style('gap', '8px');
          botPair3.append('div')
            .attr('class', 'swatch other-unknown')
            .style('width', '28px')
            .style('height', '16px')
            .style('border', '1px solid #ccc')
            .style('background', '#d62728')
            .attr('title', 'Other / Unknown')
            .attr('data-orig', '#d62728')
            .attr('data-toggled', '0')
            .style('cursor', 'pointer')
            .on('click', function () {
              const el = d3.select(this);
              const toggled = el.attr('data-toggled') === '1';
              if (toggled) {
                el.style('background', el.attr('data-orig')).attr('data-toggled', '0');
              } else {
                el.style('background', '#888').attr('data-toggled', '1');
              }
            });
          botPair3.append('div')
            .attr('class', 'swatch-label')
            .style('font-size', '12px')
            .style('color', '#333')
            .text('Other / Unknown');
          
          // Now that all swatches exist in the DOM, initialize their persistent
          // state (from localStorage) and attach a unified click handler that
          // updates state and re-renders points. This ensures volcano and other
          // swatches are included.
          const swatchDefs = [
            { sel: '.swatch.mass-movement', key: 'massmovement', orig: '#6ec6ff' },
            { sel: '.swatch.landslide', key: 'landslide', orig: '#8b5a2b' },
            { sel: '.swatch.earthquake', key: 'earthquake', orig: '#8b4513' },
            { sel: '.swatch.drought', key: 'drought', orig: '#d99058' },
            { sel: '.swatch.flood', key: 'flood', orig: '#1f78b4' },
            { sel: '.swatch.storm', key: 'storm', orig: '#6a0dad' },
            { sel: '.swatch.temperature', key: 'temperature', orig: '#ffd700' },
            { sel: '.swatch.volcano', key: 'volcano', orig: '#ff8c00' },
            { sel: '.swatch.other-unknown', key: 'other', orig: '#d62728' }
          ];

          swatchDefs.forEach(def => {
            const el = d3.select(def.sel);
            if (el.empty()) return;
            el.attr('data-key', def.key).attr('data-orig', def.orig);
            const off = (swatchState[def.key] === 1);
            el.attr('data-toggled', off ? '1' : '0');
            el.style('background', off ? '#888' : def.orig);
            el.style('cursor', 'pointer');
          });

          // unified click handler
          d3.selectAll('.swatch').on('click', function () {
            const el = d3.select(this);
            const key = el.attr('data-key') || '';
            const toggled = el.attr('data-toggled') === '1';
            if (toggled) {
              el.style('background', el.attr('data-orig') || '#fff').attr('data-toggled', '0');
              if (key) setSwatchState(key, 0);
            } else {
              el.style('background', '#888').attr('data-toggled', '1');
              if (key) setSwatchState(key, 1);
            }
            if (typeof plotPoints === 'function') plotPoints(currentYear);
          });
        }
    }

  // initial render and slider wiring
  renderForYear(selectedYear);
    if (!yearSlider.empty()) {
      yearValueSpan.text(selectedYear);
      yearSlider.on('input', function () {
        const y = +this.value;
        yearValueSpan.text(y);
        renderForYear(y);
        if (typeof plotPoints === 'function') plotPoints(y);
      });
    }

      // Play button behavior: animate through availableYears over 5 seconds total.
      const playBtn = d3.select('#play-btn');
      let playTimer = null;
      let isPlaying = false;

      function stopPlayback() {
        if (playTimer) {
          clearInterval(playTimer);
          playTimer = null;
        }
        isPlaying = false;
        if (!playBtn.empty()) playBtn.text('Play ▶');
        if (!yearSlider.empty()) yearSlider.property('disabled', false);
      }

      function startPlayback() {
        if (isPlaying) return;
        // Start playback from the currently-selected year (slider/currentYear).
        // If currentYear isn't set or isn't in availableYears, fall back to 1960 or minYear.
        const startYear = (typeof currentYear !== 'undefined' && currentYear != null)
          ? currentYear
          : (availableYears.includes(1960) ? 1960 : minYear);
        currentYear = startYear;
        if (!yearSlider.empty()) {
          yearSlider.node().value = startYear;
          yearValueSpan.text(startYear);
          renderForYear(startYear);
          if (typeof plotPoints === 'function') plotPoints(startYear);
        }
        const years = availableYears && availableYears.length ? availableYears : [selectedYear];
        const total = years.length;
        const stepMs = Math.max(1, Math.round(6000 / total));
        let idx = years.indexOf(currentYear);
        if (idx === -1) idx = 0;
        isPlaying = true;
        if (!playBtn.empty()) playBtn.text('Pause ❚❚');
        if (!yearSlider.empty()) yearSlider.property('disabled', true);
        // advance after each interval
        playTimer = setInterval(() => {
          idx = idx + 1;
          if (idx >= years.length) {
            stopPlayback();
            return;
          }
          const y = years[idx];
          if (!yearSlider.empty()) yearSlider.node().value = y;
          yearValueSpan.text(y);
          renderForYear(y);
          if (typeof plotPoints === 'function') plotPoints(y);
        }, stepMs);
      }

      if (!playBtn.empty()) {
        playBtn.on('click', () => {
          if (isPlaying) stopPlayback(); else startPlayback();
        });
      }

      // now that playback state variables are declared, render initial points
      if (typeof plotPoints === 'function') plotPoints(selectedYear);

      // --- plot event points filtered by year ---
      // Convert the previous immediate-draw into a reusable function that
      // accepts a year and draws only points whose parsed year matches it.
      function plotPoints(selected) {
        if (!rawData || !rawData.length) return;
        const filterYear = (selected != null) ? +selected : +currentYear;

        // normalize coordinates and parse numeric year once
        const allPoints = rawData.map((d, i) => {
          const lon = parseFloat(d.longitude ?? d.Longitude ?? d.lon ?? d.Long ?? d.LONG);
          const lat = parseFloat(d.latitude ?? d.Latitude ?? d.lat ?? d.Lat ?? d.LAT);
          const yr = parseInt(d.year ?? d.Year ?? d.YEAR ?? d['Year'] ?? '', 10);
          if (!isFinite(lon) || !isFinite(lat)) return null;
          return { ...d, lon, lat, year: isFinite(yr) ? yr : null, __idx: i };
        }).filter(Boolean);

        // If playback is active, include the selected year plus previous years
        // with fading; otherwise (user-selected year) show only that year's events.
        const playMode = (typeof isPlaying !== 'undefined' && isPlaying) || false;
        const decay = 0.2; // 20% per year
        const maxAge = 5; // keep ages 0..4 when playing
        let points;
        if (playMode) {
          points = allPoints.filter(p => {
            if (p.year == null) return false;
            const age = filterYear - p.year;
            return age >= 0 && age < maxAge; // keep ages 0..(maxAge-1)
          });
        } else {
          // non-play mode: show only exact-year events
          points = allPoints.filter(p => p.year === filterYear);
        }

        // Apply swatch toggles: if a swatch is toggled (data-toggled==='1'),
        // exclude points of that disaster type. This implements the requested
        // behavior: when the Storm swatch is toggled off, storm markers are not rendered.
        // read disabled flags from the persisted swatchState (set by the legend click handler)
        const disabled = {
          storm: (swatchState.storm === 1),
          drought: (swatchState.drought === 1),
          flood: (swatchState.flood === 1),
          landslide: (swatchState.landslide === 1),
          earthquake: (swatchState.earthquake === 1),
          temperature: (swatchState.temperature === 1),
          volcano: (swatchState.volcano === 1),
          massmovement: (swatchState.massmovement === 1),
          other: (swatchState.other === 1)
        };

        points = points.filter(p => {
          const raw = (p.disastertype ?? p.disaster_type ?? p.disasterType ?? '').toString().toLowerCase();
          // mass movement detection
          if (disabled.massmovement && (raw.includes('mass movement') || raw.includes('mass-movement') || raw.includes('massmovement') || (raw.includes('mass') && raw.includes('movement')))) return false;
          if (disabled.landslide && raw.includes('landslide')) return false;
          if (disabled.earthquake && (raw.includes('earthquake') || raw.includes('quake'))) return false;
          if (disabled.drought && raw.includes('drought')) return false;
          if (disabled.flood && raw.includes('flood')) return false;
          if (disabled.storm && raw.includes('storm')) return false;
          if (disabled.temperature && (raw.includes('temperature') || raw.includes('heat'))) return false;
          if (disabled.volcano && (raw.includes('volcan') || raw.includes('volcano'))) return false;
          // other/unknown: if disabled and no other keyword matched, exclude
          const matchedAny = /storm|drought|flood|landslide|earthquake|quake|volcan|volcano|temperature|heat|mass/.test(raw);
          if (disabled.other && !matchedAny) return false;
          return true;
        });

        // ensure a points layer exists
        let pointsLayer = g.select('g.points-layer');
        if (pointsLayer.empty()) pointsLayer = g.append('g').attr('class', 'points-layer');

        // color mapping for disaster types (case-insensitive)
        const defaultColor = '#d62728'; // red fallback
        function disasterColor(d) {
          const raw = (d.disastertype ?? d.disaster_type ?? d.disasterType ?? '').toString().toLowerCase().trim();
          if (!raw) return defaultColor;
          if (raw.includes('storm')) return '#6a0dad'; // purple
          if (raw.includes('drought')) return '#d99058'; // light brown/orange
          if (raw.includes('flood')) return '#1f78b4'; // blue
          if (raw.includes('landslide')) return '#8b5a2b'; // medium brown
          if (raw.includes('earthquake') || raw.includes('quake')) return '#8b4513'; // brown
          // severe temperature / heat
          if (raw.includes('temperature') || raw.includes('heat')) return '#ffd700'; // also catch variants
          // volcanic activity (and variants)
          if (raw.includes('volcan') || raw.includes('volcano')) return '#ff8c00'; // dark orange
          // mass movement (and common variants) -> light blue
          if (raw.includes('mass movement') || raw.includes('mass-movement') || raw.includes('massmovement') || (raw.includes('mass') && raw.includes('movement'))) return '#6ec6ff';
          return defaultColor;
        }

        // bind and draw circles keyed by stable id or internal index
        const circles = pointsLayer.selectAll('circle.event-dot')
          .data(points, (d) => d.id ?? d.iso3 ?? d.__idx);

        circles.join(
          enter => enter.append('circle')
            .attr('class', 'event-dot')
            .attr('r', 3)
            .attr('fill', d => disasterColor(d))
            .attr('stroke', '#fff')
            .attr('stroke-width', 0)
            .attr('pointer-events', 'auto')
            .attr('cx', d => {
              const p = projection([d.lon, d.lat]);
              return p ? p[0] : -9999;
            })
            .attr('cy', d => {
              const p = projection([d.lon, d.lat]);
              return p ? p[1] : -9999;
            })
            .attr('fill-opacity', d => {
              const age = filterYear - d.year;
              const op = Math.max(0, Math.min(1, 1 - age * decay));
              return op;
            })
            .on('mouseover', function (event, d) {
              const yr = d.year ?? 'N/A';
              const geo = d.geolocation ?? d.Geolocation ?? d.location ?? 'Unknown location';
              const dtype = d.disastertype ?? d.disaster_type ?? d.disasterType ?? 'Unknown';
              tip.style('display', 'block')
                .html(`<strong>${dtype}</strong><br>Year: ${yr}<br>Location: ${geo}<br>Coords: ${d.lat.toFixed(3)}, ${d.lon.toFixed(3)}`);
            })
            .on('mousemove', function (event) {
              tip.style('left', (event.pageX + 12) + 'px')
                .style('top', (event.pageY + 12) + 'px');
            })
            .on('mouseout', function () {
              tip.style('display', 'none');
            }),
          update => update
            .attr('cx', d => {
              const p = projection([d.lon, d.lat]);
              return p ? p[0] : -9999;
            })
            .attr('cy', d => {
              const p = projection([d.lon, d.lat]);
              return p ? p[1] : -9999;
            })
            .attr('fill', d => disasterColor(d))
            .attr('fill-opacity', d => {
              const age = filterYear - d.year;
              const op = Math.max(0, Math.min(1, 1 - age * decay));
              return op;
            })
            .on('mouseover', function (event, d) {
              const yr = d.year ?? 'N/A';
              const geo = d.geolocation ?? d.Geolocation ?? d.location ?? 'Unknown location';
              const dtype = d.disastertype ?? d.disaster_type ?? d.disasterType ?? 'Unknown';
              tip.style('display', 'block')
                .html(`<strong>${dtype}</strong><br>Year: ${yr}<br>Location: ${geo}<br>Coords: ${d.lat.toFixed(3)}, ${d.lon.toFixed(3)}`);
            })
            .on('mousemove', function (event) {
              tip.style('left', (event.pageX + 12) + 'px')
                .style('top', (event.pageY + 12) + 'px');
            })
            .on('mouseout', function () {
              tip.style('display', 'none');
            }),
          exit => exit.remove()
        );
      }






      // zoom — allow dragging only when zoomed in and clamp the transform so the
      // content never leaves the SVG viewport. Wheel/dblclick/touch still zoom.
      const minK = 1;
      const maxK = 8;

      function clampTransform(t) {
        const k = t.k;
        // allowed translation range so content covers the viewport
        const minX = Math.min(0, width - width * k);
        const maxX = 0;
        const minY = Math.min(0, height - height * k);
        const maxY = 0;
        const x = Math.max(minX, Math.min(maxX, t.x));
        const y = Math.max(minY, Math.min(maxY, t.y));
        return { x, y, k };
      }

      const zoom = d3.zoom()
        .scaleExtent([minK, maxK])
        .filter(event => {
          // allow wheel, double-click, and touch gestures always
          if (event.type === 'wheel' || event.type === 'dblclick' || event.type === 'touchstart') return true;
          // allow pointer/mouse dragging only when currently zoomed in (k > 1)
          const t = d3.zoomTransform(svg.node());
          if (t.k > 1) {
            // accept pointer/mouse events so drag panning can occur
            return event.type.startsWith('mouse') || event.type.startsWith('pointer') || event.type.startsWith('touch');
          }
          // otherwise, disallow drag/pan
          return false;
        })
        .on('zoom', (event) => {
          // Clamp the transform so the map content always covers the SVG viewport.
          const t = event.transform;
          const c = clampTransform(t);
          g.attr('transform', `translate(${c.x},${c.y}) scale(${c.k})`);
        });

      svg.call(zoom);

    console.log('World map drawn');
  } catch (err) {
    console.error('Failed to load or draw world GeoJSON:', err);
    container.append('div').text('Failed to load map data. See console for details.');
  }
}

drawMap();


