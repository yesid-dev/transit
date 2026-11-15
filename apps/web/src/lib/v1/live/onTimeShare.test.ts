import { describe, expect, it } from 'vitest';
import { liveOnTimeShare } from './onTimeShare';

const network = (inService: number, readings: number, pct: number | null = 60) => ({
	vehicles_in_service: inService,
	on_time_pct: pct,
	status_dist: { on_time: 0, late: 0, severe: 0, early: 0, unknown: inService - readings },
});

describe('liveOnTimeShare', () => {
	it.each([
		['30 readings, all of 30 buses', 30, 30, 'share'],
		['29 readings, all of 29 buses', 29, 29, 'thin'],
		['exactly half of the buses', 80, 40, 'share'],
		['just under half of the buses', 81, 40, 'thin'],
		['the reported Ottawa moment, 10 of 328', 328, 10, 'thin'],
	] as const)('%s', (_case, inService, readings, kind) => {
		expect(liveOnTimeShare(network(inService, readings))).toMatchObject({
			kind,
			readings,
			inService,
		});
	});

	it('keeps the published share when it passes the floor', () => {
		expect(liveOnTimeShare(network(376, 340, 87))).toEqual({
			kind: 'share',
			pct: 87,
			readings: 340,
			inService: 376,
		});
	});

	it('reports absence, not a thin share, when no share or no bus exists', () => {
		expect(liveOnTimeShare(network(355, 0, null))).toEqual({ kind: 'absent' });
		expect(liveOnTimeShare(network(0, 0, null))).toEqual({ kind: 'absent' });
		expect(liveOnTimeShare(network(0, 0, 0))).toEqual({ kind: 'absent' });
	});
});
