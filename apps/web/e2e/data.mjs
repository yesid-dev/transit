import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { lineEngine } from './line-engine.mjs';
import { finderEngine } from './finder-engine.mjs';
import { overviewEngine, overviewNamedLines } from './overview-engine.mjs';
import { rankingsEngine } from './rankings-engine.mjs';
import { stopEngine } from './stop-engine.mjs';
import { networkEngine, networkFixtures } from './network-engine.mjs';
import { vehicleEngine } from './vehicle-engine.mjs';
import { departureDailyEngine } from './departure-daily-engine.mjs';
import { alertsEngine } from './alerts-engine.mjs';

const read = (file) => readFileSync(new URL(file, import.meta.url));
const methodCatalog = read('method-catalog.json');
const cleanTableHealth = JSON.parse(read('clean-table-health.json'));
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

const sourceCredits = {
	stm: {
		en: 'Source: Société de transport de Montréal (STM), CC BY 4.0.',
		fr: 'Source : Société de transport de Montréal (STM), CC BY 4.0.',
	},
	octranspo: {
		en: 'Contains information licensed under the Open Government Licence – City of Ottawa.',
		fr: 'Contient de l’information visée par la Licence du gouvernement ouvert – Ville d’Ottawa.',
	},
};

const heldResponsesByFixture = new Map();
const dailyMessageHolds = new Set();
const server = createServer((request, response) => {
	// No Date header: the app anchors its clock to it, which would undo page.clock.
	response.sendDate = false;
	const url = new URL(request.url, 'http://127.0.0.1');
	if (url.pathname === '/v2/how-we-measure' && !url.search) {
		response.writeHead(200, { 'content-type': 'application/json' }).end(methodCatalog);
		return;
	}
	if (url.pathname === '/v2/health') {
		response.writeHead(200, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ engine: 'ok' }));
		return;
	}
	if (url.pathname === '/v2/cities' && !url.search) {
		const { default_provider, providers } = JSON.parse(files['/v1/providers.json']);
		response.writeHead(200, { 'content-type': 'application/json' }).end(
			JSON.stringify({
				default_provider,
				providers: providers.map((provider) => ({
					...provider,
					attribution: JSON.parse(files[`/v1/${provider.id}/manifest.json`]).attribution,
					timezone: 'America/Toronto',
					download_licence: { attribution: sourceCredits[provider.id] },
					bounds: provider.max_bounds,
					...(provider.id === 'octranspo'
						? { name_separators: { ends: '<>', languages: '~', language_order: ['en', 'fr'] } }
						: {}),
					lines_without_live_data: [
						{ route_types: [provider.id === 'stm' ? 1 : 0], route_ids: [] },
					],
				})),
			}),
		);
		return;
	}
	const live = /^\/v2\/([a-z0-9_-]+)\/(live|live-trips)$/.exec(url.pathname);
	if (live) {
		const [, city] = live;
		if (!['stm', 'octranspo'].includes(city)) {
			response.writeHead(404).end();
			return;
		}
		const timestamp = new Date().toISOString();
		const feed = (family, limit) => ({
			family,
			captured_at: timestamp,
			source_at: timestamp,
			fresh_for_seconds: limit,
			source_lag_seconds: 0,
			read_failed: false,
		});
		if (live[2] === 'live-trips') {
			const { generated_utc, trips } = JSON.parse(files['/v1/stm/live/trips.json']);
			const { stops: departures } = JSON.parse(files['/v1/stm/live/stop_departures.json']);
			const stopScope = url.searchParams.get('stop');
			const tripScope = url.searchParams.get('trip');
			const lineScope = url.searchParams.get('line');
			const tripUpdate = (id, route, delay, stops) => ({
				trip_id: id,
				route_id: route,
				direction_id: null,
				start_date: null,
				start_time: null,
				relationship: 0,
				delay: delay == null ? null : delay * 60,
				stops: stops.map(({ stop, eta_utc, delay_min }, i) => ({
					stop_id: stop,
					sequence: i + 1,
					arrival: null,
					departure: Date.parse(eta_utc) / 1000,
					arrival_delay: null,
					departure_delay: delay_min == null ? null : delay_min * 60,
					relationship: 0,
				})),
			});
			const trip_updates = stopScope
				? (departures[stopScope] ?? []).map((row, i) =>
						tripUpdate(row.trip ?? `T${i + 1}`, row.route, row.delay_min, [
							{ ...row, stop: stopScope },
						]),
					)
				: Object.entries(trips)
						.filter(([id, trip]) => (tripScope ? id === tripScope : trip.route === lineScope))
						.map(([id, trip]) => tripUpdate(id, trip.route, trip.delay_min, trip.stops ?? []));
			response.writeHead(200, { 'content-type': 'application/json' }).end(
				JSON.stringify({
					version: 2,
					city,
					feed: {
						...feed('trip_updates', 90),
						captured_at: generated_utc,
						source_at: generated_utc,
					},
					trip_updates,
				}),
			);
			return;
		}
		const vehicle = {
			id: 'sample-report',
			vehicle_id: '40061',
			trip_id: 'T1',
			start_date: null,
			start_time: null,
			route_id: '24',
			direction_id: null,
			latitude: 45.51,
			longitude: -73.59,
			bearing: 90,
			speed_mps: 10,
			stop_id: 'S1',
			stop_sequence: 1,
			status: 1,
			occupancy: 2,
			occupancy_percentage: null,
			observed_at: timestamp,
			delay: 240,
		};
		if (city === 'octranspo') Object.assign(vehicle, { latitude: 45.41, longitude: -75.69 });
		response.writeHead(200, { 'content-type': 'application/json' }).end(
			JSON.stringify({
				version: 2,
				city,
				published_at: timestamp,
				stable_vehicle_ids: true,
				feeds: {
					vehicle_positions: feed('vehicle_positions', 60),
					trip_updates: feed('trip_updates', 90),
					...(city === 'stm' ? { i3_alerts: feed('alerts', 900) } : {}),
				},
				vehicle_positions: [vehicle],
				alerts: city === 'stm' ? [] : null,
			}),
		);
		return;
	}
	const scheduleMap = /^\/v2\/([^/]+)\/schedule-map$/.exec(url.pathname);
	if (scheduleMap) {
		const [, city] = scheduleMap;
		const routePrefix = `/v1/${city}/static/routes/`;
		const route_shapes = Object.fromEntries(
			Object.entries(files)
				.filter(([key]) => key.startsWith(routePrefix))
				.map(([, body]) => JSON.parse(body))
				.filter((route) => route.id && route.directions?.some(({ shape }) => shape))
				.map((route) => [route.id, route.directions]),
		);
		if (city === 'stm') {
			route_shapes['1-373'] = [
				{
					dir: 0,
					headsign: 'Rail terminal',
					shape: {
						type: 'LineString',
						coordinates: [
							[-73.6, 45.5],
							[-73.59, 45.51],
						],
					},
					stops: [{ id: 'S1', seq: 1 }],
				},
			];
		}
		const lines = url.searchParams.get('lines');
		const selected = lines ? new Set(JSON.parse(lines)) : null;
		response.writeHead(200, { 'content-type': 'application/json' }).end(
			JSON.stringify({
				schedule: {
					date: '2026-11-21',
					route_shapes: selected
						? Object.fromEntries(Object.entries(route_shapes).filter(([id]) => selected.has(id)))
						: route_shapes,
				},
			}),
		);
		return;
	}
	const search = /^\/v2\/([^/]+)\/(search-index|schedule-index)$/.exec(url.pathname);
	if (search && !url.search) {
		const [, city, kind] = search;
		const data = JSON.parse(
			files[`/v1/${city}/static/routes_index.json`] ?? read('routes-index.json'),
		);
		const stops = JSON.parse(
			files[`/v1/${city}/static/stops_index.json`] ?? read('stops-index.json'),
		);
		const route = JSON.parse(
			files[`/v1/${city}/static/routes/24.json`] ?? files['/v1/stm/static/routes/24.json'],
		);
		const stopsForLine = route.directions.flatMap(({ stops }) => stops);
		const fromRoute = Array.from(
			new Map(
				stopsForLine.map(({ id, name }) => [
					id,
					{ id, name, code: null, lat: 45.5, lon: -73.6, routes: ['24'] },
				]),
			).values(),
		);
		const editionStops = new Map(stops.stops.map((stop) => [stop.id, stop]));
		const editionRoutes = new Map(data.routes.map((entry) => [entry.id, entry]));
		const routeDirections = { 24: route.directions };
		if (kind === 'search-index') {
			editionRoutes.set('display-names', {
				id: 'display-names',
				short: '501',
				long: 'Waller <> Hospital ~ Hôpital',
				type: 3,
			});
		}
		for (const stop of fromRoute) {
			if (!editionStops.has(stop.id)) editionStops.set(stop.id, stop);
		}
		if (city === 'stm' && kind === 'schedule-index') {
			for (const line of overviewNamedLines) editionRoutes.set(line.id, line);
			for (const [key, body] of Object.entries(files)) {
				if (key.startsWith('/v1/stm/static/routes/')) {
					const { id, short, long, type, directions = [] } = JSON.parse(body);
					if (!editionRoutes.has(id)) editionRoutes.set(id, { id, short, long, type });
					routeDirections[id] = directions;
					for (const { stops = [] } of directions)
						for (const { id: stopId, name } of stops)
							if (!editionStops.has(stopId))
								editionStops.set(stopId, {
									id: stopId,
									name: name ?? stopId,
									lat: 45.5,
									lon: -73.6,
									routes: [id],
								});
				}
				if (key.startsWith('/v1/stm/static/stops/')) {
					const { id, name, code, lat, lon, routes_served, wheelchair_boarding } = JSON.parse(body);
					if (Number.isFinite(lat) && Number.isFinite(lon))
						editionStops.set(id, {
							id,
							name,
							code,
							lat,
							lon,
							routes: routes_served,
							wheelchair_boarding,
						});
				}
			}
			routeDirections['1-373'] = [
				{ dir: 0, headsign: 'Rail terminal', stops: [{ id: 'S1', seq: 1 }] },
			];
			// Keep the keyboard pagination case independent of the search index fixture.
			for (let n = 1; n <= 25; n++) {
				const id = `pagination-stop-${n}`;
				editionStops.set(id, {
					id,
					name: `Pagination sample ${n}`,
					code: String(99000 + n),
					lat: 45.5,
					lon: -73.6,
					routes: [],
				});
			}
		}
		response.writeHead(200, { 'content-type': 'application/json' }).end(
			JSON.stringify({
				schedule: {
					date: '2026-11-21',
					routes: [...editionRoutes.values()],
					...(kind === 'schedule-index'
						? {
								route_directions: Object.fromEntries(
									Object.entries(routeDirections).map(([id, directions]) => [
										id,
										directions.map(({ dir, headsign, stops }) => ({ dir, headsign, stops })),
									]),
								),
							}
						: {}),
					stops: [
						...editionStops.values(),
						{
							id: 'clean-search-stop',
							name: 'Crémazie Clean',
							code: '98765',
							lat: 45.5,
							lon: -73.6,
							routes: [],
						},
					],
				},
				...(kind === 'search-index' ? { vehicles: [{ id: '40061' }], vehicle_state: 'ready' } : {}),
			}),
		);
		return;
	}
	const health = /^\/v2\/([^/]+)\/data-health$/.exec(url.pathname);
	if (health) {
		const from = url.searchParams.get('from');
		const to = url.searchParams.get('to');
		response.writeHead(200, { 'content-type': 'application/json' }).end(
			JSON.stringify({
				...cleanTableHealth,
				city: health[1],
				from,
				to,
				days: cleanTableHealth.days.filter(
					({ service_date }) => service_date >= from && service_date <= to,
				),
			}),
		);
		return;
	}
	if (
		/^\/v2\/[^/]+\/measure$/.test(url.pathname) &&
		url.searchParams.get('measure') === 'fixture_delay' &&
		url.searchParams.get('format') === 'csv'
	) {
		const header = url.searchParams.get('lang') === 'fr' ? 'Mesure,Valeur' : 'Measure,Value';
		response
			.writeHead(200, { 'content-type': 'text/csv; charset=utf-8' })
			.end(`${header}\nfixture_delay,19\n`);
		return;
	}
	if (request.method === 'POST' && url.pathname === '/__overview/hold') {
		const fixture = url.searchParams.get('fixture');
		if (fixture) dailyMessageHolds.add(fixture);
		response.writeHead(fixture ? 204 : 400).end();
		return;
	}
	if (request.method === 'POST' && url.pathname === '/__overview/release') {
		const fixture = url.searchParams.get('fixture') ?? 'overview';
		dailyMessageHolds.delete(fixture);
		const held = heldResponsesByFixture.get(fixture);
		heldResponsesByFixture.delete(fixture);
		for (const send of held ?? []) send();
		response.writeHead(204).end();
		return;
	}
	const question = /^\/v2\/([^/]+)\/(measure|ranking)$/.exec(url.pathname);
	if (question) {
		url.pathname = `/${question[2]}`;
		url.searchParams.set('city', question[1]);
		const dailyFixture = ['2026-11-17', '2026-11-18'].includes(url.searchParams.get('from'));
		const scope = request.headers['x-transit-fixture-scope'];
		const dailyMessageHold = dailyMessageHolds.has(scope) ? scope : undefined;
		const finderFixture =
			question[2] === 'measure' && ['line', 'stop_id'].includes(url.searchParams.get('group'));
		const alertFixture =
			question[2] === 'measure' &&
			url.searchParams.get('measure') === 'alert_counts' &&
			!['2026-11-17', '2026-11-18'].includes(url.searchParams.get('from')) &&
			!url.searchParams.has('line') &&
			!url.searchParams.has('stop');
		const isNetwork =
			question[2] === 'measure' && Object.hasOwn(networkFixtures, url.searchParams.get('measure'));
		const result = isNetwork
			? networkEngine(url)
			: alertFixture
				? alertsEngine(url)
				: question[2] === 'measure' && url.searchParams.get('measure')?.startsWith('vehicle')
					? vehicleEngine(url)
					: url.searchParams.has('departure')
						? departureDailyEngine(url)
						: url.searchParams.has('stop')
							? stopEngine(url)
							: url.searchParams.has('line')
								? lineEngine(url)
								: question[2] === 'ranking' && url.searchParams.get('limit') === '500'
									? rankingsEngine(url)
									: finderFixture
										? finderEngine(url)
										: dailyFixture
											? departureDailyEngine(url, dailyMessageHold)
											: overviewEngine(url);
		if (result.csv) {
			response.setHeader('content-type', 'text/csv; charset=utf-8');
			response.end(result.csv);
			return;
		}
		const { hold, body, status = 200, headers = {} } = result;
		response.writeHead(status, { 'content-type': 'application/json', ...headers });
		const send = () => response.end(JSON.stringify(body));
		if (hold) {
			// Named holds survive release calls from other specs sharing this server.
			const fixture = hold === true ? 'overview' : hold;
			const held = heldResponsesByFixture.get(fixture) ?? new Set();
			held.add(send);
			heldResponsesByFixture.set(fixture, held);
			response.on('close', () => held.delete(send));
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
