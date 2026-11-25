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
	['en', 'Downtown', '7.5 min'],
	['fr', 'Centre-ville', /^7,5\smin$/u],
] as const)('formats a scheduled direction and duration for %s', (locale, toward, silentFor) => {
	const rows = selectSilentTripRows({ silent_trips: [trip] }, schedule, locale, names);
	expect(rows).toEqual([
		{
			tripId: 'trip-1',
			routeId: 'route-1',
			line: '24',
			departure: '01:00',
			toward,
			silentFor: typeof silentFor === 'string' ? silentFor : expect.stringMatching(silentFor),
		},
	]);
});

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
	});
	expect(selectSilentTripRows({ silent_trips: [trip] }, null, 'en')?.[0]).toMatchObject({
		line: 'route-1',
		departure: '01:00',
		toward: null,
	});
});
