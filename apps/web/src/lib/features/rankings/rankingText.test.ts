import { expect, it } from 'vitest';
import type { RankingsRecord } from '#lib/server/engine.ts';
import { ranking } from '#lib/features/home/overviewRecord.fixture.ts';
import { recordMessage } from '../record/recordText.ts';
import { rankingMeasures, rankingSelection, reporting } from './rankingSelection.ts';
import {
	classText,
	exclusionText,
	rankingCountLines,
	rankingLead,
	rankingRange,
	rankingValue,
	serviceClassDefinition,
} from './rankingText.ts';

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

it('keeps a measured zero count and shows trips only when reported', () => {
	expect(
		rankingCountLines({ ...row, sample: 20.5, counts: { reporting_gaps: 0 } }, reporting, 'en'),
	).toEqual(['20.5 hours in service', '0 interruptions']);
	expect(rankingCountLines(row, 'on_time', 'fr')).toEqual(['100 passages observés aux arrêts']);
	expect(rankingCountLines({ ...row, counts: { observed_trips: 1 } }, 'on_time', 'fr')).toEqual([
		'100 passages observés aux arrêts',
		'1 trajet',
	]);
});

it.each([
	['on_time', 'is the lowest on-time share', 'est la plus faible part à l’heure'],
	['late', 'is the highest late share', 'est la plus forte part en retard'],
	['early', 'is the highest early departure share', 'est la plus forte part de départs en avance'],
	['median_delay', 'is the longest median delay', 'est le retard médian le plus long'],
	['excess_wait_time', 'is the longest excess wait', 'est l’attente excédentaire la plus longue'],
	[
		'cancelled_trips',
		'is the highest cancelled trip share',
		'est la plus forte part de trajets annulés',
	],
	[
		'missing_trips',
		'is the highest missing trip share',
		'est la plus forte part de trajets manquants',
	],
	[
		reporting,
		'interruptions per 100 hours in service, the highest rate',
		'interruptions par 100 heures en service, le taux le plus élevé',
	],
] as const)('leads with the appropriate wording for %s', (measure, en, fr) => {
	const ranked = { rows: Array.from({ length: 20 }, () => row), ranked_count: 20 };
	expect(rankingLead(ranked, row, measure, '20 lines with enough to judge', 'en')).toBe(
		`${en} among the 20 lines with enough to judge:`,
	);
	expect(
		rankingLead(ranked, row, measure, '20 lignes avec assez de données pour conclure', 'fr'),
	).toBe(`${fr} parmi les 20 lignes avec assez de données pour conclure\u00a0:`);
});

it('says first-ranked when the engine order differs from the order of values', () => {
	const ranked = { rows: [row, { ...row, value: 0.44 }], ranked_count: 2 };
	expect(rankingLead(ranked, row, 'on_time', '2 lines with enough to judge', 'en')).toBe(
		'is the top-ranked on-time share among the 2 lines with enough to judge:',
	);
});

it('names class choices plainly and defines the engine rule', () => {
	expect(classText('all', 'en')).toBe('All lines');
	expect(classText('3:frequent', 'fr', ['3:regular', '3:frequent'])).toBe('Lignes fréquentes');
	expect(classText('1:frequent', 'en', ['1:frequent', '3:frequent'])).toBe(
		'Frequent lines (metro)',
	);
	expect(serviceClassDefinition('3:frequent', 'en')).toContain('10 minutes or less');
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
