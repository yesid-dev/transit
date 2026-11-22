import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { lineEngine } from './line-engine.mjs';
import { overviewEngine } from './overview-engine.mjs';

const read = (file) => readFileSync(new URL(file, import.meta.url));
// STM serves the listed feeds; OC Transpo serves a manifest, provenance and a passing pipeline gate.
// Every unlisted v1 path is a 404.
const files = Object.fromEntries(
	[
		['/v1/providers.json', 'providers.json'],
		['/v1/stm/manifest.json', 'manifest.json'],
		['/v1/stm/provenance.json', 'provenance.json'],
		['/v1/stm/static/stops/S1.json', 'stop.json'],
		['/v1/stm/static/stops_index.json', 'stops-index.json'],
		['/v1/stm/static/routes_index.json', 'routes-index.json'],
		['/v1/stm/historic/hotspots.json', 'hotspots.json'],
		['/v1/stm/historic/repeat_offenders.json', 'repeat-offenders.json'],
		['/v1/stm/live/stop_departures.json', 'departures.json'],
		['/v1/stm/live/alerts.json', 'alerts.json'],
		['/v1/stm/live/trips.json', 'trips.json'],
		['/v1/stm/historic/stop_reliability/S1.json', 'stop-reliability.json'],
		['/v1/stm/historic/history/index.json', 'history-index.json'],
		['/v1/octranspo/provenance.json', 'provenance.json'],
		['/v1/octranspo/status/data_health.json', 'data-health.json'],
	].map(([path, file]) => [path, read(`./${file}`)]),
);
const ottawa = JSON.parse(files['/v1/providers.json']).providers.find(
	({ id }) => id === 'octranspo',
);
files['/v1/octranspo/manifest.json'] = JSON.stringify({
	...JSON.parse(files['/v1/stm/manifest.json']),
	provider: ottawa.id,
	display_name: ottawa.labels.en.operator,
	bbox: ottawa.fit_bounds,
});
// The b9 bundle's line, its stop and their reliability back the line page.
const { files: b9 } = JSON.parse(read('../scripts/__fixtures__/b9/rich.json'));
files['/v1/stm/historic/receipts/index.json'] = JSON.stringify(b9['historic/receipts/index.json']);
files['/v1/stm/historic/receipts/2026-08-29.json'] = JSON.stringify({
	generated_utc: '2026-06-15T12:00:00Z',
	date: '2026-08-29',
	otp_pct: 80,
	worst_route: { id: '1-373', name: 'Confederation', otp_delta_pts: -8 },
});
for (const [key, body] of Object.entries(b9)) {
	if (/^(static\/(routes|stops)|historic\/(route|stop)_reliability)\//.test(key))
		files[`/v1/stm/${key}`] ??= JSON.stringify(body);
}
// T4 Live/Schedule: real-size destination lists, isolated from the ordinary line fixture.
const lineStops = Array.from({ length: 61 }, (_, i) => ({
	id: `t4-${i}`,
	seq: i + 1,
	name: `Station de l’Université / Boulevard Édouard-Montpetit et chemin de la Côte-des-Neiges ${i + 1}`,
}));
files['/v1/stm/static/routes/9003.json'] = JSON.stringify({
	...b9['static/routes/24.json'],
	id: '9003',
	short: '9003',
	long: 'Long destinations and live reports',
	type: 3,
	directions: [61, 61, 25, 25].map((size, i) => ({
		dir: i % 2,
		headsign: ['Greenboro / Rockcliffe', 'Rockcliffe via station', 'Billings Bridge', 'Rideau'][i],
		stops: lineStops.slice(0, size),
	})),
	service_periods: [
		{ shift: 'am_peak', window: '06:00–09:00', headway_min: 9 },
		{ shift: 'afternoon', window: '15:00–19:00', headway_min: 15 },
		{ shift: 'night', window: null, headway_min: 30.5 },
	],
});
files['/v1/stm/static/routes/9004.json'] = JSON.stringify({
	...JSON.parse(files['/v1/stm/static/routes/9003.json']),
	id: '9004',
	short: '9004',
	type: 1,
});
// T6 Live now: a hub at the size of the busiest stops (12 lines, two predictions each, the longest
// French destinations), a stop served only by the metro (no live data) and one no line serves.
const t6HubLines = [
	'24',
	'51',
	'80',
	'105',
	'107',
	'129',
	'160',
	'161',
	'165',
	'166',
	'368',
	'747',
];
const t6Stop = (id, name, routes, scheduled) =>
	JSON.stringify({
		generated_utc: '2026-06-15T12:00:00Z',
		id,
		code: id.slice(3),
		name,
		lat: 45.5,
		lon: -73.6,
		routes_served: routes,
		scheduled,
	});
files['/v1/stm/static/stops/T6-HUB.json'] = t6Stop(
	'T6-HUB',
	'Station Côte-des-Neiges / chemin de la Côte-Sainte-Catherine (Hôpital général juif)',
	t6HubLines,
	t6HubLines.flatMap((route, i) => [
		{
			route,
			headsign: [
				'Station Côte-Vertu via boulevard Décarie et chemin de la Côte-des-Neiges',
				'Terminus Centre-ville / Gare d’autocars de Montréal',
				'Tunney’s Pasture / Blair via Transitway',
			][i % 3],
			times: ['08:00'],
		},
		...(i % 4 === 0
			? [{ route, headsign: 'Station Université-de-Montréal', times: ['08:10'] }]
			: []),
	]),
);
files['/v1/stm/static/stops/T6-METRO.json'] = t6Stop(
	'T6-METRO',
	'Station Berri-UQAM',
	['1-373'],
	[],
);
files['/v1/stm/static/stops/T6-NONE.json'] = t6Stop('T6-NONE', 'Arrêt temporaire', [], []);
// Line 9001: seven complete days of 1,000 readings with one-decimal shares (89.8% ...), the widest
// daily labels a phone must place without overlap. Built from a seed, not a committed fixture.
const decimalWeek = [898, 912, 887, 905, 893, 921, 879];
const decimalDates = decimalWeek.map((_, day) => `2026-08-${23 + day}`);
files['/v1/stm/static/routes/9001.json'] = JSON.stringify({
	...b9['static/routes/24.json'],
	id: '9001',
	short: '9001',
	long: 'Seven decimal days',
});
files['/v1/stm/historic/route_reliability/9001.json'] = JSON.stringify({
	...b9['historic/route_reliability/24.json'],
	id: '9001',
	periods: decimalWeek.map((on_time, day) => ({
		grain: 'day',
		date: decimalDates[day],
		observation_count: 1000,
		on_time,
		// Published shares are whole percents; the counts carry the decimals the page shows.
		otp_pct: Math.round(on_time / 10),
		avg_delay_min: 2.4,
	})),
	periods_by_grain: [
		{ grain: 'day', date: decimalDates.at(-1) },
		{
			grain: 'week',
			date: decimalDates[0],
			by_daytype: [
				{
					grain: 'weekday',
					observation_count: 1000 * decimalWeek.length,
					on_time: decimalWeek.reduce((sum, onTime) => sum + onTime, 0),
				},
			],
		},
	],
});

// Line 9002: a month of real-size history behind the evidence sections, with the longest stop
// names a phone must wrap (never clip). Generated from a seed, not a committed fixture.
let seed = 9002;
const next = (max) => {
	seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
	return seed % (max + 1);
};
const monthDates = Array.from({ length: 30 }, (_, day) =>
	new Date(Date.UTC(2026, 7, day + 1)).toISOString().slice(0, 10),
);
const counted = (grain, readings) => {
	const on_time = Math.round(readings * (0.78 + next(150) / 1000));
	return { grain, observation_count: readings, on_time, severe_pct: next(120) / 10 };
};
const cutFor = (grain, date, scale) => ({
	grain,
	date,
	by_shift: ['am_peak', 'midday', 'pm_peak', 'evening', 'night'].map((shift) =>
		counted(shift, scale * (2_000 + next(9_000))),
	),
	by_daytype: [counted('weekday', scale * 40_000), counted('weekend', scale * 9_000)],
});
const stopNames = [
	'Queen-Mary / Frère-André (Oratoire Saint-Joseph du Mont-Royal), quai en direction est',
	'Côte-des-Neiges / chemin de la Côte-Sainte-Catherine (Hôpital général juif)',
	'Station Université-de-Montréal / Édouard-Montpetit, débarcadère des autobus',
	'Boulevard Décarie / avenue Van Horne, arrêt temporaire pendant les travaux',
	'Édouard-Montpetit / avenue Louis-Colin (Pavillon Roger-Gaudry)',
	'Saint-Denis / Sherbrooke',
	'Queen-Mary / de la Côte-des-Neiges',
	'Côte-Sainte-Catherine / Dunlop',
	'Édouard-Montpetit / de Stirling',
	'Jean-Brillant / McKenna',
	'Decelles / Queen-Mary',
	'Station Snowdon (Queen-Mary / Westbury)',
	'Lacombe / Gatineau',
	'Darlington / Jean-Brillant',
	'Wilderton / Van Horne',
];
const stopCut = (grain, date) => ({
	grain,
	date,
	stops: stopNames.map((name, index) => ({
		id: `9002${String(index + 1).padStart(2, '0')}`,
		name,
		avg_delay_min: (60 - index * 3) / 10,
		observation_count: 400 + next(3_000),
		severe_pct: 64 - index * 3.7 + next(9) / 10,
		wilson_lo: 30 + index * 3,
		wilson_hi: 36 + index * 3,
	})),
});
const gapCut = (grain, date) => ({
	grain,
	date,
	headway: [
		['am_peak', 4],
		['midday', 10],
		['pm_peak', 4],
		['evening', 12],
		['night', 30],
	].map(([shift, scheduled]) => ({
		shift,
		scheduled_min: scheduled,
		observed_min: scheduled + next(40) / 10,
		bunched_pct: next(300) / 10,
		cov: next(90) / 100,
		observation_count: 150 + next(200),
	})),
});
const [monthStart, weekStart, closed] = [monthDates[0], monthDates.at(-7), monthDates.at(-1)];
files['/v1/stm/static/routes/9002.json'] = JSON.stringify({
	...b9['static/routes/24.json'],
	id: '9002',
	short: '9002',
	long: 'Long stop names and a month of history',
});
files['/v1/stm/historic/route_reliability/9002.json'] = JSON.stringify({
	...b9['historic/route_reliability/24.json'],
	id: '9002',
	// One explicit edition identity so copied links and their later openings can be checked.
	publish_generation_id: 'stm@2026-08-30T06:00:00Z',
	periods: monthDates.map((date) => ({ ...counted('day', 40_000 + next(20_000)), date })),
	periods_by_grain: [
		cutFor('day', closed, 1),
		cutFor('week', weekStart, 7),
		cutFor('month', monthStart, 30),
	],
	weak_stops_by_grain: [
		stopCut('day', closed),
		stopCut('week', weekStart),
		stopCut('month', monthStart),
	],
	headway_by_grain: [gapCut('day', closed), gapCut('week', weekStart), gapCut('month', monthStart)],
	cancellations: monthDates.map((date) => {
		const seen = 900 + next(300);
		return { grain: 'day', date, canceled_trip_days: next(60), total_trip_days: seen };
	}),
	skipped_stops: monthDates.map((date) => {
		const updates = 1_500_000 + next(900_000);
		return { date, skipped_stop_count: next(40_000), stop_time_update_count: updates };
	}),
});
// Reuse this generated line for provider/locale export journeys, including its server render.
for (const family of ['static/routes', 'historic/route_reliability']) {
	const shared = files[`/v1/stm/${family}/9002.json`];
	if (family === 'historic/route_reliability') {
		const route = JSON.parse(shared);
		route.publish_generation_id = String(route.publish_generation_id ?? '').replace(
			/^stm@/u,
			'octranspo@',
		);
		files[`/v1/octranspo/${family}/9002.json`] = JSON.stringify(route);
	} else {
		files[`/v1/octranspo/${family}/9002.json`] = shared;
	}
}
// A stop the server cannot read (not a stop file), so the page renders without it and the
// browser loads it: the layout spec serves the real file there, late.
files['/v1/stm/static/stops/UNSEEDED.json'] = '{}';

const heldOverviewResponses = new Set();
const server = createServer((request, response) => {
	// No Date header: the app anchors its clock to it, which would undo page.clock.
	response.sendDate = false;
	const url = new URL(request.url, 'http://127.0.0.1');
	if (request.method === 'POST' && url.pathname === '/__overview/release') {
		for (const send of heldOverviewResponses) send();
		response.writeHead(204).end();
		return;
	}
	if (url.pathname === '/measure' || url.pathname === '/ranking') {
		const result = url.searchParams.has('line') ? lineEngine(url) : overviewEngine(url);
		if (result.csv) {
			response.setHeader('content-type', 'text/csv; charset=utf-8');
			response.end(result.csv);
			return;
		}
		const { hold, body } = result;
		response.setHeader('content-type', 'application/json');
		const send = () => response.end(JSON.stringify(body));
		if (hold) {
			heldOverviewResponses.add(send);
			response.on('close', () => heldOverviewResponses.delete(send));
		} else send();
		return;
	}
	const body =
		process.env.TRANSIT_E2E_PANEL_SIZES === '1' && request.url.startsWith('/v1/')
			? files['/__layout/stale' + request.url]
			: files[request.url];
	response.writeHead(body ? 200 : 404, {
		'content-type': 'application/json',
		'access-control-allow-origin': process.env.TRANSIT_E2E_ORIGIN ?? 'http://127.0.0.1:4317',
	});
	response.end(body ?? '{}');
});
// Playwright's route.fetch reuses keep-alive sockets. With Node's 5 s default the server
// can close an idle socket just as the client reuses it, and the request fails with
// "socket hang up". Idle sockets stay open instead; the client still closes its own.
server.keepAliveTimeout = 0;
server.listen(Number(process.env.TRANSIT_E2E_DATA_PORT ?? 4318), '127.0.0.1');

// Opt-in layout variants leave the original fixtures unchanged for other specs.
const layoutFiles = { ...files };
layoutFiles['/v1/octranspo/live/vehicles.json'] = read('./octranspo-vehicles.json');
for (const [key, body] of Object.entries(b9)) {
	if (!['providers.json', 'manifest.json'].includes(key))
		layoutFiles[`/v1/stm/${key}`] = JSON.stringify(body);
}
const layoutManifest = JSON.parse(JSON.stringify(b9['manifest.json']));
layoutManifest.bbox = JSON.parse(files['/v1/stm/manifest.json']).bbox;
layoutManifest.files.live.ttl_s = 60;
layoutFiles['/v1/stm/manifest.json'] = JSON.stringify(layoutManifest);
// Preserve the fixture's actual lookup ids and trip/stop content.
for (const key of [
	'static/routes_index.json',
	'static/stops_index.json',
	'static/stops/S1.json',
	'live/trips.json',
	'live/stop_departures.json',
	'live/alerts.json',
])
	layoutFiles[`/v1/stm/${key}`] = files[`/v1/stm/${key}`];
const generated = JSON.parse(files['/v1/stm/live/trips.json']).generated_utc;
// Isolated variant: a confidence interval crossing the reliable threshold.
const hedgedReliability = structuredClone(b9['historic/route_reliability/24.json']);
hedgedReliability.periods = [
	{
		...hedgedReliability.periods[0],
		grain: 'day',
		date: '2026-06-15',
		otp_pct: 82,
		observation_count: 368,
		on_time: 302,
		wilson_lo: 78,
		wilson_hi: 86,
	},
];
hedgedReliability.periods_by_grain = [
	{ grain: 'day', date: '2026-06-15' },
	{
		grain: 'week',
		date: '2026-06-09',
		by_daytype: [{ grain: 'weekday', observation_count: 368, on_time: 302 }],
	},
];
files['/__layout/hedged/v1/stm/historic/route_reliability/24.json'] =
	JSON.stringify(hedgedReliability);
files['/__layout/hedged/v1/stm/historic/route_reliability/index.json'] = JSON.stringify({
	generated_utc: generated,
	route_ids: ['24'],
});
const hedgedRoutes = JSON.parse(files['/v1/stm/static/routes_index.json']);
hedgedRoutes.routes = hedgedRoutes.routes.filter(({ id }) => id === '24');
hedgedRoutes.routes.push({ id: '25', short: '25', long: 'Ontario', type: 3 });
files['/__layout/hedged/v1/stm/static/routes_index.json'] = JSON.stringify(hedgedRoutes);
layoutFiles['/v1/stm/historic/receipts/2026-08-29.json'] = JSON.stringify({
	generated_utc: generated,
	date: '2026-08-29',
	otp_pct: 82,
	avg_delay_min: 3.4,
	severe_pct: 11,
	affected_routes: 12,
	affected_stops: 340,
	alerts: 5,
	vehicles: 37,
	rider_impact_score: 7.2,
	worst_route: { id: '24', name: 'Sherbrooke', otp_delta_pts: -8 },
	worst_stop: { id: 'S1', name: 'Fixture stop', avg_delay_min: 6.1 },
});
const layoutReceipts = structuredClone(b9['historic/receipts/index.json']);
layoutReceipts.dates.push('2026-08-30');
layoutReceipts.available.push({ date: '2026-08-30', has_data: true, has_schedule: false });
layoutFiles['/v1/stm/historic/receipts/index.json'] = JSON.stringify(layoutReceipts);
layoutFiles['/v1/stm/historic/receipts/2026-08-30.json'] = JSON.stringify({
	generated_utc: generated,
	date: '2026-08-30',
	otp_pct: null,
	avg_delay_min: null,
	severe_pct: null,
	worst_route: null,
	worst_stop: null,
});
layoutFiles['/v1/stm/live/vehicles.json'] = JSON.stringify({
	generated_utc: generated,
	vehicles: [
		{
			id: 'layout-bus',
			lat: 45.51,
			lon: -73.59,
			route: '24',
			trip: 'T1',
			status: 'on_time',
			updated_utc: generated,
			reported_utc: generated,
			speed_kmh: 40,
			bearing: 90,
			occupancy: 'many_seats',
			delay_min: 0,
			next_stop: 'S1',
			next_stop_lat: 45.5,
			next_stop_lon: -73.6,
		},
	],
});
const route24 = JSON.parse(layoutFiles['/v1/stm/static/routes/24.json']);
route24.directions[0].shape = {
	type: 'LineString',
	coordinates: [
		[-73.61, 45.51],
		[-73.55, 45.51],
	],
};
layoutFiles['/v1/stm/static/routes/24.json'] = JSON.stringify(route24);
for (const state of ['fresh', 'stale', 'missing'])
	for (const [path, body] of Object.entries(layoutFiles)) {
		const parsed = JSON.parse(body);
		const normalize = (value) => {
			if (!value || typeof value !== 'object') return;
			for (const [key, item] of Object.entries(value)) {
				if (key === 'generated_utc') value[key] = generated;
				else normalize(item);
			}
		};
		normalize(parsed);
		if (state === 'missing' && path.includes('/historic/receipts/') && parsed.date)
			for (const key of ['affected_routes', 'affected_stops', 'alerts', 'otp_pct', 'avg_delay_min'])
				parsed[key] = null;
		if (state === 'missing' && path.endsWith('/live/vehicles.json'))
			for (const vehicle of parsed.vehicles)
				for (const key of [
					'occupancy',
					'delay_min',
					'speed_kmh',
					'next_stop',
					'next_stop_lat',
					'next_stop_lon',
				])
					vehicle[key] = null;
		if (state === 'missing' && path.endsWith('/live/network.json'))
			for (const key of [
				'on_time_pct',
				'delay_p50_min',
				'delay_p90_min',
				'coverage_pct',
				'occupancy_mix',
			])
				parsed[key] = null;
		files[`/__layout/${state}${path}`] = JSON.stringify(parsed);
	}

// Rich provider fixtures for desktop panel interaction tests, including server boot.
for (const [key, body] of Object.entries(files)) {
	if (!key.startsWith('/__layout/') || !key.includes('/stm/')) continue;
	const value = JSON.parse(body);
	if (key.endsWith('/manifest.json')) {
		value.provider = 'octranspo';
		value.display_name = 'OC Transpo';
		value.bbox = ottawa.fit_bounds;
	}
	if (key.endsWith('/live/vehicles.json'))
		for (const vehicle of value.vehicles) {
			vehicle.lon = -75.69;
			vehicle.lat = 45.41;
		}
	files[key.replace('/stm/', '/octranspo/')] = JSON.stringify(value);
}
