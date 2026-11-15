import { describe, it, expect } from 'vitest';
import { selectStateCuts } from './stateCuts';
import { CANCEL_RATE_DOMAIN } from '#lib/features/reliability/domains.ts';

const labels = {
	delivered: 'Delivered',
	cancelled: 'Cancelled',
	silent: 'Silent',
	fmtSharePct: (v: number | null) => (v == null ? null : `${v.toFixed(1)}%`),
};

describe('selectStateCuts', () => {
	it('uses the explicit expanded basis without allocating beyond trips to a state', () => {
		const vm = selectStateCuts(
			{
				scheduledTripDays: 1,
				deliveredTripDays: 0,
				cancelledTripDays: 2,
				silentTripDays: 0,
				beyondScheduleTripDays: 1,
			},
			labels,
		);
		expect(vm.basis).toBe(2);
		expect(vm.rows.map((row) => row.value)).toEqual([0, 100, 0]);
	});
	it('withholds shares for a mismatched legacy receipt', () => {
		const vm = selectStateCuts(
			{
				scheduledTripDays: 1,
				deliveredTripDays: 2,
				cancelledTripDays: 0,
				silentTripDays: 0,
				completenessPct: 100,
			},
			labels,
		);
		expect(vm.mismatch).toBe(true);
		expect(vm.completeness).toBeNull();
		expect(vm.rows.every((row) => row.value === null)).toBe(true);
	});
	it('heroes the completeness number and computes delivered/cancelled/silent shares', () => {
		const vm = selectStateCuts(
			{
				scheduledTripDays: 100,
				deliveredTripDays: 80,
				cancelledTripDays: 5,
				silentTripDays: 15,
				completenessPct: 80,
				notReportedRouteCount: 3,
			},
			labels,
		);
		expect(vm.hasData).toBe(true);
		expect(vm.completeness).toBe(80);
		expect(vm.completenessDisplay).toBe('80.0%');
		expect(vm.rows.map((r) => r.key)).toEqual(['delivered', 'cancelled', 'silent']);
		expect(vm.rows[0].value).toBe(80);
		expect(vm.rows[0].domain).toBe(CANCEL_RATE_DOMAIN);
		expect(vm.rows[0].severity).toBe('watch');
		expect(vm.rows[2].severity).toBe('critical');
	});

	it('stands down on ramp-in (service_states absent → no fabricated 0)', () => {
		const vm = selectStateCuts(undefined, labels);
		expect(vm.hasData).toBe(false);
		expect(vm.completeness).toBeNull();
		expect(vm.rows.every((r) => r.value === null)).toBe(true);
	});

	it('withholds the comparison when its basis is absent', () => {
		const vm = selectStateCuts(
			{
				scheduledTripDays: null,
				deliveredTripDays: null,
				cancelledTripDays: 2,
				completenessPct: 91,
				notReportedRouteCount: null,
			},
			labels,
		);
		expect(vm.hasData).toBe(false);
		expect(vm.completeness).toBeNull();
		expect(vm.rows.every((r) => r.value === null)).toBe(true);
	});
});
