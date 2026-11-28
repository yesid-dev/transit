import { expect, it } from 'vitest';
import type { RouteFile, Trip } from '#lib/v1/schemas/index.ts';
import { isoUtc } from '#lib/v1/schemas/types.ts';
import { vehicleDepartureTiming } from './vehicleDeparture.ts';

const instant = Date.parse('2026-11-25T12:38:00Z') / 1000;
const base: Trip = { status: 'on_time', route: '51' };
const route: RouteFile = {
	id: '51',
	generated_utc: isoUtc().parse('2026-11-25T00:00:00Z'),
	directions: [
		{
			dir: 1,
			stops: [
				{ id: 'destination', seq: 20 },
				{ id: 'origin', seq: 10 },
			],
		},
	],
};

it('prefers the published trip start time and preserves service-day clocks', () => {
	const trip = {
		...base,
		start_time: '07:38:00',
		scheduled_stops: [{ stop: 'origin', sequence: 10, departure: instant + 3600 }],
	};
	expect(vehicleDepartureTiming(trip, route, 1, 'en', 'America/Toronto')).toEqual({
		time: '07:38',
		origin: 'origin',
	});
});

it('uses the published scheduled departure when the update matches the timetable origin', () => {
	const trip = {
		...base,
		scheduled_stops: [
			{ stop: 'destination', sequence: 20, departure: instant + 1200 },
			{ stop: 'origin', sequence: 10, departure: instant },
		],
	};
	expect(vehicleDepartureTiming(trip, route, 1, 'en', 'America/Toronto')).toEqual({
		time: '07:38',
		origin: 'origin',
	});
});

it('does not treat a downstream prediction as the scheduled start', () => {
	const trip = {
		...base,
		stops: [{ stop: 'destination', eta_utc: isoUtc().parse('2026-11-25T12:38:00Z') }],
		scheduled_stops: [{ stop: 'destination', sequence: 20, departure: instant }],
	};
	expect(vehicleDepartureTiming(trip, route, 1, 'en', 'America/Toronto')).toEqual({
		time: null,
		origin: 'origin',
	});
	expect(vehicleDepartureTiming(trip, null, 1, 'en', 'America/Toronto')).toEqual({
		time: null,
		origin: undefined,
	});
});

it('requires a confirmed first stop when the route pattern is unavailable', () => {
	const timing = (sequence: number) =>
		vehicleDepartureTiming(
			{ ...base, scheduled_stops: [{ stop: 'origin', sequence, departure: instant }] },
			null,
			1,
			'en',
			'America/Toronto',
		);
	expect(timing(0)).toEqual({ time: '07:38', origin: 'origin' });
	expect(timing(1)).toEqual({ time: null, origin: undefined });
});

it('reads the timetable first departure by trip when the feed sends no start time', () => {
	const trip = {
		...base,
		first_departure: { stop: 'angrignon', departure: instant + 1800 },
		scheduled_stops: [{ stop: 'destination', sequence: 20, departure: instant }],
	};
	expect(vehicleDepartureTiming(trip, route, 1, 'en', 'America/Toronto')).toEqual({
		time: '08:08',
		origin: 'angrignon',
	});
	expect(vehicleDepartureTiming(trip, route, 1, 'fr', 'America/Toronto').time).toMatch(
		/^8\sh\s08$/u,
	);
	// An older publication without the field keeps the earlier reading.
	const { first_departure: _, ...older } = trip;
	expect(vehicleDepartureTiming(older, route, 1, 'en', 'America/Toronto')).toEqual({
		time: null,
		origin: 'origin',
	});
});
