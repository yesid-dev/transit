import { expect, it } from 'vitest';
import type { RankingsRecord } from '#lib/server/engine.ts';
import { ranking } from '#lib/features/home/overviewRecord.fixture.ts';
import { recordMessage } from '../record/recordText.ts';
import { rankingMeasures, rankingSelection, reporting } from './rankingSelection.ts';
import { exclusionText, rankingRange, rankingSample, rankingValue } from './rankingText.ts';

const entry = { id: '24', classes: ['3:regular'], counts: {}, sample: 100 };
const row = {
	...entry,
	rank: 1,
	value: 0.48,
	range: { lower: 0.38, upper: 0.58, method: 'wilson_95' },
};
const answer: RankingsRecord = {
	...ranking,
	available_classes: ['3:regular'],
	ranked_count: 0,
	rows: [],
	excluded: [],
	range_notes: {},
	info: [{ minimum_sample: 30, text: { en: { definition: '' }, fr: { definition: '' } } }],
};

it('renders bounds in the engine’s units, including zero and negative bounds', () => {
	expect(rankingRange(row, 'on_time', 'en')).toBe('38.0% to 58.0%');
	expect(
		rankingRange(
			{ ...row, range: { lower: -32.5, upper: -27.5, method: 'histogram_half_bin' } },
			'median_delay',
			'fr',
		),
	).toBe('−0,5 min à −0,5 min');
	expect(
		rankingRange(
			{
				...row,
				range: { lower: null, upper: null, method: 'vehicle_reporting_uncertainty_unknown' },
			},
			reporting,
			'en',
		),
	).toBe('Unknown');
	expect(rankingValue(0, reporting, 'fr')).toBe('0,0');
});

it('only ranks vehicles on reporting gaps, including visits to old completion links', () => {
	expect(rankingMeasures.vehicle).toEqual([reporting]);
	const oldLink = new URLSearchParams({
		kind: 'vehicle',
		measure: 'vehicle_unfinished_trips_per_100_trips',
	});
	expect(rankingSelection('/repeat-offenders', oldLink).measure).toBe(reporting);
});

it('keeps a measured zero numerator and leaves a missing count out', () => {
	expect(
		rankingSample({ ...row, sample: 20.5, counts: { reporting_gaps: 0 } }, reporting, 'en'),
	).toBe('0 in 20.5 hours in service');
	expect(rankingSample({ ...row, counts: { on_time: null } }, 'on_time', 'fr')).toBe(
		'100 passages observés',
	);
});

it.each([
	['too_few_to_judge', 'Too few to judge', 'Trop peu pour juger'],
	['no_live_data', 'No live data', 'Aucune donnée en direct'],
	['not_measured', 'Not measured', 'Non mesuré'],
	['unknown', 'Unknown', 'Inconnu'],
	['not_tracked', 'Not tracked', 'Non suivi'],
] as const)('renders %s without inventing a value or a sample', (reason, en, fr) => {
	const excluded = { ...entry, sample: null, reason, reason_text: { en, fr } };
	expect(exclusionText(excluded, 'on_time', 'en')).toBe(en);
	expect(recordMessage({ kind: 'answer', answer: { ...answer, excluded: [excluded] } }, 'fr')).toBe(
		fr,
	);
});

it('shows the observed sample for an entry below the minimum', () => {
	expect(
		exclusionText(
			{
				...entry,
				sample: 2.25,
				reason: 'too_few_to_judge',
				reason_text: { en: 'Too few to judge', fr: 'Trop peu pour juger' },
			},
			reporting,
			'fr',
		),
	).toBe('Trop peu pour juger · 2,25 heures en service');
});

it('distinguishes no recorded days from an unknown result on recorded days', () => {
	expect(recordMessage({ kind: 'answer', answer }, 'en')).toBe('Unknown');
	expect(
		recordMessage(
			{
				kind: 'answer',
				answer: { ...answer, evidence: { ...answer.evidence, days_included: [] } },
			},
			'en',
		),
	).toBe('Not measured');
	expect(recordMessage({ kind: 'answer', answer: { ...answer, rows: [row] } }, 'en')).toBeNull();
});
