import { expect, it } from 'vitest';
import type { RankingsRecord } from '#lib/server/engine.ts';
import { ranking } from '#lib/features/home/overviewRecord.fixture.ts';
import { recordMessage } from '../record/recordText.ts';
import { rankingMeasures, rankingSelection, reporting } from './rankingSelection.ts';
import {
	classText,
	exclusionText,
	measureMeaning,
	rankedNoun,
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
	).toEqual(['0 times in 21 hours']);
	// "about 7 times an hour (155 times in 21 hours)": the rate per hour and where it comes from.
	expect(
		rankingCountLines({ ...row, sample: 21.47, counts: { reporting_gaps: 155 } }, reporting, 'fr'),
	).toEqual(['155 interruptions en 21 heures']);
	expect(rankingValue(721.9, reporting, 'en')).toBe('7.2');
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
		'times an hour it stopped reporting, the highest rate',
		'interruptions des signalements par heure, le taux le plus élevé',
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

it('says ranked lowest, never top-ranked, when the engine order differs from the order of values', () => {
	const ranked = { rows: [row, { ...row, value: 0.44 }], ranked_count: 2 };
	expect(rankingLead(ranked, row, 'on_time', '2 lines with enough to judge', 'en')).toBe(
		'is the on-time share ranked lowest among the 2 lines with enough to judge:',
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

it('names a low-coverage exclusion with its observed share, as the engine reports it', () => {
	// Line 872, STM, 18 to 24 Nov 2026: 516 of 1,560 scheduled stop events observed.
	const excluded = {
		...entry,
		id: '872',
		sample: 516,
		counts: { scheduled: 1560, classified: 516 },
		share_observed: 516 / 1560,
		low_coverage: true,
		reason: 'low_coverage' as const,
		reason_text: { en: 'Low coverage', fr: 'Faible couverture' },
	};
	expect(exclusionText(excluded, 'on_time', 'en')).toBe(
		'Low coverage: 33.1% of scheduled stop events observed',
	);
	expect(exclusionText(excluded, 'on_time', 'fr').replace(/\s/g, ' ')).toBe(
		'Faible couverture : 33,1 % des passages prévus observés',
	);
	const trips = { ...excluded, share_observed: undefined, share_eligible: 0.72 };
	expect(exclusionText(trips, 'cancelled_trips', 'en')).toBe(
		'Low coverage: status known for 72.0% of scheduled trips',
	);
});

it('says the on-time window as every other screen does and names a chosen class', () => {
	const engine = 'Share of stops from 60 seconds early to 300 seconds late, including both limits.';
	expect(measureMeaning('on_time', engine, 'en')).toBe(
		'Between 1 minute early and 5 minutes late, counted at each scheduled stop of each trip.',
	);
	expect(measureMeaning('on_time', engine, 'fr')).toContain('1 minute');
	expect(rankedNoun('line', '3:regular', ['3:regular', '3:night'], 'en')).toBe('regular lines');
	expect(rankedNoun('line', '3:regular', ['3:regular'], 'fr')).toBe('lignes régulières');
	expect(rankedNoun('line', 'all', [], 'en')).toBeNull();
	expect(rankedNoun('line', '3:regular', ['3:regular'], 'en', 1)).toBe('regular line');
	expect(rankedNoun('line', '3:frequent', ['3:frequent'], 'fr', 1)).toBe('ligne fréquente');
	expect(rankedNoun('line', '3:night', ['3:night'], 'fr', 1)).toBe('ligne de nuit');
	expect(rankedNoun('stop', null, [], 'en')).toBeNull();
});

it('never says top-ranked in either language', () => {
	for (const measure of rankingMeasures.line)
		for (const locale of ['en', 'fr'] as const) {
			const text = rankingLead(
				{ rows: [row, { ...row, value: 0.1 }], ranked_count: 2 },
				row,
				measure,
				'x',
				locale,
			);
			expect(text).not.toMatch(/top-ranked|en tête/);
		}
});
