
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

// japan_map.js
// Simple D3 map renderer for Japan prefectures.
// - Loads ./data/japan_prefectures.geojson if present, otherwise falls back
//   to a public URL (user may replace with a local copy for reliability).
// - Renders prefecture polygons, prefecture borders, hover tooltip, and
//   a click-to-zoom-to-prefecture behavior with an animated fit (respects
//   prefers-reduced-motion).

async function renderJapanMap(opts = {}) {
  const containerSelector = opts.selector || '#map'; // default to #map
  const container = d3.select(containerSelector);
  if (container.empty()) {
    // If the requested container is missing, append to body and warn.
    console.warn(`Container ${containerSelector} not found; appending map to <body>`);
  }

  const width = opts.width || 900;
  const height = opts.height || 700;

  // If the container is already an <svg> (e.g. <svg id="map"> in index.html),
  // reuse it. Otherwise append a new SVG into the container element.
  let svg;
  if (container.node() && container.node().nodeName && container.node().nodeName.toLowerCase() === 'svg') {
    svg = container;
    svg.attr('viewBox', `0 0 ${width} ${height}`)
      .attr('preserveAspectRatio', 'xMidYMid')
      .attr('role', 'img')
      .attr('aria-label', 'Map of Japan (prefectures)')
      .style('width', opts.responsive === false ? `${width}px` : '100%')
      .style('height', opts.responsive === false ? `${height}px` : 'auto')
      .style('border', '1px solid #ccc')
      .style('border-radius', '4px');
  } else {
    svg = (container.empty() ? d3.select('body') : container).append('svg')
      .attr('viewBox', `0 0 ${width} ${height}`)
      .attr('preserveAspectRatio', 'xMidYMid')
      .style('width', opts.responsive === false ? `${width}px` : '100%')
      .style('height', opts.responsive === false ? `${height}px` : 'auto')
      .attr('role', 'img')
      .attr('aria-label', 'Map of Japan (prefectures)')
      .style('border', '1px solid #ccc')
      .style('border-radius', '4px');
  }

  // Optionally crop the bottom portion by reducing the SVG viewBox height.
  // opts.clipBottomPercent (number 0-100) controls how much to cut off from bottom.
  const clipBottom = (typeof opts.clipBottomPercent === 'number') ? Math.max(0, Math.min(100, opts.clipBottomPercent)) : 10; // default 10%
  const visibleHeight = Math.max(0, Math.round(height * (1 - clipBottom / 100)));

  // Update the SVG viewBox so the container and its border match the cropped area.
  // We compute projection using the full original height so features keep positions,
  // then crop by shrinking the viewBox height — content below visibleHeight will be omitted.
  try {
    svg.attr('viewBox', `0 0 ${width} ${visibleHeight}`)
       .attr('preserveAspectRatio', 'xMidYMid meet')
       .style('aspect-ratio', `${width} / ${visibleHeight}`);
    // If clipping was applied, reduce the displayed width so the post-clipped image
    // doesn't appear too large. Use opts.postClipWidth (string, e.g. '75%') if provided,
    // otherwise default to 75% when clipping is active.
    const postClipWidth = (typeof opts.postClipWidth === 'string') ? opts.postClipWidth : (clipBottom > 0 ? '75%' : '100%');
    svg.style('width', opts.responsive === false ? `${width}px` : postClipWidth);
  } catch (e) {
    // If setting aspect-ratio via style fails, still set viewBox and preserveAspectRatio.
    svg.attr('viewBox', `0 0 ${width} ${visibleHeight}`).attr('preserveAspectRatio', 'xMidYMid meet');
  }

  const g = svg.append('g').attr('class', 'map-group');

  // Create the global map tooltip element (used only when a prefecture
  // contains at least one rendered disaster point).
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

  // Load Japan prefectures GeoJSON from the specified URL
  const japanPrefecturesUrl = 'https://raw.githubusercontent.com/dataofjapan/land/master/japan.geojson';
  
  let japanGeo = null;
  try {
    japanGeo = await d3.json(japanPrefecturesUrl);
    if (!japanGeo || !japanGeo.features || japanGeo.features.length === 0) {
      throw new Error('Japan prefectures GeoJSON is empty or invalid');
    }
    console.log(`Loaded Japan prefectures GeoJSON with ${japanGeo.features.length} prefectures`);
  } catch (err) {
    console.error('Failed to load Japan prefectures GeoJSON:', err);
    svg.append('text').attr('x', 20).attr('y', 40).text('Failed to load Japan GeoJSON. See console.');
    return;
  }

  // projection + path. Use fitSize to compute a scale that fits the features
  const projection = d3.geoMercator();
  const path = d3.geoPath().projection(projection);

  // fit the projection to the features
  try {
    projection.fitSize([width, height], japanGeo);
  } catch (e) {
    console.warn('fitSize failed, using default translate/scale', e.message);
    projection.scale(2000).center([138, 36.5]).translate([width / 2, height / 2]);
  }

  // draw prefectures
  const prefectures = g.selectAll('path.prefecture')
    .data(japanGeo.features)
    .join('path')
    .attr('class', 'prefecture')
    .attr('d', path)
    .attr('fill', '#f7f7f7')
    .attr('stroke', '#666')
    .attr('stroke-width', 0.6)
    .on('mouseover', function (event, d) {
      d3.select(this).attr('fill', '#f0f0f8');
      // Extract prefecture name to match the CSV data format (English names like "Miyagi", "Tokyo", etc.)
      const props = d.properties || {};
      
      // Try to get English prefecture names that match the CSV data format
      let name = props.name_en || props.name_1 || props.NAME_1 || 
                 props.prefecture || props.pref_name || 
                 props.N03_001 || props.N03_004 ||
                 props.name;
      
      // If we got a Japanese name, try to clean it up or provide fallback
      if (name && name !== 'Prefecture') {
        // Remove common suffixes like "県" (ken/prefecture) or "府" (fu) or "都" (to)
        name = name.replace(/[県府都道]/g, '');
      } else {
        name = 'Prefecture';
      }
      
        // Determine whether any rendered disaster-point circle is inside this
        // prefecture by checking the DOM: for each circle, find its closest
        // ancestor prefecture path and compare.
        let hasEvents = false;
        try {
          const circles = document.querySelectorAll('circle.disaster-point');
          for (const c of circles) {
            try {
              const pref = c.closest && c.closest('path.prefecture');
              if (pref === this) { hasEvents = true; break; }
            } catch (e) { /* ignore */ }
          }
        } catch (e) { hasEvents = false; }

        if (!hasEvents) {
          // explicit: no tooltip for polygons without events
          tip.style('display', 'none');
          return;
        }

        // Build and show tooltip (prefecture contains at least one disaster point)
        tip.style('display', 'block').html(`<strong>${name}</strong>`);
    })
    .on('mousemove', function (event) {
  tip.style('left', (event.pageX + 12) + 'px').style('top', (event.pageY + 12) + 'px');
    })
    .on('mouseout', function () {
      d3.select(this).attr('fill', '#f7f7f7');
  tip.style('display', 'none');
    });

  // Draw prefecture boundaries using the already loaded data
  // Use a single mesh path to create shared borders between prefectures
  try {
    const mesh = d3.geoMesh(japanGeo, (a, b) => a !== b);
    
    g.append('path')
      .datum(mesh)
      .attr('class', 'prefecture-boundaries')
      .attr('d', path)
      .attr('fill', 'none')
      .attr('stroke', '#444')
      .attr('stroke-width', 0.6)
      .attr('pointer-events', 'none')
      .attr('opacity', 0.95);
      
    console.log('Prefecture boundaries drawn');
  } catch (e) {
    console.warn('Failed to draw prefecture boundaries:', e.message);
  }

  // Zoom functionality disabled to keep fixed frame of view

  // Reset control removed since zoom functionality is disabled

  // Utility: if GeoJSON features are a MultiPolygon / many polygons, draw their borders
  function topoToBorders(geojson) {
    // If this looks like TopoJSON (has objects), try to extract; otherwise
    // simply return a FeatureCollection of boundaries merged.
    try {
      if (geojson.type === 'Topology' && geojson.objects) {
        // some public files may be TopoJSON; convert quickly using topojson.feature
        // but we don't include topojson lib here; fallback to iterating objects
        const feats = [];
        for (const k of Object.keys(geojson.objects)) {
          // naive: assume geometry is already usable
          // Attempt to construct a FeatureCollection-like thing if possible
          // If this fails, just return the original geojson
          try {
            // topojson isn't available in this minimal script; skip conversion.
          } catch (e) {}
        }
        return geojson; // fallback
      }
    } catch (e) {}
    // For ordinary FeatureCollection, return a MultiPolygon-like union path
    return { type: 'FeatureCollection', features: geojson.features };
  }

  console.log('Japan map rendered');
  return { svg, g, prefectures };
}

// Auto-run when loaded directly in the browser (module script include)
if (typeof window !== 'undefined') {
  // call and catch to avoid unhandled promise rejections
  const opts = {
    clipBottomPercent: 10,
    postClipWidth: "60%",
  };
  renderJapanMap(opts).catch(err => console.error('renderJapanMap error:', err));
}

// Export for module environments
export default renderJapanMap;
