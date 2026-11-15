import { describe, it, expect } from 'vitest';
import { selectHeadlineKpis } from './headlineKpis';

const labels = {
	onTime: 'On-time',
	avgDelay: 'Average delay',
	severe: 'Severe delays',
	fmtPct: (v: number | null | undefined) => (v == null ? null : `${v}%`),
	fmtMin: (v: number | null | undefined) => (v == null ? null : `${v} min`),
	fmtSeverePct: (v: number | null | undefined) => (v == null ? null : `${v.toFixed(1)}%`),
};

describe('selectHeadlineKpis', () => {
	it('builds the three reliability KPIs without promoting the legacy impact score', () => {
		const receipt = { onTimePct: 82, meanDelayMin: 3.4, severePct: 4.2, rider_impact_score: 7.2 };
		const vms = selectHeadlineKpis(receipt, labels);
		expect(vms.map((v) => v.key)).toEqual(['otp', 'avgDelay', 'severe']);
		expect(vms[0].value).toBe('82%');
		expect(vms[2].value).toBe('4.2%');
		expect(vms[0].size).toBe('lg');
		expect(vms[2].size).toBe('md');
	});

	it('renders null (honest-absence chip) for a null reading, never a fabricated 0', () => {
		const vms = selectHeadlineKpis(
			{ onTimePct: null, meanDelayMin: null, severePct: null },
			labels,
		);
		for (const v of vms) expect(v.value).toBeNull();
	});

	it('keeps a real measured 0 as a real 0', () => {
		const vms = selectHeadlineKpis({ onTimePct: 0, meanDelayMin: 0, severePct: 0 }, labels);
		expect(vms[0].value).toBe('0%');
		expect(vms[1].value).toBe('0 min');
	});
});
