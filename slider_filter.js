import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

// japan_map.js
// Simple D3 map renderer for Japan prefectures.
// - Loads ./data/japan_prefectures.geojson if present, otherwise falls back
//   to a public URL (user may replace with a local copy for reliability).
// - Renders prefecture polygons, prefecture borders, hover tooltip, and
//   a click-to-zoom-to-prefecture behavior with an animated fit (respects
//   prefers-reduced-motion).

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
const color = d3.scaleOrdinal().domain(disasters)
.range(d3.schemeTableau10); 

//color code checkboxes
document.querySelectorAll('.disaster-item input').forEach(input => {
  const disaster = input.id.toLowerCase(); // match your disasters array
  const box = input.nextElementSibling;    // the <span> custom checkbox
  box.style.backgroundColor = color(disaster.toLowerCase());

  // Toggle color on click
  input.addEventListener('change', () => {
    if (input.checked) {
      box.style.backgroundColor = color(disaster.toLowerCase()); // colored
    } else {
      box.style.backgroundColor = 'white'; // unchecked = white
    }
  });
});

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

const disasterData = await d3.csv('./data/gdis_emdat_japan_prefecture_merged_enh.csv');
let year = 1960;

function renderDisasterPoints(year) {
    try {
        
        // Filter out rows with missing coordinates
        const validData = disasterData.filter(d => 
        d.latitude && d.longitude && 
        !isNaN(+d.latitude) && !isNaN(+d.longitude)
        && d.year == year && disasters.includes(d.disaster_type_gdis));
        console.log(disasters);
        
        console.log(`Loaded ${validData.length} disaster events with valid coordinates`);

        g.selectAll('circle.disaster-point').remove();
        
        // Add red dots for each disaster location
        const dots = g.selectAll('circle.disaster-point')
        .data(validData)
        .join('circle')
        .attr('class', 'disaster-point')
        .attr('cx', d => projection([+d.longitude, +d.latitude])[0])
        .attr('cy', d => projection([+d.longitude, +d.latitude])[1])
        .attr('r', 3)
        .attr('fill', d => color(d.disaster_type_gdis))
        .attr('stroke', d => d3.color(color(d.disaster_type_gdis)).darker(1))
        .attr('stroke-width', 0.5)
        .attr('opacity', 0.7)
        .style('cursor', 'pointer')
        .on('mouseover', function(event, d) {
            d3.select(this).attr('r', 5).attr('opacity', 1);
            const tooltipText = `
            <strong>${d.disaster_type_gdis || 'Disaster'}</strong><br/>
            Location: ${d.location_str || 'Unknown'}<br/>
            Prefecture: ${d.prefecture || 'Unknown'}<br/>
            Year: ${d.year || 'Unknown'}<br/>
            Deaths: ${d.deaths || '0'}<br/>
            Affected: ${d.total_affected || '0'}
            `;
            tip.style('display', 'block').html(tooltipText);
        })
        .on('mousemove', function(event) {
            tip.style('left', (event.pageX + 12) + 'px').style('top', (event.pageY + 12) + 'px');
        })
        .on('mouseout', function() {
            d3.select(this).attr('r', 3).attr('opacity', 0.7);
            tip.style('display', 'none');
        });
        
        console.log('Disaster points rendered');
    } catch (e) {
        console.warn('Failed to load or render disaster data:', e.message);
    }
}

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
            if (forward) {
                year += 1;
            }
            else {
                year -= 1;
            }
            setTimeout(nestedAutoplay, 200)
        }
    }
}

renderDisasterPoints(year);


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
    output.innerHTML = this.value;
    year = this.value;
    renderDisasterPoints(year);
};

prevButton.addEventListener('click', function() {
    autoplay = false;
    if (year != 1960) {
        year -= 1;
        slider.value = year;
        output.innerHTML = year;
        renderDisasterPoints(year);
    }
});

nextButton.addEventListener('click', function() {
    autoplay = false;
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