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

svg.style('border', '1px solid #ccc')
   .style('border-radius', '4px');