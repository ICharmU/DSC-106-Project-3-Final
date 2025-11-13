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
		.style('z-index', '2147483647')
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

	// Track the last pointer position so other scripts (like autoplay) can ask
	// the tooltip to show for whatever is currently under the cursor.
	window.__prefLastPointer = null;
	window.__prefHoveredEl = null;
	document.addEventListener('pointermove', (e) => {
		window.__prefLastPointer = { clientX: e.clientX, clientY: e.clientY, pageX: e.pageX, pageY: e.pageY };
	});

	// Show the prefecture tooltip for whatever prefecture (if any) is currently
	// under the last known pointer position. This is safe to call from outside
	// (e.g. autoplay) and will dispatch pointerenter/pointermove events so the
	// existing handlers run normally.
	window.__prefShowTooltipAtPointer = function () {
		const p = window.__prefLastPointer;
		if (!p) return;
		const el = document.elementFromPoint(p.clientX, p.clientY);
		const prefEl = el ? el.closest && el.closest('path.prefecture') : null;

		// If previously hovered element exists and is different, send leave
		if (window.__prefHoveredEl && window.__prefHoveredEl !== prefEl) {
			try {
				window.__prefHoveredEl.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true, clientX: p.clientX, clientY: p.clientY, pageX: p.pageX, pageY: p.pageY }));
			} catch (e) {}
			window.__prefHoveredEl = null;
		}

		if (prefEl && prefEl !== window.__prefHoveredEl) {
			try {
				prefEl.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true, clientX: p.clientX, clientY: p.clientY, pageX: p.pageX, pageY: p.pageY }));
				prefEl.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: p.clientX, clientY: p.clientY, pageX: p.pageX, pageY: p.pageY }));
			} catch (e) {}
			window.__prefHoveredEl = prefEl;
		} else if (prefEl && prefEl === window.__prefHoveredEl) {
			// The pointer is still over the same prefecture. Instead of only
			// dispatching a pointermove (which only repositions), dispatch a
			// custom event that requests the prefecture recompute its stats and
			// refresh the tooltip content. This ensures autoplay or external
			// callers can force a refresh while the pointer hasn't moved.
			try {
				const ev = new CustomEvent('prefTooltipRefresh', { detail: p, bubbles: true });
				prefEl.dispatchEvent(ev);
			} catch (e) {}
		}
	};

	window.__prefHideTooltip = function () {
		if (window.__prefHoveredEl) {
			try {
				window.__prefHoveredEl.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
			} catch (e) {}
			window.__prefHoveredEl = null;
		}
	};


	// Helper: compute stats for a prefecture feature/node and show the tooltip.
	function computeAndShow(prefNode, event, d) {
		// prepare and show our prefecture tooltip listing disaster locations inside the polygon
		const feat = (d && d.properties) ? d : (d3.select(prefNode).datum() ? d3.select(prefNode).datum() : null);
		const props = feat && feat.properties ? feat.properties : {};
		const prefName = props.__engName || props.name_en || props.prefecture || props.pref_name || props.name || '';

		// Retrieve precomputed stats for this prefecture if available to avoid recalculation
		let stats = null;
		try {
			const id = feat && feat.properties ? feat.properties.__prefTooltipId : null;
			if (id && typeof prefStatsMap !== 'undefined' && prefStatsMap.has(id)) {
				stats = prefStatsMap.get(id);
			}
		} catch (e) {
			stats = null;
		}

		// Fallback: if precomputation wasn't possible, compute matches on demand
		let matches = [];
		if (!stats) {
			try {
				const points = d3.selectAll('circle.disaster-point').data() || [];
				if (feat && typeof d3.geoContains === 'function') {
					for (const p of points) {
						if (!p) continue;
						const lon = +p.longitude;
						const lat = +p.latitude;
						if (isNaN(lon) || isNaN(lat)) continue;
						try {
							if (d3.geoContains(feat, [lon, lat])) matches.push(p);
						} catch (e) {
							// ignore geometry errors
						}
					}
				}
			} catch (e) {
				matches = [];
			}
		}

		// If geoContains matched nothing (or geoContains isn't available), try a
		// pixel-based fallback: for each rendered circle, check the DOM elements at
		// the circle's center (elementsFromPoint) to see if the hovered
		// prefecture path exists in that stacking context. This is robust when
		// coordinates or geometry cause geoContains to miss.
		try {
			if (matches.length === 0) {
				const nodes = d3.selectAll('circle.disaster-point').nodes() || [];
				for (const node of nodes) {
					if (!node) continue;
					const rect = node.getBoundingClientRect();
					const cx = rect.left + rect.width / 2;
					const cy = rect.top + rect.height / 2;
					// elementsFromPoint returns an array of elements under the coordinate
					const els = document.elementsFromPoint(cx, cy) || [];
					for (const el of els) {
						const prefClosest = el.closest && el.closest('path.prefecture');
						if (prefClosest === prefNode) {
							// retrieve datum bound to the circle via d3
							const dDatum = d3.select(node).datum();
							if (dDatum) matches.push(dDatum);
							break; // stop scanning elements for this node
						}
					}
				}
			}
		} catch (e) {
			// don't break tooltip on errors — leave matches as-is
		}

		// Build tooltip content
		// If prefName is generic, prefer a representative matched disaster's prefecture property as the title
		let title = prefName;
		if ((title === 'Prefecture' || !title)) {
			if (stats && stats.repPrefName) {
				title = stats.repPrefName;
			} else if (matches.length > 0) {
				const first = matches[0];
				title = first.prefecture || first.prefecture_norm || first.pref_name || first.location_str || first.location || title;
			}
		}

		// Compute and display statistics. Prefer precomputed `stats` when available
		const fmt = new Intl.NumberFormat();
		const fmtCurrency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
		let totalDeaths = 0;
		let totalAffected = 0; // kept for internal use but not shown as 'Total Affected'
		let totalInjured = 0;
		let totalHomeless = 0;
		let totalDamageUsd = 0;
		let eventCount = 0;
		let yearRangeText = 'N/A';
		let hasValidYear = false;
		if (stats) {
			totalDeaths = stats.totalDeaths || 0;
			totalAffected = stats.totalAffected || 0;
			totalInjured = stats.totalInjured || 0;
			totalHomeless = stats.totalHomeless || 0;
			totalDamageUsd = stats.totalDamageUsd || 0;
			eventCount = stats.eventCount || 0;
			hasValidYear = !!stats.hasValidYear;
			if (stats.hasValidYear) {
				yearRangeText = (stats.minYear === stats.maxYear) ? String(stats.minYear) : `${stats.minYear}–${stats.maxYear}`;
			}
		} else {
			// fallback to on-demand computation if precomputation wasn't available
			totalDeaths = matches.reduce((acc, p) => {
				const raw = p.deaths ?? p.death ?? 0;
				const n = Number(raw);
				return acc + (isNaN(n) ? 0 : n);
			}, 0);
			totalAffected = matches.reduce((acc, p) => {
				const raw = p.affected ?? p.total_affected ?? p.affect ?? 0;
				const n = Number(raw);
				return acc + (isNaN(n) ? 0 : n);
			}, 0);
			totalInjured = matches.reduce((acc, p) => {
				const raw = p.injured ?? 0;
				const n = Number(raw);
				return acc + (isNaN(n) ? 0 : n);
			}, 0);
			totalHomeless = matches.reduce((acc, p) => {
				const raw = p.homeless ?? 0;
				const n = Number(raw);
				return acc + (isNaN(n) ? 0 : n);
			}, 0);
			totalDamageUsd = matches.reduce((acc, p) => {
				const raw = (p.damage_final_usd ?? p.damage_final ?? p.damage_adj_usd) ?? 0;
				const n = Number(raw);
				return acc + (isNaN(n) ? 0 : n);
			}, 0);
			eventCount = matches.length;
			const years = matches.map(p => {
				const raw = p.year ?? p.event_year ?? '';
				const y = Number(raw);
				return isNaN(y) ? null : Math.trunc(y);
			}).filter(y => y != null);
			if (years.length > 0) {
				const minY = Math.min(...years);
				const maxY = Math.max(...years);
				yearRangeText = (minY === maxY) ? String(minY) : `${minY}–${maxY}`;
				hasValidYear = true;
			}
		}

		// Attach hasValidYear as a data attribute for external use, then show summary statistics
		prefTooltip.attr('data-has-valid-year', hasValidYear ? 'true' : 'false');
		// Only show summary statistics: totals, year range, and event count.
		if (eventCount === 0) {
			// When there are no matching disaster points, do not show the prefecture
			// tooltip at all. Ensure the global (point) tooltip remains enabled.
			d3.select('body').classed(DISABLE_CLASS, false);
			prefTooltip.style('display', 'none').html('');
		} else {
			// When we do have matches, suppress the global tooltip so our
			// prefecture tooltip is used instead.
			d3.select('body').classed(DISABLE_CLASS, true);
			// Center each statistic line individually. Use simple centered divs
			// with a bullet character so each line is horizontally centered.
			const statsHtml = `
					<div style="margin-top:6px;color:#ffd">
						<div style="text-align:center;margin:6px 0">• Affected: ${fmt.format(totalAffected)}</div>
						<div style="text-align:center;margin:6px 0">• Injured: ${fmt.format(totalInjured)}</div>
						<div style="text-align:center;margin:6px 0">• Homeless: ${fmt.format(totalHomeless)}</div>
						<div style="text-align:center;margin:6px 0">• Deaths: ${fmt.format(totalDeaths)}</div>
						<div style="text-align:center;margin:6px 0">• Damage (USD): ${fmtCurrency.format(totalDamageUsd)}</div>
						<div style="text-align:center;margin:6px 0">• Year: ${yearRangeText}</div>
						<div style="text-align:center;margin:6px 0">• Disasters: ${eventCount}</div>
					</div>`;
			prefTooltip.html(`<strong>${title}</strong>${statsHtml}`).style('display', 'block');
		}
	}

	// Attach handlers and a custom refresh listener so external code (autoplay)
	// can request the currently-hovered prefecture to recompute its stats.
	const prefNodes = prefs.nodes();
	for (const node of prefNodes) {
		// custom refresh event
		node.addEventListener('prefTooltipRefresh', function (ev) {
			computeAndShow(node, ev.detail || window.__prefLastPointer, null);
		});
	}

	prefs
		.on(enter + '.prefTooltip', function (event, d) {
			computeAndShow(this, event, d);
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