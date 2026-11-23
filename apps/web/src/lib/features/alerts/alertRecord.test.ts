import { describe, expect, it } from 'vitest';
import type { RecordCell, RecordSeries } from '#lib/server/engine.ts';
import { alertDetailsAllowed, alertReadings, alertRecordRows } from './alertRecord.ts';

const cell: RecordCell = {
	state: 'measured',
	state_text: { en: 'Measured', fr: 'Mesuré' },
	value: { alerts: 2, alert_versions: 3, alert_hours: 1.25 },
	evidence: { counts: {}, days_included: ['2026-11-20'] },
};

function series(...cells: RecordSeries['cells']): RecordSeries {
	return {
		cells,
		coverage_note: null,
		evidence: {
			start_date: '2026-11-20',
			end_date: '2026-11-20',
			days_included: ['2026-11-20'],
			days_measured: ['2026-11-20'],
			days_not_measured: [],
			method_version: 'alert-counts-v1',
			cleaning_versions: [7],
			query_ms: 8,
		},
	};
}

describe('alert record readings', () => {
	it('localizes published effects and durations while keeping unknown effects visible', () => {
		expect(
			alertRecordRows(
				series({ ...cell, key: { effect: 'DETOUR' } }, { ...cell, key: { effect: null } }),
				'effect',
				'fr',
				(id) => id,
			),
		).toEqual([
			['Détour', '2', '3', '1,25'],
			['Inconnu', '2', '3', '1,25'],
		]);
	});

	it('uses the local hour key and preserves a missing day without rendering zeros', () => {
		const missing = {
			...cell,
			state: 'not_measured' as const,
			state_text: { en: 'Not measured', fr: 'Non mesuré' },
			value: { alerts: null, alert_versions: null, alert_hours: null },
		};
		expect(
			alertRecordRows(series({ ...missing, key: { hour: 7 } }), 'hour', 'en', (id) => id),
		).toEqual([['07:00', 'Not measured', 'Not measured', 'Not measured']]);
	});

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
