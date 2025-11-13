import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

let disasters = ['drought', 'earthquake', 'extreme temperature', 'flood', 'landslide', 'storm', 'volcanic activity'];

const opts = {
    clipBottomPercent: 10,
    postClipWidth: "60%",
  };

const containerSelector = opts.selector || '#map'; // default to #map
const svg = d3.select(containerSelector);

const width = opts.width || 900;
const height = opts.height || 700;

const g = d3.select("g.map-group");

const tip = d3.select('.d3-tooltip');

// --- DISASTER COLOR PALETTES (SWAPPABLE) ---
const DISASTER_KEYS = [
  'drought','earthquake','extreme temperature','flood',
  'landslide','storm','volcanic activity'
];

const disasterData = await d3.csv('./data/gdis_emdat_japan_prefecture_merged_enh.csv');
let year = 1960;
let isInitialLoad = true; // Flag to track if this is the first render

const paletteDefault = {
  'drought': '#4E79A7',
  'earthquake': '#F28E2B',
  'extreme temperature': '#E15759',
  'flood': '#76B7B2',
  'landslide': '#59A14F',
  'storm': '#EDC948',
  'volcanic activity': '#AF7AA1'
};

// High-contrast preset
const paletteHighContrast = {
  'drought': '#D4A017',          // bold blue
  'earthquake': '#7B3F00',       // vivid red
  'extreme temperature': '#FF7F00', // strong orange
  'flood': '#005AB5',            // teal
  'landslide': '#2CA02C',        // green
  'storm': '#8A2BE2',            // violet
  'volcanic activity': '#DC3220' // black
};

// Active palette (start with default)
let ACTIVE_PALETTE = { ...paletteDefault };

// Helper: color accessor
function disasterColor(key) {
  return ACTIVE_PALETTE[key] || '#889';
}

function idToCanonical(id) {
  if (id === 'ExtremeTemperature') return 'extreme temperature';
  if (id === 'VolcanicActivity')  return 'volcanic activity';
  return id.toLowerCase();
}

// After the map layers exist, we’ll wire these up:
const activeDisasters = new Set(DISASTER_KEYS);

// ----------------- MAP LAYERS -----------------
//const gBasemap = root.selectAll('g.basemap').data([null]).join('g').attr('class', 'basemap');
const mapGroup = d3.select('g.map-group');
const gPoints  = mapGroup.selectAll('g.points')
  .data([null])
  .join('g')
  .attr('class', 'points');

// Colorize the checkbox squares to match the palette
function colorizeCheckboxes() {
  document.querySelectorAll('.disaster-item input').forEach(input => {
    const id = input.id; // your ID casing
    const canonical = (
      id === 'ExtremeTemperature' ? 'extreme temperature' :
      id === 'VolcanicActivity' ? 'volcanic activity' :
      id.toLowerCase()
    );
    const swatch = input.nextElementSibling; // <span class="custom-checkbox"> (kept in your HTML)
    if (!swatch) return;
    swatch.style.backgroundColor = input.checked ? disasterColor(canonical) : 'transparent';
    swatch.style.border = `2px solid ${disasterColor(canonical)}`;
  });
}

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
}

//assign color
//const color = d3.scaleOrdinal().domain(disasters)
//.range(d3.schemeTableau10); 

//color code checkboxes
// document.querySelectorAll('.disaster-item input').forEach(input => {
//   const disaster = input.id.toLowerCase(); // match your disasters array
//   const box = input.nextElementSibling;    // the <span> custom checkbox
//   box.style.backgroundColor = color(disaster.toLowerCase());

//   // Toggle color on click
//   input.addEventListener('change', () => {
//     if (input.checked) {
//       box.style.backgroundColor = color(disaster.toLowerCase()); // colored
//     } else {
//       box.style.backgroundColor = 'white'; // unchecked = white
//     }
//   });
// });

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

