import { describe, expect, it } from 'vitest';
import { comparePeriods, newcombeDifference, wilsonBounds } from './periodComparison.ts';

describe('Wilson and Newcombe intervals', () => {
	it('matches the Wilson interval for 50 of 100 and retains exact endpoints', () => {
		const { lower, upper } = wilsonBounds({ onTime: 50, observed: 100 });
		expect(lower).toBeCloseTo(0.403832, 6);
		expect(upper).toBeCloseTo(0.596168, 6);
		expect(wilsonBounds({ onTime: 0, observed: 10 }).lower).toBe(0);
		expect(wilsonBounds({ onTime: 10, observed: 10 }).upper).toBe(1);
	});

	it('matches Newcombe Table II, method 10, examples A and E', () => {
		const a = newcombeDifference({ onTime: 56, observed: 70 }, { onTime: 48, observed: 80 });
		expect(a.lower).toBeCloseTo(0.0524, 4);
		expect(a.upper).toBeCloseTo(0.3339, 4);
		const e = newcombeDifference({ onTime: 0, observed: 10 }, { onTime: 0, observed: 20 });
		expect(e.lower).toBeCloseTo(-0.1611, 4);
		expect(e.upper).toBeCloseTo(0.2775, 4);
	});
});

describe('period comparison', () => {
	const baseline = {
		onTime: 75000,
		observed: 100000,
		days: 5,
		measuredDays: 4,
		observedShare: 0.6,
	};

	it('requires adequate measured days, observed events and similar observed shares', () => {
		for (const previous of [
			{ ...baseline, measuredDays: 3 },
			{ ...baseline, observed: 99, onTime: 74 },
			{ ...baseline, observedShare: 0.44 },
		])
			expect(comparePeriods(baseline, previous)).toBeNull();
		expect(comparePeriods(baseline, { ...baseline, observedShare: 0.45 })?.direction).toBe('same');
	});

	it('requires both one percentage point and an interval excluding zero', () => {
		expect(comparePeriods({ ...baseline, onTime: 75999 }, baseline)?.direction).toBe('same');
		expect(comparePeriods({ ...baseline, onTime: 76000 }, baseline)?.direction).toBe('higher');
		expect(comparePeriods({ ...baseline, onTime: 74000 }, baseline)?.direction).toBe('lower');
		expect(
			comparePeriods(
				{ ...baseline, onTime: 76, observed: 100 },
				{ ...baseline, onTime: 75, observed: 100 },
			)?.direction,
		).toBe('same');
	});
});
