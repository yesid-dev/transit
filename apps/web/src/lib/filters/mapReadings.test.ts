import { expect, it } from 'vitest';
import type { Vehicle } from '#lib/v1/schemas/vehicles.ts';
import { isoUtc } from '#lib/v1/schemas/types.ts';
import { mapReadingHours, matchMapVehicleReading } from './mapReadings';

const reading: Vehicle = {
	id: 'vehicle-1',
	route: '24',
	direction_id: 0,
	lat: 45.5,
	lon: -73.6,
	status: 'on_time',
	reported_utc: isoUtc().parse('2026-11-27T04:15:00Z'),
	updated_utc: isoUtc().parse('2026-11-27T13:00:00Z'),
};

it('uses the same named hours as the Record engine', () => {
	expect(mapReadingHours('morning')).toEqual([5, 9]);
	expect(mapReadingHours('evening')).toEqual([19, 24]);
});

it('matches a live reading by published route type, direction and local reporting hour', () => {
	const matches = matchMapVehicleReading(
		{ vehicleType: 3, direction: 0, timeOfDay: '22-6' },
		(id) => (id === '24' ? 3 : 1),
		'America/Toronto',
	);
	expect(matches(reading)).toBe(true);
	expect(matches({ ...reading, route: '1' })).toBe(false);
	expect(matches({ ...reading, direction_id: 1 })).toBe(false);
	expect(matches({ ...reading, reported_utc: isoUtc().parse('2026-11-27T11:00:00Z') })).toBe(false);
});