function renderDisasterPoints(year) {
  try {
    // Filter out rows with missing coordinates
    const validData = disasterData.filter(d =>
      d.latitude && d.longitude &&
      !isNaN(+d.latitude) && !isNaN(+d.longitude) &&
      +d.year === +year &&
      activeDisasters.has(d.disaster_type_gdis)
    );

    console.log(`Loaded ${validData.length} disaster events with valid coordinates`);

    // --- KEYED JOIN (no pre-remove) for smooth enter/exit transitions ---
    const keyFn = d =>
      `${d.disaster_type_gdis}|${(+d.longitude).toFixed(3)},${(+d.latitude).toFixed(3)}|${d.year}`;

    const dots = gPoints
      .selectAll('circle.disaster-point')
      .data(validData, keyFn);

    // ENTER: immediate display on initial load, transition on subsequent loads
    const dotsEnter = dots.enter()
      .append('circle')
      .attr('class', 'disaster-point')
      .attr('cx', d => projection([+d.longitude, +d.latitude])[0])
      .attr('cy', d => projection([+d.longitude, +d.latitude])[1])
      .attr('r', isInitialLoad ? 3.5 : 0)
      .attr('fill', d => disasterColor(d.disaster_type_gdis))
      .attr('stroke', d => d3.color(disasterColor(d.disaster_type_gdis)).darker(1))
      .attr('stroke-width', 0.6)
      .attr('opacity', isInitialLoad ? 0.9 : 0)
      .style('cursor', 'pointer');

    // Apply transition only if not initial load
    if (!isInitialLoad) {
      dotsEnter.transition().duration(380)
        .attr('opacity', 0.9)
        .attr('r', 3.5);
    }

    // UPDATE: gently move/recolor if needed
    dots.transition().duration(320)
      .attr('cx', d => projection([+d.longitude, +d.latitude])[0])
      .attr('cy', d => projection([+d.longitude, +d.latitude])[1])
      .attr('fill', d => disasterColor(d.disaster_type_gdis))
      .attr('stroke', d => d3.color(disasterColor(d.disaster_type_gdis)).darker(1));

    // EXIT: fade + shrink
    dots.exit()
      .transition().duration(280)
      .attr('opacity', 0)
      .attr('r', 0)
      .remove();

    // (Re)attach hover handlers on the merged selection
    const merged = dotsEnter.merge(dots);
    merged
      .on('mouseover', function (event, d) {
        d3.select(this).transition().duration(120).attr('r', 5).attr('opacity', 1);
        // format numbers for readability
        const fmt = new Intl.NumberFormat();
        const fmtCurrency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
        const deaths = d.deaths ?? d.death ?? '';
        const affected = d.affected ?? d.total_affected ?? d.affect ?? '';
        const injured = d.injured ?? '';
        const homeless = d.homeless ?? '';
        const damageUsd = (d.damage_final_usd ?? d.damage_final) ?? d.damage_adj_usd ?? '';

        const tooltipText = `
          <strong>${d.disaster_type_gdis || 'Disaster'}</strong><br/>
          Location: ${d.location_str || 'Unknown'}<br/>
          Prefecture: ${d.prefecture || 'Unknown'}<br/>
          Year: ${d.year || 'Unknown'}<br/>
          Affected: ${affected !== '' ? fmt.format(Number(affected)) : 'N/A'}<br/>
          Injured: ${injured !== '' ? fmt.format(Number(injured)) : 'N/A'}<br/>
          Homeless: ${homeless !== '' ? fmt.format(Number(homeless)) : 'N/A'}<br/>
          Deaths: ${deaths !== '' ? fmt.format(Number(deaths)) : 'N/A'}<br/>
          Damage (USD): ${damageUsd !== '' ? fmtCurrency.format(Number(damageUsd)) : 'N/A'}
        `;
        tip.style('display', 'block').html(tooltipText);
      })
      .on('mousemove', function (event) {
        tip.style('left', (event.pageX + 12) + 'px').style('top', (event.pageY + 12) + 'px');
      })
      .on('mouseout', function () {
        d3.select(this).transition().duration(120).attr('r', 3.5).attr('opacity', 0.9);
        tip.style('display', 'none');
      });

    // Mark initial load as complete
    if (isInitialLoad) {
      isInitialLoad = false;
      console.log('Initial load complete - future renders will use transitions');
    }

  } catch (e) {
    console.warn('Failed to load or render disaster data:', e.message);
  }
}


function syncFromCheckboxes() {
  activeDisasters.clear();
  document.querySelectorAll('.disaster-item input').forEach(input => {
    const key = idToCanonical(input.id);
    if (input.checked) activeDisasters.add(key);
  });
  colorizeCheckboxes();
  renderDisasterPoints(year);
}

document.querySelectorAll('.disaster-item input').forEach(input => {
  input.addEventListener('change', syncFromCheckboxes);
});

function autoplayYears() {
    let forward = true;
    if (year == 2018) {
        forward = false;
    }
    nestedAutoplay();
    function nestedAutoplay() {
        if (autoplay) {
            if (year == 2018) {
                forward = false;
            }
            if (year == 1960) {
                forward = true;
            }
            output.innerHTML = year;
            slider.value = year;
            renderDisasterPoints(year);
            // If a pointer position is available, update prefecture tooltip to reflect
            // whatever the user is currently hovering over (useful during autoplay).
            try {
                if (typeof window.__prefShowTooltipAtPointer === 'function') window.__prefShowTooltipAtPointer();
            } catch (e) {
                // ignore
            }
            if (forward) {
                year += 1;
            }
            else {
                year -= 1;
            }
            setTimeout(nestedAutoplay, 360)
        }
    }
}

