import { describe, it, expect } from 'vitest';
import { selectReceiptTimeOfDay } from './timeOfDay';
import { SEVERE_DOMAIN } from '#lib/features/reliability/domains.ts';

const labels = { shiftLabel: (s: string) => s };

describe('selectReceiptTimeOfDay', () => {
	it('ranks shifts worst-first by severe share on the FIXED SEVERE_DOMAIN', () => {
		const vm = selectReceiptTimeOfDay(
			[
				{
					shift: 'am_peak',
					severePct: 5,
				},
				{
					shift: 'pm_peak',
					severePct: 11.1,
				},
			],
			labels,
		);
		expect(vm.hasTimeOfDay).toBe(true);
		expect(vm.rows.map((r) => r.key)).toEqual(['pm_peak', 'am_peak']);
		expect(vm.rows[0].domain).toBe(SEVERE_DOMAIN);
		expect(vm.rows[0].display).toBe('11.1%');
		expect(vm.rows[0].severity).toBe('critical');
	});

	it('secondary-sorts equal shares by canonical shift order', () => {
		const vm = selectReceiptTimeOfDay(
			[
				{
					shift: 'pm_peak',
					severePct: 5,
				},
				{
					shift: 'am_peak',
					severePct: 5,
				},
			],
			labels,
		);
		expect(vm.rows.map((r) => r.key)).toEqual(['am_peak', 'pm_peak']);
	});

	it('drops a null-share shift (no fabricated-0 ranking)', () => {
		const vm = selectReceiptTimeOfDay(
			[
				{
					shift: 'am_peak',
					severePct: null,
				},
				{ shift: 'night', severePct: 2 },
			],
			labels,
		);
		expect(vm.rows.map((r) => r.key)).toEqual(['night']);
	});

	it('stands down on ramp-in (by_shift absent/empty)', () => {
		expect(selectReceiptTimeOfDay(undefined, labels).hasTimeOfDay).toBe(false);
		expect(selectReceiptTimeOfDay([], labels).hasTimeOfDay).toBe(false);
	});
});
