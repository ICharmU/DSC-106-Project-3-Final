import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";
// This script disables the hover tooltip that appears when hovering prefecture
// polygons rendered by `japan_map.js`. It does so without editing that file by
// adding a CSS rule that forces `.d3-tooltip` hidden when a body class is set,
// and toggling that class on prefecture hover. Disaster-point tooltips remain.

const DISABLE_CLASS = 'pref-tooltip-disabled';

// Insert a CSS rule to hide the tooltip when DISABLE_CLASS is present on <body>.
// Using !important ensures this overrides inline styles set by other scripts.
const styleId = 'pref-tooltip-style';
if (!document.getElementById(styleId)) {
	const style = document.createElement('style');
	style.id = styleId;
	style.textContent = `body.${DISABLE_CLASS} .d3-tooltip { display: none !important; }`;
	document.head.appendChild(style);
}

// Create a dedicated tooltip for prefectures (so we can style/position independently)
const prefTipId = 'prefecture-tooltip';
if (!document.getElementById(prefTipId)) {
	const prefTip = d3.select('body').append('div').attr('id', prefTipId).attr('class', 'prefecture-tooltip');
	// basic styles; users can override in CSS
	prefTip.style('position', 'absolute')
		.style('pointer-events', 'none')
		.style('padding', '6px 10px')
		.style('background', 'rgba(0,0,0,0.85)')
		.style('color', '#fff')
		.style('font-size', '13px')
		.style('border-radius', '4px')
		.style('display', 'none')
		.style('z-index', 2000)
		.style('max-width', '360px')
		.style('white-space', 'normal');
}

// Attach listeners to prefecture paths. If map hasn't been rendered yet, retry a
// few times (map is expected to be loaded before this script per your note).
let attachAttempts = 0;
function attachPrefectureHandlers() {
	attachAttempts += 1;
	const prefs = d3.selectAll('path.prefecture');
	if (prefs.empty()) {
		if (attachAttempts <= 6) {
			// try again after a short delay
			setTimeout(attachPrefectureHandlers, 200);
		}
		return;
	}

	// Use pointerenter/leave when available; fallback to mouseenter/mouseleave.
	const enter = 'pointerenter' in window ? 'pointerenter' : 'mouseenter';
	const leave = 'pointerleave' in window ? 'pointerleave' : 'mouseleave';
		const move = 'pointermove' in window ? 'pointermove' : 'mousemove';

		const prefTooltip = d3.select('#' + prefTipId);

		prefs
				.on(enter + '.prefTooltip', function (event, d) {
					// hide global tooltip
					d3.select('body').classed(DISABLE_CLASS, true);
					// prepare and show our prefecture tooltip listing disaster locations inside the polygon
					const feat = (d && d.properties) ? d : (d3.select(this).datum() ? d3.select(this).datum() : null);
					const props = feat && feat.properties ? feat.properties : {};
					const prefName = props.__engName || props.name_en || props.prefecture || props.pref_name || props.name || '';

					// Gather disaster points and test whether they fall inside this prefecture feature
					let points = [];
					try {
						// d3.selectAll(...).data() returns array of bound data objects
						points = d3.selectAll('circle.disaster-point').data() || [];
					} catch (e) {
						points = [];
					}

					const matches = [];
					if (feat && typeof d3.geoContains === 'function') {
						for (const p of points) {
							if (!p) continue;
							const lon = +p.longitude;
							const lat = +p.latitude;
							if (isNaN(lon) || isNaN(lat)) continue;
							try {
								if (d3.geoContains(feat, [lon, lat])) {
									matches.push(p);
								}
							} catch (e) {
								// ignore geometry errors
							}
						}
					}

					// Build tooltip content
					// If prefName is generic, prefer the first matched disaster's prefecture property as the title
					let title = prefName;
					if ((title === 'Prefecture' || !title) && matches.length > 0) {
						const first = matches[0];
						title = first.prefecture || first.prefecture_norm || first.pref_name || first.location_str || first.location || title;
					}

					// Compute total deaths for the prefecture, treating non-numeric (NaN/empty) as 0
					const fmt = new Intl.NumberFormat();
					const totalDeaths = matches.reduce((acc, p) => {
						const raw = p.deaths ?? p.death ?? 0;
						const n = Number(raw);
						return acc + (isNaN(n) ? 0 : n);
					}, 0);

					// Compute total affected similarly
					const totalAffected = matches.reduce((acc, p) => {
						const raw = p.affected ?? p.affect ?? 0;
						const n = Number(raw);
						return acc + (isNaN(n) ? 0 : n);
					}, 0);

					// Compute year range (min and max) from matched events. Ignore non-numeric years.
					const years = matches.map(p => {
						const raw = p.year ?? p.event_year ?? '';
						const y = Number(raw);
						return isNaN(y) ? null : Math.trunc(y);
					}).filter(y => y != null);
					let yearRangeText = 'N/A';
					if (years.length > 0) {
						const minY = Math.min(...years);
						const maxY = Math.max(...years);
						// Use an en-dash for ranges (e.g., 1960–2018). If all events are the same year show single year.
						yearRangeText = (minY === maxY) ? String(minY) : `${minY}–${maxY}`;
					}

					// Only show summary statistics: totals, year range, and event count.
					if (matches.length === 0) {
						prefTooltip.html(`<strong>${title}</strong><div style="margin-top:6px;color:#ddd">No recorded disasters in dataset</div>`).style('display', 'block');
					} else {
						const eventCount = matches.length;
						// Center each statistic line individually. Use simple centered divs
						// with a bullet character so each line is horizontally centered.
						const statsHtml = `
							<div style="margin-top:6px;color:#ffd">
								<div style="text-align:center;margin:6px 0">• Total deaths: ${fmt.format(totalDeaths)}</div>
								<div style="text-align:center;margin:6px 0">• Total affected: ${fmt.format(totalAffected)}</div>
								<div style="text-align:center;margin:6px 0">• Year range: ${yearRangeText}</div>
								<div style="text-align:center;margin:6px 0">• Disasters: ${eventCount}</div>
							</div>`;
						prefTooltip.html(`<strong>${title}</strong>${statsHtml}`).style('display', 'block');
					}
				})
			.on(move + '.prefTooltip', function (event) {
				// position tooltip near pointer, keep inside viewport
				const tipNode = document.getElementById(prefTipId);
				if (!tipNode) return;
				const padding = 10;
				const mouseX = event.pageX;
				const mouseY = event.pageY;
				// default offset
				let left = mouseX + 12;
				let top = mouseY + 12;
				// clamp to viewport
				const vw = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
				const vh = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
				const rect = tipNode.getBoundingClientRect();
				if (left + rect.width + padding > vw) left = Math.max(padding, mouseX - rect.width - 12);
				if (top + rect.height + padding > window.scrollY + vh) top = Math.max(padding, mouseY - rect.height - 12);
				prefTooltip.style('left', left + 'px').style('top', top + 'px');
			})
			.on(leave + '.prefTooltip', function () {
				// restore global tooltip behavior and hide our tooltip
				d3.select('body').classed(DISABLE_CLASS, false);
				prefTooltip.style('display', 'none');
			});
}

// Run attachment immediately
attachPrefectureHandlers();