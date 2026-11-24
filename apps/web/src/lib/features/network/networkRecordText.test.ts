import { expect, it } from 'vitest';
import { measure } from '#lib/features/home/overviewRecord.fixture.ts';
import type { ScorecardAnswer } from '#lib/server/engine.ts';
import { networkMeasures, networkRows, networkUnmeasuredDays } from './networkRecordText.ts';

const base: ScorecardAnswer = {
	...measure(),
	value: {},
	info: [],
	evidence: {
		...measure().evidence,
		counts: {},
		dimension_states: {},
		capture_gap_days: {},
		days_not_measured_reasons: {},
	},
};

it('shows per-feed results, counts and too-few and untracked states', () => {
	const data: ScorecardAnswer = {
		...base,
		value: { poll_success: { trip_updates: 0.8, vehicle_positions: null } },
		evidence: {
			...base.evidence,
			counts: {
				poll_success: {
					trip_updates: { successful: 20, attempts: 25 },
					vehicle_positions: { successful: 3, attempts: 5 },
				},
			},
			dimension_states: {
				poll_success: { trip_updates: 'measured', vehicle_positions: 'too_few_to_judge' },
			},
		},
	};
	expect(networkRows('poll_success', data, 'en').rows).toEqual([
		['Trip updates', '80%', '20 / 25'],
		['Vehicle positions', 'Too few to judge', '3 / 5'],
		['Service alerts', 'Not tracked', ''],
	]);
});

it('keeps histogram overflow and a missing timestamp distinct', () => {
	const data: ScorecardAnswer = {
		...base,
		value: {
			feed_age_at_capture: {
				trip_updates: { median_seconds: 8.5, p90_seconds: 'over_10_minutes' },
				alerts: { median_seconds: null, p90_seconds: null },
			},
		},
		evidence: {
			...base.evidence,
			counts: {
				feed_age_at_capture: {
					trip_updates: { samples: 30 },
					alerts: { successful: 25, timestamped_successes: 0, samples: 0 },
				},
			},
			dimension_states: { feed_age_at_capture: { trip_updates: 'measured', alerts: 'unknown' } },
		},
	};
	const { rows } = networkRows('feed_age_at_capture', data, 'fr');
	expect(rows[0]).toEqual(['Mises à jour des trajets', '0,1 min', 'Plus de 10 min', '30']);
	expect(rows[2]).toEqual([
		'Avis de service',
		'Non suivi (aucun horodatage de publication)',
		'Non suivi (aucun horodatage de publication)',
		'',
	]);
});

it('keeps a declared unpublished vehicle field separate from measured zero', () => {
	const data: ScorecardAnswer = {
		...base,
		value: { vehicle_field_completeness: { occupancy: null, stop: 0 } },
		evidence: {
			...base.evidence,
			counts: { vehicle_field_completeness: { stop: { present_us: 0, reporting_us: 7200000000 } } },
			dimension_states: {
				vehicle_field_completeness: { occupancy: 'not_published', stop: 'measured' },
			},
		},
	};
	const { rows } = networkRows('vehicle_field_completeness', data, 'en');
	expect(rows).toContainEqual(['Occupancy', 'Not tracked (field not published)', '']);
	expect(rows).toContainEqual(['Stop', '0%', '0 / 2']);
});

it('shows dates and separate reasons when live coverage could not be measured', () => {
	const data: ScorecardAnswer = {
		...base,
		state: 'not_measured',
		value: { live_trip_coverage: null },
		evidence: {
			...base.evidence,
			days_measured: [],
			days_not_measured: ['2026-11-13', '2026-11-14'],
			days_not_measured_reasons: { '2026-11-13': 'no_raw_captures' },
			capture_gap_days: { live_trip_coverage: ['2026-11-14'] },
			counts: { live_trip_coverage: { scheduled: 100, never_seen: 5, never_seen_share: 0.05 } },
		},
	};
	expect(networkUnmeasuredDays('live_trip_coverage', data, 'en')).toEqual([
		['Nov 13, 2026', 'Not measured (No raw captures)'],
		['Nov 14, 2026', 'Capture interrupted'],
	]);
	expect(networkRows('live_trip_coverage', data, 'en').rows.map((row) => row.slice(1))).toEqual([
		['Not measured', ''],
		['Not measured', ''],
	]);
});

it('provides a bilingual rider explanation for each reading', () => {
	for (const { title, description } of Object.values(networkMeasures)) {
		expect(title[0]).not.toBe(title[1]);
		expect(description[0]).not.toBe(description[1]);
		for (const sentence of description) expect(sentence).toMatch(/^[^—]+\.$/);
	}
});
