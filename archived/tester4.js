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

// extra blank space (in screen pixels) allowed inside the SVG viewport
// This padding gives the map room to translate so arc animations that
// target countries near the SVG edge can complete without being clipped.
const VIEW_PADDING = 200;

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

  // Base marker radius in screen pixels. Used to keep marker visual size
  // constant regardless of d3.zoom scale (we set circle r = BASE_MARKER_RADIUS / k).
  const BASE_MARKER_RADIUS = 3;

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
      .on('click', function (event, d) {
        // Animate (or instant) zoom to any clicked country. We remember the
        // last clicked feature for the reset animation. Respect the user's
        // prefers-reduced-motion setting and fall back to instant zoom when set.
        try {
          lastClickedFeature = d;
          const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
          if (prefersReduced) {
            zoomToFeature(d);
          } else {
            animateZoomToFeature(d, 2000, 3);
          }
        } catch (e) {
          console.warn('zoom-to-feature failed:', e && e.message);
        }
      })
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

  // helpers to manage a temporary red highlight on a country path.
  // We save the current fill into a `data-prev-fill` attribute so we
  // can restore it later when the highlight is cleared.
  function clearCountryHighlight() {
    countryPaths.each(function () {
      const el = d3.select(this);
      const prev = el.attr('data-prev-fill');
      if (prev) {
        el.attr('fill', prev);
        el.attr('data-prev-fill', null);
      }
    });
  }

  function highlightCountry(f) {
    if (!f) return;
    // clear existing highlight first
    clearCountryHighlight();
    // find the DOM path corresponding to the feature and save/override fill
    const sel = countryPaths.filter(d => d === f);
    sel.each(function () {
      const el = d3.select(this);
      el.attr('data-prev-fill', el.attr('fill'));
      el.attr('fill', '#d62728');
    });
  }

  // last clicked feature (used by reset animation)
  let lastClickedFeature = null;

  // Helper: detect if a GeoJSON feature is in (or roughly belongs to) North America.
      // This tries properties first, then falls back to a geographic bbox on the
      // feature centroid so it still works with GeoJSON that lacks a continent field.
      function isNorthAmericaFeature(f) {
        if (!f || !f.properties) return false;
        const p = f.properties || {};
        const kont = (p.continent || p.CONTINENT || p.cont || p.region || p.REGION || '') + '';
        if (kont.toLowerCase().includes('north') && kont.toLowerCase().includes('america')) return true;
        const sub = (p.subregion || p.SUBREGION || p.sub || '') + '';
        const region = (p.region_un || p.REGION_UN || p.region || p.REGION || '') + '';
        if (sub.toLowerCase().includes('northern') && (region.toLowerCase().includes('america') || region.toLowerCase().includes('americas'))) return true;

        // Fallback: check geographic centroid lon/lat against a rough North America bbox.
        // Rough bounds: longitudes approx -170 .. -20, latitudes approx 5 .. 83
        try {
          const c = d3.geoCentroid(f);
          if (!c || !isFinite(c[0]) || !isFinite(c[1])) return false;
          const lon = c[0];
          const lat = c[1];
          if (lon >= -170 && lon <= -20 && lat >= 5 && lat <= 83) return true;
        } catch (e) {
          return false;
        }
        return false;
      }

      // Helper: instantly set the zoom transform so the given feature's centroid
      // is centered in the viewport at a chosen scale. No animation/transition.
      function zoomToFeature(f, targetK = 3) {
        // Determine screen centroid (projection -> pixel coords used by path)
        const c = path.centroid(f);
        if (!c || !isFinite(c[0]) || !isFinite(c[1])) return;
        const cx = c[0];
        const cy = c[1];
        // Compute translate so centroid lands in the center of the SVG
        let tx = (width / 2) - targetK * cx;
        let ty = (height / 2) - targetK * cy;
        // Clamp transform so map remains covering viewport
        const clamped = clampTransform({ x: tx, y: ty, k: targetK });
        // Apply transform immediately (no transition)
        svg.call(zoom.transform, d3.zoomIdentity.translate(clamped.x, clamped.y).scale(clamped.k));
      }

      // Animated zoom: draw a bottom semicircular arc from SVG center to the
      // feature centroid and move the map along that arc over `duration` ms.
      // The animation follows the bottom side of a circle connecting the two
      // points. Uses requestAnimationFrame for a smooth 60fps update and a
      // cubic ease-in-out. If the path is degenerate, falls back to instant zoom.
      function animateZoomToFeature(f, duration = 2000, targetK = 3) {
        const curT = d3.zoomTransform(svg.node());
        // start point = center of SVG in screen coords
        const sx = width / 2;
        const sy = height / 2;
        // feature centroid in map coordinates
        const cent = path.centroid(f);
        if (!cent || !isFinite(cent[0]) || !isFinite(cent[1])) {
          zoomToFeature(f, targetK);
          return;
        }
        // convert feature centroid to screen coords under current transform
        const fx = curT.x + curT.k * cent[0];
        const fy = curT.y + curT.k * cent[1];
        const dx = fx - sx;
        const dy = fy - sy;
        const dlen = Math.hypot(dx, dy);
        if (dlen < 0.5) {
          zoomToFeature(f, targetK);
          return;
        }

        // Build a cubic Bezier between center and destination. For features
        // near the left/right edges (first/last 10% of width) use a straight
        // line (collinear control points); otherwise build a bulging curve
        // whose direction (up/down) is chosen based on the feature bbox.
        const p0 = { x: sx, y: sy };
        const p3 = { x: fx, y: fy };
        let c1, c2;
          // 10%-edge behavior removed per request; always use the standard
          // bulging semicircle animation behavior.
          const nearEdge = false;
        if (nearEdge) {
          // collinear control points produce an (effectively) straight line
          c1 = { x: sx + dx * 0.33, y: sy + dy * 0.33 };
          c2 = { x: sx + dx * 0.66, y: sy + dy * 0.66 };
        } else {
          // perpendicular vector to chord (in screen coords)
          let perp = { x: -dy, y: dx };
          const toScreen = (p) => ({ x: curT.x + curT.k * p[0], y: curT.y + curT.k * p[1] });
          let wantPerpPositive;
          try {
            const b = path.bounds(f); // [[x0,y0],[x1,y1]] in projection/map coords
            const topS = toScreen([b[0][0], b[0][1]]).y;
            const bottomS = toScreen([b[1][0], b[1][1]]).y;
            // if bottom is in bottom half, we want an upward bulge (so wantPerpPositive=false)
            wantPerpPositive = (bottomS <= (height / 2));
          } catch (e) {
            // fallback to using centroid screen y
            wantPerpPositive = (fy <= (height / 2));
          }
          if (wantPerpPositive) {
            if (perp.y < 0) { perp.x *= -1; perp.y *= -1; }
          } else {
            if (perp.y > 0) { perp.x *= -1; perp.y *= -1; }
          }
          const plen = Math.hypot(perp.x, perp.y) || 1;
          perp.x /= plen; perp.y /= plen;
          // control point offset proportional to distance
          const offset = Math.min(0.9 * dlen, dlen * 0.6);
          const mid = { x: (sx + fx) / 2, y: (sy + fy) / 2 };
          c1 = { x: mid.x - dx * 0.25 + perp.x * offset, y: mid.y - dy * 0.25 + perp.y * offset };
          c2 = { x: mid.x + dx * 0.25 + perp.x * offset, y: mid.y + dy * 0.25 + perp.y * offset };
        }

        // append overlay path to svg (not inside g so it doesn't get transformed)
        const overlay = svg.append('g').attr('class', 'zoom-overlay');
        const curve = overlay.append('path')
          .attr('d', `M ${p0.x},${p0.y} C ${c1.x},${c1.y} ${c2.x},${c2.y} ${p3.x},${p3.y}`)
          .attr('fill', 'none')
          .attr('stroke', '#333')
          .attr('stroke-width', 2)
          .attr('stroke-linecap', 'round')
          .attr('stroke-linejoin', 'round')
          .attr('opacity', 0.95);

        // animate stroke drawing using stroke-dasharray
        const totalLen = curve.node().getTotalLength();
        curve.attr('stroke-dasharray', totalLen + ' ' + totalLen).attr('stroke-dashoffset', totalLen);
  // ensure overlay stroke draws for the full animation duration
  curve.transition().duration(duration).ease(d3.easeCubicOut).attr('stroke-dashoffset', 0);

        // Schedule highlight fade sequence:
        // - start fading in the red highlight 0.5s before the zoom animation ends
        // - keep fully red for 1s after the zoom ends
        // - fade out over 0.5s and then restore the original fill
  const HIGHLIGHT_FADEOUT_MS = 500;
  const FLASH_MS = 300; // bright orange flash duration after animation ends
    // start the flash exactly when the animation ends (no prior red fade)
    const fadeInDelay = Math.max(0, duration);
        let highlightTimers = [];
        // helper to start the color-transition sequence for the clicked country
        // (transition fill from its current value -> red -> back to original)
        function startHighlightFadeSequence(feature) {
          try {
            const sel = countryPaths.filter(d => d === feature);
            if (sel.empty()) return;
            // save previous fill on each matched element so we can restore later
            sel.each(function () {
              const el = d3.select(this);
              const prevFill = el.attr('fill') || '';
              el.attr('data-prev-fill', prevFill);
            });

            // start orange flash immediately (at animation end)
            const tOrange = setTimeout(() => {
              try {
                const selO = countryPaths.filter(d => d === feature);
                selO.each(function () {
                  const el = d3.select(this);
                  // immediately set to bright orange for the flash (no transition)
                  el.attr('fill', '#ff7f0e'); // D3 category10 orange (bright)
                });
              } catch (e) { /* non-fatal */ }
            }, 0);
            highlightTimers.push(tOrange);

            // after orange flash duration, transition back to saved fill
            const tBack = setTimeout(() => {
              try {
                const sel2 = countryPaths.filter(d => d === feature);
                sel2.each(function () {
                  const el = d3.select(this);
                  const prev = el.attr('data-prev-fill') || '';
                  // transition back to previous fill color
                  el.transition().duration(HIGHLIGHT_FADEOUT_MS).attr('fill', prev).on('end', function () {
                    // cleanup saved attribute when done
                    d3.select(this).attr('data-prev-fill', null);
                  });
                });
              } catch (e) { /* non-fatal */ }
            }, FLASH_MS);
            highlightTimers.push(tBack);
          } catch (e) {
            // non-fatal
          }
        }
        const fadeInTimer = setTimeout(() => startHighlightFadeSequence(f), fadeInDelay);
        highlightTimers.push(fadeInTimer);

        // cubic Bezier evaluator
        function cubicAt(t, p0, p1, p2, p3) {
          const u = 1 - t;
          const tt = t * t;
          const uu = u * u;
          const uuu = uu * u;
          const ttt = tt * t;
          return {
            x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
            y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y
          };
        }

        const ease = d3.easeCubicInOut;
        const startK = curT.k;
        const startTime = performance.now();
  // For near-edge straight-line animations we previously froze the
  // view after 1s. Per user request, expand that view interval to 2s
  // and slow the view-frame so it progresses only half as far over
  // that interval (half the velocity) while the overlay still runs
  // for the full `duration` (keeps total animation visually 2s).
  const freezeMs = 2000;
        let frozenClamped = null;

        let rafId = null;
        function step(now) {
          const elapsed = now - startTime;
          const t = Math.max(0, Math.min(1, elapsed / duration));
          const et = ease(t);
          // point along curve in screen coords used for overlay (full-duration)
          const ptOverlay = cubicAt(et, p0, c1, c2, p3);
          // For near-edge straight-line animations we animate the view-frame
          // only during the first `freezeMs` interval; the overlay continues
          // for the full `duration`. Compute separate eased parameters for
          // view vs overlay.
          const viewDuration = nearEdge ? Math.min(freezeMs, duration) : duration;
          const tv = Math.max(0, Math.min(1, elapsed / viewDuration));
          // Base eased progress for view-frame
          let ev = ease(tv);
          // For near-edge case, slow view progress to half the distance
          // over the viewDuration (i.e. half the velocity). Overlay still
          // uses full eased progress (et) across `duration`.
          if (nearEdge) ev *= 0.5;

          // point for view-frame (may be frozen after viewDuration)
          const ptView = nearEdge ? cubicAt(ev, p0, c1, c2, p3) : ptOverlay;
          const kView = startK + (targetK - startK) * (nearEdge ? ev : et);
          // translate so ptView becomes centered
          let tx = (width / 2) - kView * ( (ptView.x - curT.x) / curT.k );
          let ty = (height / 2) - kView * ( (ptView.y - curT.y) / curT.k );
          const clamped = clampTransform({ x: tx, y: ty, k: kView });

          if (nearEdge && elapsed >= viewDuration) {
            if (!frozenClamped) frozenClamped = clamped;
            svg.call(zoom.transform, d3.zoomIdentity.translate(frozenClamped.x, frozenClamped.y).scale(frozenClamped.k));
          } else {
            svg.call(zoom.transform, d3.zoomIdentity.translate(clamped.x, clamped.y).scale(clamped.k));
          }

          if (elapsed < duration) {
            rafId = requestAnimationFrame(step);
          } else {
            // tidy up overlay after a short delay so stroke animation can finish
            window.setTimeout(() => {
              overlay.remove();
              // highlight is managed by the scheduled fade sequence; do not
              // set it here to avoid duplicate timing.
            }, 300);
            rafId = null;
          }
        }

        rafId = requestAnimationFrame(step);
        // return a cancel function in case caller wants to stop it
        return () => {
          try { if (rafId) cancelAnimationFrame(rafId); } catch (e) {}
          try { overlay.remove(); } catch (e) {}
          // clear any scheduled highlight timers
          try {
            highlightTimers.forEach(t => clearTimeout(t));
            if (typeof fadeInTimer !== 'undefined') clearTimeout(fadeInTimer);
          } catch (e) {}
          // interrupt any running transitions and restore saved fills
          try {
            countryPaths.interrupt();
            countryPaths.each(function () {
              const el = d3.select(this);
              const prev = el.attr('data-prev-fill');
              if (prev) el.attr('fill', prev);
              el.attr('data-prev-fill', null);
            });
          } catch (e) {}
        };
      }

      // Animate reset in reverse: map the semicircle from the unzoomed map
      // (center -> feature centroid in map coordinates) and then animate the
      // zoom transform from the current transform back to the identity while
      // following the bottom side of that semicircle in reverse.
      function animateResetToGlobal(f, duration = 2000, targetK = 1) {
        const curT = d3.zoomTransform(svg.node());
        // map coords for unzoomed center and feature centroid
        const p0_map = [width / 2, height / 2];
        const p3_map = path.centroid(f);
        if (!p3_map || !isFinite(p3_map[0]) || !isFinite(p3_map[1])) {
          // fallback to simple transition
          svg.transition().duration(600).call(zoom.transform, d3.zoomIdentity);
          return;
        }

        // build control points in map coordinates
        const dx = p3_map[0] - p0_map[0];
        const dy = p3_map[1] - p0_map[1];
        // helper: map map-coords to screen-coords using current transform
        const toScreen = (p) => ({ x: curT.x + curT.k * p[0], y: curT.y + curT.k * p[1] });
  // 10%-edge behaviour removed; always use the mapped semicircle
  // reverse animation when resetting.
  const p3s_test = toScreen(p3_map);
  const nearEdge = false;
        let c1_map, c2_map;
        if (nearEdge) {
          // collinear control points in map coords -> straight-line animation
          c1_map = { x: p0_map[0] + dx * 0.33, y: p0_map[1] + dy * 0.33 };
          c2_map = { x: p0_map[0] + dx * 0.66, y: p0_map[1] + dy * 0.66 };
        } else {
          let perp = { x: -dy, y: dx };
          let wantPerpPositive;
          try {
            const b = path.bounds(f); // [[x0,y0],[x1,y1]] in projection coords
            const topS = toScreen([b[0][0], b[0][1]]).y;
            const bottomS = toScreen([b[1][0], b[1][1]]).y;
            wantPerpPositive = (bottomS <= (height / 2));
          } catch (e) {
            const p3s_fallback = toScreen(p3_map);
            wantPerpPositive = (p3s_fallback.y <= (height / 2));
          }
          if (wantPerpPositive) {
            if (perp.y < 0) { perp.x *= -1; perp.y *= -1; }
          } else {
            if (perp.y > 0) { perp.x *= -1; perp.y *= -1; }
          }
          const plen = Math.hypot(perp.x, perp.y) || 1;
          perp.x /= plen; perp.y /= plen;
          const dlen = Math.hypot(dx, dy) || 1;
          const offset = Math.min(0.9 * dlen, dlen * 0.6);
          const mid = { x: (p0_map[0] + p3_map[0]) / 2, y: (p0_map[1] + p3_map[1]) / 2 };
          c1_map = { x: mid.x - dx * 0.25 + perp.x * offset, y: mid.y - dy * 0.25 + perp.y * offset };
          c2_map = { x: mid.x + dx * 0.25 + perp.x * offset, y: mid.y + dy * 0.25 + perp.y * offset };
        }

  // overlay drawn in screen coords (use current transform to map map-coords)
        let p0s = toScreen(p0_map);
        let c1s = toScreen([c1_map.x, c1_map.y]);
        let c2s = toScreen([c2_map.x, c2_map.y]);
        let p3s = toScreen(p3_map);

        // If near-edge, override and draw a straight screen-space line from
        // the country (current screen pos) to the global center. Use
        // collinear control points so the path is effectively straight.
        if (nearEdge) {
          // start at country screen position
          p0s = toScreen(p3_map);
          // end at SVG center in screen coords
          p3s = { x: width / 2, y: height / 2 };
          c1s = { x: p0s.x + (p3s.x - p0s.x) * 0.33, y: p0s.y + (p3s.y - p0s.y) * 0.33 };
          c2s = { x: p0s.x + (p3s.x - p0s.x) * 0.66, y: p0s.y + (p3s.y - p0s.y) * 0.66 };
        }

        const overlay = svg.append('g').attr('class', 'zoom-overlay');
        const curve = overlay.append('path')
          .attr('d', `M ${p0s.x},${p0s.y} C ${c1s.x},${c1s.y} ${c2s.x},${c2s.y} ${p3s.x},${p3s.y}`)
          .attr('fill', 'none')
          .attr('stroke', '#333')
          .attr('stroke-width', 2)
          .attr('stroke-linecap', 'round')
          .attr('stroke-linejoin', 'round')
          .attr('opacity', 0.95);

        const totalLen = curve.node().getTotalLength();
        curve.attr('stroke-dasharray', totalLen + ' ' + totalLen).attr('stroke-dashoffset', totalLen);
  // ensure overlay stroke draws for the full animation duration
  curve.transition().duration(duration).ease(d3.easeCubicOut).attr('stroke-dashoffset', 0);

        function cubicAtMap(t, p0, p1, p2, p3) {
          const u = 1 - t;
          const tt = t * t;
          const uu = u * u;
          const uuu = uu * u;
          const ttt = tt * t;
          return {
            x: uuu * p0[0] + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3[0],
            y: uuu * p0[1] + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3[1]
          };
        }

        // cubic evaluator for screen-space points (objects with x,y)
        function cubicAtScreen(t, p0, p1, p2, p3) {
          const u = 1 - t;
          const tt = t * t;
          const uu = u * u;
          const uuu = uu * u;
          const ttt = tt * t;
          return {
            x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
            y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y
          };
        }

  const ease = d3.easeCubicInOut;
  const startK = curT.k;
  const startTime = performance.now();
  // expand the view interval and slow the view progress (half velocity)
  const freezeMs = 2000;
        let frozenClamped = null;

        let rafId = null;
        function step(now) {
          const elapsed = now - startTime;
          const t = Math.max(0, Math.min(1, elapsed / duration));
          const et = ease(t);
          // evaluate overlay point. For near-edge we use the straight
          // screen-space curve (p0s->p3s); otherwise evaluate the mapped
          // unzoomed semicircle in map coordinates and map to screen.
          let pt_map_overlay = null;
          let pt_screen_overlay = null;
          if (nearEdge) {
            pt_screen_overlay = cubicAtScreen(1 - et, p0s, c1s, c2s, p3s);
          } else {
            pt_map_overlay = cubicAtMap(1 - et, p0_map, c1_map, c2_map, p3_map); // reverse path (map coords)
          }
          // For near-edge resets, animate the view-frame only during the
          // first freezeMs; overlay follows full duration. Compute separate
          // eased parameters.
          const viewDuration = nearEdge ? Math.min(freezeMs, duration) : duration;
          const tv = Math.max(0, Math.min(1, elapsed / viewDuration));
          let ev = ease(tv);
          if (nearEdge) ev *= 0.5;

          // compute view-point. For near-edge use screen-space path and map
          // it into the transform equation; otherwise use map-space pt.
          let kView = startK + (targetK - startK) * (nearEdge ? ev : et);
          let tx, ty;
          if (nearEdge) {
            // To avoid bias when unzooming from edge countries, interpolate
            // the transform parameters directly toward the identity transform
            // (k=1, x=0, y=0). This reliably returns the map to the global
            // centered view without depending on screen->map projections
            // that can produce side-biased results.
            const tInv = ev; // ev already respects the half-velocity scaling
            const interpX = curT.x + (0 - curT.x) * tInv;
            const interpY = curT.y + (0 - curT.y) * tInv;
            const interpK = startK + (targetK - startK) * tInv;
            // compute clamped values so we don't slip off-canvas
            const clampedInterp = clampTransform({ x: interpX, y: interpY, k: interpK });
            tx = clampedInterp.x;
            ty = clampedInterp.y;
            kView = clampedInterp.k;
          } else {
            const pt_map_view = pt_map_overlay; // already in map coords for non-nearEdge
            tx = (width / 2) - kView * pt_map_view.x;
            ty = (height / 2) - kView * pt_map_view.y;
          }
          const clamped = clampTransform({ x: tx, y: ty, k: kView });
          if (nearEdge && elapsed >= viewDuration) {
            if (!frozenClamped) frozenClamped = clamped;
            svg.call(zoom.transform, d3.zoomIdentity.translate(frozenClamped.x, frozenClamped.y).scale(frozenClamped.k));
          } else {
            svg.call(zoom.transform, d3.zoomIdentity.translate(clamped.x, clamped.y).scale(clamped.k));
          }

          if (elapsed < duration) {
            rafId = requestAnimationFrame(step);
          } else {
            window.setTimeout(() => {
              overlay.remove();
              // clearing any highlight because we're returning to global view
              try { clearCountryHighlight(); } catch (e) { /* non-fatal */ }
            }, 300);
            rafId = null;
          }
        }

        rafId = requestAnimationFrame(step);
        return () => { if (rafId) cancelAnimationFrame(rafId); overlay.remove(); };
      }

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

  // current zoom scale so we can set a radius that visually remains
  // constant on-screen regardless of the group's scale. Use square-root
  // scaling so radius decreases proportional to sqrt(k) rather than a
  // full linear factor. This provides a gentler reduction when zooming.
  const curK = d3.zoomTransform(svg.node()).k || 1;

        circles.join(
          enter => enter.append('circle')
            .attr('class', 'event-dot')
            // store a logical base radius (screen pixels) and set the actual
            // SVG radius inversely to the current zoom so the on-screen size
            // remains the BASE_MARKER_RADIUS
            .attr('data-base-r', BASE_MARKER_RADIUS)
            .attr('r', BASE_MARKER_RADIUS / Math.sqrt(curK))
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
              // try common country field names in the CSV rows
              const countryName = (d.country || d.Country || d.country_name || d.CountryName || d['country_name'] || d['Country'] || d['country']) ?? 'Unknown';
              tip.style('display', 'block')
                .html(`<strong>${dtype}</strong><br>Year: ${yr}<br>Country: ${countryName}<br>Location: ${geo}<br>Coords: ${d.lat.toFixed(3)}, ${d.lon.toFixed(3)}`);
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
            // update radius to compensate for current zoom so marker remains
            // visually constant in screen space
            .attr('r', BASE_MARKER_RADIUS / Math.sqrt(curK))
            .on('mouseover', function (event, d) {
              const yr = d.year ?? 'N/A';
              const geo = d.geolocation ?? d.Geolocation ?? d.location ?? 'Unknown location';
              const dtype = d.disastertype ?? d.disaster_type ?? d.disasterType ?? 'Unknown';
              const countryName = (d.country || d.Country || d.country_name || d.CountryName || d['country_name'] || d['Country'] || d['country']) ?? 'Unknown';
              tip.style('display', 'block')
                .html(`<strong>${dtype}</strong><br>Year: ${yr}<br>Country: ${countryName}<br>Location: ${geo}<br>Coords: ${d.lat.toFixed(3)}, ${d.lon.toFixed(3)}`);
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
        // Allow an extra VIEW_PADDING margin on all sides so the map can
        // be translated further and reveal blank space inside the SVG.
        const minX = Math.min(0, width - width * k) - VIEW_PADDING;
        const maxX = VIEW_PADDING;
        const minY = Math.min(0, height - height * k) - VIEW_PADDING;
        const maxY = VIEW_PADDING;
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

          // Adjust event marker radii so their on-screen size remains
          // constant regardless of the group's scale. Circles are children of
          // `g`, so they are affected by the group's scale; to compensate,
          // set each circle's `r` to BASE_MARKER_RADIUS / currentScale.
          try {
            const currentK = c.k || 1;
            // apply sqrt scaling when updating during zoom
            g.selectAll('circle.event-dot').attr('r', BASE_MARKER_RADIUS / Math.sqrt(currentK));
          } catch (e) {
            // non-fatal: if svg isn't ready or selection fails, skip
          }
        });

      svg.call(zoom);

      // Add a simple zoom-reset control under the SVG.
      // We place the control in the same container that holds the SVG; if
      // the `#map` element itself is the SVG, we append the control to the
      // SVG's parent so the button can be rendered in HTML/CSS.
      try {
        const mapContainerEl = container.node();
        const controlsParent = (mapContainerEl && mapContainerEl.nodeName && mapContainerEl.nodeName.toLowerCase() === 'svg')
          ? d3.select(mapContainerEl.parentNode)
          : container;

        let controls = controlsParent.select('.map-controls');
        if (controls.empty()) {
          controls = controlsParent.append('div')
            .attr('class', 'map-controls')
            .style('display', 'flex')
            .style('justify-content', 'center')
            .style('margin-top', '8px');
        }

        // create or reuse the reset button
        let resetBtn = controls.select('#zoom-reset-btn');
        if (resetBtn.empty()) {
          resetBtn = controls.append('button')
            .attr('id', 'zoom-reset-btn')
            .attr('type', 'button')
            .attr('aria-label', 'Reset zoom to global view')
            .style('padding', '6px 10px')
            .style('border-radius', '4px')
            .style('border', '1px solid #bbb')
            .style('background', '#fff')
            .style('cursor', 'pointer')
            .style('font-size', '13px')
            .text('Reset Zoom ⤺');

          resetBtn.on('click', () => {
            const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            const identity = d3.zoomIdentity;
            if (prefersReduced) {
              svg.call(zoom.transform, identity);
            } else {
                // if we have a last-clicked country, animate the reset following
                // the bottom-side semicircle mapped from the unzoomed map to the
                // current country (reverse of the zoom-in). Otherwise, do a
                // simple animated reset.
                if (lastClickedFeature) {
                  // animate reset over 2000ms following reverse path
                  animateResetToGlobal(lastClickedFeature, 2000, 1);
                } else {
                  // animate reset transform over 600ms as fallback
                  svg.transition().duration(600).call(zoom.transform, identity);
                }
            }
          });
        }
      } catch (e) {
        // non-fatal: controls are UX nicety; log for debugging
        console.warn('failed to create zoom controls:', e && e.message);
      }

    console.log('World map drawn');
  } catch (err) {
    console.error('Failed to load or draw world GeoJSON:', err);
    container.append('div').text('Failed to load map data. See console for details.');
  }
}

drawMap();