// ----------------- PALETTE SWITCHER (now safe to call) -----------------
window.setDisasterPalette = (which = 'default') => {
  ACTIVE_PALETTE = (which === 'high') ? { ...paletteHighContrast } : { ...paletteDefault };
  colorizeCheckboxes();
  renderDisasterPoints(year);
};

// Initial paint AFTER everything exists:
colorizeCheckboxes();
renderDisasterPoints(year);
// pick whichever you want as default:
setDisasterPalette('high');
// setDisasterPalette('default');


var slider = document.getElementById("myRange");
var output = document.getElementById("demo");
output.innerHTML = slider.value;
const myTextBox = document.getElementById('myTextBox');
const myButton = document.getElementById('myButton');
const prevButton = document.getElementById('prevButton');
const nextButton = document.getElementById('nextButton');
let autoplay = false;
const autoplayButton = document.getElementById('autoplay');

const droughtCheck = document.getElementById('Drought');
const earthquakeCheck = document.getElementById('Earthquake');
const tempCheck = document.getElementById('ExtremeTemperature');
const floodCheck = document.getElementById('Flood');
const landslideCheck = document.getElementById('Landslide');
const stormCheck = document.getElementById('Storm');
const volcanoCheck = document.getElementById('VolcanicActivity');

slider.oninput = function() {
    autoplay = false;
    autoplayButton.innerText = 'play';
    output.innerHTML = parseInt(this.value);
    year = parseInt(this.value);
    renderDisasterPoints(year);
};

prevButton.addEventListener('click', function() {
    autoplay = false;
    autoplayButton.innerText = 'play';
    if (year != 1960) {
        year -= 1;
        slider.value = year;
        output.innerHTML = year;
        renderDisasterPoints(year);
    }
});

nextButton.addEventListener('click', function() {
    autoplay = false;
    autoplayButton.innerText = 'play';
    if (year != 2018) {
        year += 1;
        slider.value = year;
        output.innerHTML = year;
        renderDisasterPoints(year);
    }
});

myButton.addEventListener('click', function() {
    const textValue = parseInt(myTextBox.value);
    if (!isNaN(textValue) && textValue >= 1960 && textValue <= 2018) {
        autoplay = false;
        autoplayButton.innerText = 'play';
        slider.value = textValue;
        output.innerHTML = textValue;
        year = textValue;
        renderDisasterPoints(year);
    }
});

autoplayButton.addEventListener('click', function() {
    autoplay = !autoplay;
    if (autoplay) {
        autoplayYears();
        autoplayButton.innerText = 'pause';
    }
    else {
        autoplayButton.innerText = 'play';
    }
});

droughtCheck.addEventListener('click', function() {
    if (droughtCheck.checked) {
        disasters.push('drought');
    }
    else {
        var index = disasters.indexOf('drought');
        if (index !== -1) {
            disasters.splice(index, 1);
        }
    }
    renderDisasterPoints(year);
});

earthquakeCheck.addEventListener('click', function() {
    if (earthquakeCheck.checked) {
        disasters.push('earthquake');
    }
    else {
        var index = disasters.indexOf('earthquake');
        if (index !== -1) {
            disasters.splice(index, 1);
        }
    }
    renderDisasterPoints(year);
});

tempCheck.addEventListener('click', function() {
    if (tempCheck.checked) {
        disasters.push('extreme temperature');
    }
    else {
        var index = disasters.indexOf('extreme temperature');
        if (index !== -1) {
            disasters.splice(index, 1);
        }
    }
    renderDisasterPoints(year);
});

floodCheck.addEventListener('click', function() {
    if (floodCheck.checked) {
        disasters.push('flood');
    }
    else {
        var index = disasters.indexOf('flood');
        if (index !== -1) {
            disasters.splice(index, 1);
        }
    }
    renderDisasterPoints(year);
});

landslideCheck.addEventListener('click', function() {
    if (landslideCheck.checked) {
        disasters.push('landslide');
    }
    else {
        var index = disasters.indexOf('landslide');
        if (index !== -1) {
            disasters.splice(index, 1);
        }
    }
    renderDisasterPoints(year);
});

stormCheck.addEventListener('click', function() {
    if (stormCheck.checked) {
        disasters.push('storm');
    }
    else {
        var index = disasters.indexOf('storm');
        if (index !== -1) {
            disasters.splice(index, 1);
        }
    }
    renderDisasterPoints(year);
});

volcanoCheck.addEventListener('click', function() {
    if (volcanoCheck.checked) {
        disasters.push('volcanic activity');
    }
    else {
        var index = disasters.indexOf('volcanic activity');
        if (index !== -1) {
            disasters.splice(index, 1);
        }
    }
    renderDisasterPoints(year);
});

gPoints.raise();

// Initial render for starting year (1960)
renderDisasterPoints(year);