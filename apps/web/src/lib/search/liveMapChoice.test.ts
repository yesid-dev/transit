import { expect, it } from 'vitest';
import { readLiveMapChoice, setLiveMapChoice } from './liveMapChoice';

it('round-trips a followed vehicle and a line trip without changing existing filters', () => {
	const params = new URLSearchParams('provider=stm&route=24&vehicle=123&status=late');
	const original = params.toString();
	setLiveMapChoice(params, { kind: 'vehicle', id: 'report:42/2' });
	expect(readLiveMapChoice(params)).toEqual({ kind: 'vehicle', id: 'report:42/2' });

	setLiveMapChoice(params, { kind: 'line', id: '24', trip: 'route 24:1' });
	expect(params.has('selectedVehicle')).toBe(false);
	expect(readLiveMapChoice(params)).toEqual({ kind: 'line', id: '24', trip: 'route 24:1' });

	setLiveMapChoice(params, null);
	expect(params.toString()).toBe(original);
	expect(readLiveMapChoice(params)).toBeNull();
});

it('ignores a trip without a line', () => {
	expect(readLiveMapChoice(new URLSearchParams('lineTrip=1'))).toBeNull();
});
