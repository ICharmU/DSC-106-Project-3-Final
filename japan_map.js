
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

  // Animation state management
  let isAnimating = false;
  let currentAnimationId = null;
  let lastClickedPrefecture = null;
  let currentZoomLevel = 1;
  let currentViewCenter = { x: width / 2, y: height / 2 };

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
    .attr('stroke-width', 0.6);

  // Function to highlight a prefecture with animated orange background
  function highlightPrefecture(targetPrefectureId) {
    // Find the prefecture element by matching its data
    prefectures.each(function(d) {
      const currentId = (d.properties && d.properties.name_en) || 
                       (d.properties && d.properties.name) || 
                       JSON.stringify(path.centroid(d));
      
      if (currentId === targetPrefectureId) {
        const element = d3.select(this);
        const originalFill = '#f7f7f7'; // Standard grey background
        
        // Set golden immediately at full opacity, then fade to grey over 1.6 seconds
        element
          .attr('fill', '#e7c320ff')
          .attr('fill-opacity', 1.0)
          .transition()
          .duration(1600)
          .attr('fill', originalFill)
          .attr('fill-opacity', 1.0);
      }
    });
  }



  prefectures
    .on('click', function (event, d) {
      // Cancel any running animation and start new one immediately
      if (isAnimating) {
        if (currentAnimationId) {
          cancelAnimationFrame(currentAnimationId);
        }
        isAnimating = false;
      }
      
      // Get the center of the SVG
      const svgCenterX = width / 2;
      const svgCenterY = height / 2;
      
      // Get the centroid of the clicked prefecture
      const centroid = path.centroid(d);
      const prefCenterX = centroid[0];
      const prefCenterY = centroid[1];
      
      // Remove any existing zoom indicators
      g.selectAll('.zoom-indicator').remove();
      
      // Check if this is the same prefecture that was just clicked (zoom out case)
      const prefectureId = (d.properties && d.properties.name_en) || 
                          (d.properties && d.properties.name) || 
                          JSON.stringify(centroid);
      
      const isSamePrefecture = (lastClickedPrefecture === prefectureId && currentZoomLevel > 1.5);
      const isDifferentPrefecture = (lastClickedPrefecture && lastClickedPrefecture !== prefectureId);
      
      if (isSamePrefecture) {
        // ZOOM OUT: Return to center with smooth animation
        console.log('Zooming out to center');
        
        // Animate zoom out along straight line
        const animationDuration = 1500; // Faster zoom out
        const startTime = performance.now();
        const startZoom = currentZoomLevel;
        const startViewX = currentViewCenter.x;
        const startViewY = currentViewCenter.y;
        
        function animateZoomOut() {
          const currentTime = performance.now();
          const elapsed = currentTime - startTime;
          const progress = Math.min(elapsed / animationDuration, 1);
          
          // Ease-out for smooth deceleration
          const eased = 1 - Math.pow(1 - progress, 3);
          
          // Interpolate position along straight line
          const currentViewX = startViewX + (svgCenterX - startViewX) * eased;
          const currentViewY = startViewY + (svgCenterY - startViewY) * eased;
          
          // Interpolate zoom level back to 1
          const zoomLevel = startZoom + (1 - startZoom) * eased;
          
          // Apply transform
          const transform = d3.zoomIdentity
            .translate(width / 2, height / 2)
            .scale(zoomLevel)
            .translate(-currentViewX, -currentViewY);
          
          svg.call(zoom.transform, transform);
          
          // Update current state
          currentZoomLevel = zoomLevel;
          currentViewCenter.x = currentViewX;
          currentViewCenter.y = currentViewY;
          
          if (progress < 1 && isAnimating) {
            currentAnimationId = requestAnimationFrame(animateZoomOut);
          } else {
            // Animation complete
            isAnimating = false;
            currentAnimationId = null;
            lastClickedPrefecture = null;
            currentZoomLevel = 1;
            currentViewCenter.x = svgCenterX;
            currentViewCenter.y = svgCenterY;
            
            setTimeout(() => {
              g.selectAll('.zoom-indicator').remove();
            }, 300);
          }
        }
        
        isAnimating = true;
        currentAnimationId = requestAnimationFrame(animateZoomOut);
        
      } else if (isDifferentPrefecture) {
        // PREFECTURE TO PREFECTURE: Move from current prefecture to new prefecture
        console.log('Moving from current prefecture to new prefecture');
        
        // Draw a straight line from current view center to new prefecture center
        g.append('line')
          .attr('class', 'zoom-indicator')
          .attr('x1', currentViewCenter.x)
          .attr('y1', currentViewCenter.y)
          .attr('x2', prefCenterX)
          .attr('y2', prefCenterY)
          .attr('stroke', '#bc002d')
          .attr('stroke-width', 3)
          .attr('stroke-dasharray', '8,4');
        
        // Add markers at both ends
        g.append('circle')
          .attr('class', 'zoom-indicator')
          .attr('cx', currentViewCenter.x)
          .attr('cy', currentViewCenter.y)
          .attr('r', 4)
          .attr('fill', '#bc002d');
        
        g.append('circle')
          .attr('class', 'zoom-indicator')
          .attr('cx', prefCenterX)
          .attr('cy', prefCenterY)
          .attr('r', 4)
          .attr('fill', '#bc002d');
        
        // Animate movement along straight line (maintain zoom level)
        const distance = Math.sqrt(Math.pow(prefCenterX - currentViewCenter.x, 2) + Math.pow(prefCenterY - currentViewCenter.y, 2));
        const movementDuration = Math.max(800, Math.min(1200, distance * 2)); // Scale movement duration based on distance (800ms-1200ms)
        const redLineFadeDuration = 1600; // Red line fade always takes 1.6 seconds regardless of distance
        const fadeHoldDuration = 800; // Hold red markers at 100% for first 0.8 seconds
        const fadeOutDuration = 800; // Then fade from 100% to 0% over next 0.8 seconds
        const startTime = performance.now();
        const startZoom = currentZoomLevel;
        const startViewX = currentViewCenter.x;
        const startViewY = currentViewCenter.y;
        
        function animatePrefectureMove() {
          const currentTime = performance.now();
          const elapsed = currentTime - startTime;
          const movementProgress = Math.min(elapsed / movementDuration, 1);
          const fadeProgress = Math.min(elapsed / redLineFadeDuration, 1);
          
          // Smooth ease-in-out for natural movement
          const eased = movementProgress < 0.5 
            ? 2 * movementProgress * movementProgress 
            : 1 - Math.pow(-2 * movementProgress + 2, 2) / 2;
          
          // Calculate opacity: hold at 100% for first 0.8s, then fade over next 0.8s (always 1.6s total)
          let opacity = 1; // Default to full opacity
          if (elapsed > fadeHoldDuration) {
            // After 0.8s, start fading over the next 0.8s
            const fadeElapsed = elapsed - fadeHoldDuration;
            const opacityFadeProgress = Math.min(fadeElapsed / fadeOutDuration, 1);
            opacity = 1 - opacityFadeProgress; // Fade from 1 to 0
          }
          
          // Update red marker opacity
          g.selectAll('.zoom-indicator')
            .attr('opacity', opacity);
          
          // Interpolate position along straight line (maintain zoom level)
          const currentViewX = startViewX + (prefCenterX - startViewX) * eased;
          const currentViewY = startViewY + (prefCenterY - startViewY) * eased;
          
          // Apply transform (keep same zoom level)
          const transform = d3.zoomIdentity
            .translate(width / 2, height / 2)
            .scale(startZoom)
            .translate(-currentViewX, -currentViewY);
          
          svg.call(zoom.transform, transform);
          
          // Update current state only if movement is not complete
          if (movementProgress < 1) {
            currentViewCenter.x = currentViewX;
            currentViewCenter.y = currentViewY;
          }
          
          // Continue animation until both movement and red line fade are complete
          if ((movementProgress < 1 || fadeProgress < 1) && isAnimating) {
            currentAnimationId = requestAnimationFrame(animatePrefectureMove);
          } else {
            // Animation complete
            isAnimating = false;
            currentAnimationId = null;
            
            setTimeout(() => {
              g.selectAll('.zoom-indicator').remove();
            }, 400);
          }
        }
        
        // Start golden highlighting animation simultaneously with red fade
        highlightPrefecture(prefectureId);
        
        isAnimating = true;
        lastClickedPrefecture = prefectureId; // Set this immediately when starting prefecture-to-prefecture
        currentAnimationId = requestAnimationFrame(animatePrefectureMove);
        
      } else {
        // ZOOM IN: Normal circular animation
        console.log('Zooming in to prefecture');
        
        // Calculate the midpoint between SVG center and prefecture center
        const midX = (svgCenterX + prefCenterX) / 2;
        const midY = (svgCenterY + prefCenterY) / 2;
        
        // Calculate the distance between SVG center and prefecture center (for radius)
        const distance = Math.sqrt(Math.pow(prefCenterX - svgCenterX, 2) + Math.pow(prefCenterY - svgCenterY, 2));
        const radius = distance / 2; // Half the distance since circle is centered at midpoint
        
        // Calculate angles for the circular path (underside of circle)
        // Angle from circle center to SVG center
        const startAngle = Math.atan2(svgCenterY - midY, svgCenterX - midX);
        // Angle from circle center to prefecture center  
        const endAngle = Math.atan2(prefCenterY - midY, prefCenterX - midX);
      
      // Ensure we go the "underside" way (clockwise if prefecture is to the right)
      let angleSpan = endAngle - startAngle;
      if (angleSpan > Math.PI) angleSpan -= 2 * Math.PI;
      if (angleSpan < -Math.PI) angleSpan += 2 * Math.PI;
      
      // Create optimized zoom animation following the circular path over 2 seconds
      const animationDuration = 2000;
      const startTime = performance.now();
      
      // Pre-calculate some values for performance
      const zoomRange = 3; // from 1x to 4x zoom
      const halfWidth = width / 2;
      const halfHeight = height / 2;
      
      function animate() {
        const currentTime = performance.now();
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / animationDuration, 1);
        
        // Optimized easing function (ease-in-out cubic)
        const eased = progress < 0.5 
          ? 4 * progress * progress * progress 
          : 1 - Math.pow(-2 * progress + 2, 3) / 2;
        
        // Calculate current position along the circular path
        const currentAngle = startAngle + (angleSpan * eased);
        const currentX = midX + radius * Math.cos(currentAngle);
        const currentY = midY + radius * Math.sin(currentAngle);
        
        // Calculate zoom level (start at 1x, end at 4x)
        const zoomLevel = 1 + (zoomRange * eased);
        
        // Create and apply transform directly (no D3 transition)
        const transform = d3.zoomIdentity
          .translate(halfWidth, halfHeight)
          .scale(zoomLevel)
          .translate(-currentX, -currentY);
        
        // Apply transform immediately without transition for smooth 60fps animation
        svg.call(zoom.transform, transform);
        
        // Update current state
        currentZoomLevel = zoomLevel;
        currentViewCenter.x = currentX;
        currentViewCenter.y = currentY;
        
        // Continue animation if not complete
        if (progress < 1 && isAnimating) {
          currentAnimationId = requestAnimationFrame(animate);
        } else {
          // Animation complete
          isAnimating = false;
          currentAnimationId = null;
          
          // Highlight the prefecture with golden background
          highlightPrefecture(prefectureId);
          
          // Clean up indicators after a brief pause
          setTimeout(() => {
            g.selectAll('.zoom-indicator').remove();
          }, 500);
        }
      }
      
      // Start the zoom-in animation
      isAnimating = true;
      lastClickedPrefecture = prefectureId; // Set this immediately when starting zoom-in
      currentAnimationId = requestAnimationFrame(animate);
      }
      
      console.log(`Clicked prefecture center: (${prefCenterX}, ${prefCenterY})`);
      console.log(`SVG center: (${svgCenterX}, ${svgCenterY})`);
      
      console.log(`Clicked prefecture center: (${prefCenterX}, ${prefCenterY})`);
      console.log(`SVG center: (${svgCenterX}, ${svgCenterY})`);
    })
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

  // Set up D3 zoom behavior for the animation
  const zoom = d3.zoom()
    .scaleExtent([1, 10])
    .on('zoom', function(event) {
      g.attr('transform', event.transform);
    });

  // Apply zoom behavior to SVG
  svg.call(zoom);

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
