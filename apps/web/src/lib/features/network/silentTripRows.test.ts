import { expect, it } from 'vitest';
import { selectSilentTripRows } from './silentTripRows';

const trip = {
	trip_id: 'trip-1',
	route_id: 'route-1',
	direction_id: 0,
	departure: { service_seconds: 90000, local_time: '01:00' },
	silent_since: null,
	silent_for_seconds: 450,
};
const schedule = {
	routes: [{ id: 'route-1', short: '24', long: 'Main', type: 3 }],
	route_directions: {
		'route-1': [{ dir: 0, headsign: 'Downtown ~ Centre-ville', stops: [] }],
	},
};
const names = { ends: '<>', languages: '~', language_order: ['en', 'fr'] as ['en', 'fr'] };

it.each([
	['en', 'Downtown', 'toward Downtown', '01:00', '7 min'],
	['fr', 'Centre-ville', 'vers Centre-ville', '1 h', /^7\smin$/u],
] as const)(
	'formats a scheduled direction, departure and duration for %s',
	(locale, toward, heading, departure, silentFor) => {
		const rows = selectSilentTripRows({ silent_trips: [trip] }, schedule, locale, names);
		expect(rows).toEqual([
			{
				tripId: 'trip-1',
				routeId: 'route-1',
				line: '24',
				departure,
				toward,
				heading,
				silentFor: typeof silentFor === 'string' ? silentFor : expect.stringMatching(silentFor),
			},
		]);
	},
);

it.each([
	['en', 'Station Laurier (Est)', 'toward Station Laurier (Est)', 'East', 'toward the east'],
	['fr', 'Station Laurier (est)', 'vers Station Laurier (est)', 'Est', 'vers l’est'],
] as const)(
	'writes a compass headsign as its terminus, or the compass word without one, in %s',
	(locale, cell, sentence, bareCell, bareSentence) => {
		const compass = {
			routes: schedule.routes,
			route_directions: { 'route-1': [{ dir: 0, headsign: 'Est', stops: [] }] },
		};
		const termini = (_: string, sign: string) =>
			sign === 'Est' ? 'Station Laurier (Est)' : undefined;
		const [row] = selectSilentTripRows(
			{ silent_trips: [trip] },
			compass,
			locale,
			undefined,
			termini,
		)!;
		expect(row).toMatchObject({ toward: cell, heading: sentence });
		const [bare] = selectSilentTripRows({ silent_trips: [trip] }, compass, locale)!;
		expect(bare).toMatchObject({ toward: bareCell, heading: bareSentence });
	},
);

it('keeps absent measurements and ambiguous destinations separate from an empty list', () => {
	expect(selectSilentTripRows({}, null, 'en')).toBeNull();
	expect(selectSilentTripRows({ silent_trips: [] }, null, 'en')).toEqual([]);
	const branched = {
		...schedule,
		route_directions: {
			'route-1': [
				...schedule.route_directions['route-1'],
				{ dir: 0, headsign: 'Airport', stops: [] },
			],
		},
	};
	expect(selectSilentTripRows({ silent_trips: [trip] }, branched, 'en')?.[0]).toMatchObject({
		line: '24',
		toward: null,
		heading: null,
	});
	expect(selectSilentTripRows({ silent_trips: [trip] }, null, 'en')?.[0]).toMatchObject({
		line: 'route-1',
		departure: '01:00',
		toward: null,
	});
});
