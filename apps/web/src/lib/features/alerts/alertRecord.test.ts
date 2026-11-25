import { describe, expect, it } from 'vitest';
import type { RecordCell } from '#lib/server/engine.ts';
import { alertDetailsAllowed, alertReadings } from './alertRecord.ts';

const cell: RecordCell = {
	state: 'measured',
	state_text: { en: 'Measured', fr: 'Mesuré' },
	value: { alerts: 2, alert_versions: 3, alert_hours: 1.25 },
	evidence: { counts: {}, days_included: ['2026-11-20'] },
};

describe('alert record readings', () => {
	it('distinguishes unavailable values, tracked zeros and very short active time', () => {
		const readings = (entry: RecordCell) =>
			alertReadings(entry, 'en').map(({ reading }) => reading);
		expect(
			readings({
				...cell,
				value: { alerts: 0, alert_versions: null, alert_hours: 0.001 },
			}),
		).toEqual(['0', 'Unknown', '< 0.01']);
		expect(
			readings({
				...cell,
				state: 'not_tracked',
				state_text: { en: 'Not tracked', fr: 'Non suivi' },
				value: { alerts: null, alert_versions: null, alert_hours: null },
			}),
		).toEqual(['Not tracked', 'Not tracked', 'Not tracked']);
	});

	it('limits agency messages to seven inclusive dates across month boundaries', () => {
		expect(alertDetailsAllowed({ from: '2026-10-28', to: '2026-11-03' })).toBe(true);
		expect(alertDetailsAllowed({ from: '2026-10-28', to: '2026-11-04' })).toBe(false);
		expect(alertDetailsAllowed({ from: '', to: '2026-11-03' })).toBe(false);
	});
});
