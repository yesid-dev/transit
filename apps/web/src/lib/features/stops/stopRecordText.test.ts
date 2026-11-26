import { expect, it } from 'vitest';
import { measure, stateText } from '#lib/features/home/overviewRecord.fixture.ts';
import { punctualityBands, recordMessage } from '#lib/features/record/recordText.ts';
import type { RecordMeasure } from '#lib/server/engine.ts';
import {
	stopAccessibility,
	stopAnswer,
	stopCitation,
	stopComparison,
	stopCoverageGap,
} from './stopRecordText.ts';

const base = measure();
const answer: RecordMeasure = {
	...base,
	value: { early: 0, on_time: 0.8, late: 0.2 },
	evidence: {
		...base.evidence,
		share_observed: 0.5,
		counts: { early: 0, on_time: 80, late: 20, classified: 100, scheduled: 200 },
	},
};

it('explains low coverage once and retains the sample and threshold in both languages', () => {
	const gap: RecordMeasure = {
		...answer,
		state: 'not_measured',
		evidence: { ...answer.evidence, coverage_reason: 'insufficient_coverage', low_coverage: true },
	};
	expect(stopCoverageGap(gap, 'en', false, 0.6)).toBe(
		'100 of 200 scheduled stop events were observed here on these dates. At least 60.0% of scheduled stop events must be observed.',
	);
	expect(stopCoverageGap(gap, 'fr', false, 0.6)).toMatch(
		/^100 des 200 passages prévus ont été observés ici à ces dates\. Il faut observer au moins 60,0\s% des passages prévus\.$/,
	);
	const none: RecordMeasure = {
		...gap,
		evidence: { ...gap.evidence, counts: { ...gap.evidence.counts, classified: 0, scheduled: 1 } },
	};
	expect(stopCoverageGap(none, 'en', false, 0.25)).toBe(
		'No stop event was observed here on these dates: 1 was scheduled. At least 25.0% of scheduled stop events must be observed.',
	);
	expect(stopCoverageGap(none, 'fr', false, 0.25)).toMatch(
		/^Aucun passage n’a été observé ici à ces dates\u00a0: 1 était prévu\. Il faut observer au moins 25,0\s% des passages prévus\.$/,
	);
	expect(stopCoverageGap(answer, 'en')).toBeNull();
});

it('uses the engine dates, count and denominator in both locales', () => {
	expect(stopAnswer(answer, 'en')).toMatch(/8 to 14 Nov 2026, 80\.0%.*\(80 of 100\)/);
	expect(stopAnswer(answer, 'fr')).toMatch(/du 8 au 14 nov. 2026, 80,0\s%.*\(80 sur 100\)/);
	expect(punctualityBands(answer, 'en').map(({ reading }) => reading)).toEqual([
		'0.0% (0/100) · 50.0% of 200 scheduled stops observed',
		'80.0% (80/100) · 50.0% of 200 scheduled stops observed',
		'20.0% (20/100) · 50.0% of 200 scheduled stops observed',
	]);
});

it.each(['no_live_data', 'not_measured', 'too_few_to_judge', 'not_tracked', 'unknown'] as const)(
	'preserves %s even if the engine returns counts',
	(state) => {
		const missing = { ...answer, state, state_text: stateText[state] };
		expect(stopAnswer(missing, 'en')).toBe(stateText[state].en);
		expect(recordMessage({ kind: 'answer', answer: missing }, 'fr')).toBe(stateText[state].fr);
		expect(punctualityBands(missing, 'fr').map(({ reading }) => reading)).toEqual(
			Array(3).fill(stateText[state].fr),
		);
	},
);

it.each<[Record<string, number>, string, string]>([
	[{ stops_accessible: 1 }, 'Accessible', 'Accessible'],
	[{ stops_not_accessible: 1 }, 'Not accessible', 'Non accessible'],
	[{ stops_no_information: 1 }, 'Not published', 'Non publié'],
])('reads the schedule declaration from %j', (counts, en, fr) => {
	const data = {
		...answer,
		value: { accessible_stops: counts.stops_accessible ?? 0 },
		evidence: { ...answer.evidence, counts },
	};
	expect(stopAccessibility(data, 'en')).toBe(en);
	expect(stopAccessibility(data, 'fr')).toBe(fr);
});

it('preserves the unpublished state for stops whose schedule omits the field', () => {
	const data: RecordMeasure = {
		...answer,
		state: 'not_published',
		state_text: { en: 'Not published', fr: 'Non publié' },
	};
	expect(stopAccessibility(data, 'en')).toBe('Not published');
	expect(stopAccessibility(data, 'fr')).toBe('Non publié');
});

it('cites the stop, dates, scope, and versions and marks older results', () => {
	const link =
		'https://transit1.yesid.dev/fr/stop/S1?provider=stm&recordFrom=2026-11-08&recordTo=2026-11-14#punctuality';
	const text = stopCitation('Arrêt S1', 'punctuality', answer, 'fr', link, true);
	for (const expected of [
		'Arrêt S1',
		'Ponctualité. Du 8 au 14 nov. 2026.',
		'80 sur 100',
		'Méthode v2',
		'nettoyage v6',
		'calcul précédent',
		link,
	]) {
		expect(text).toContain(expected);
	}
	expect(text.split('Du 8 au 14 nov. 2026')).toHaveLength(2);
	expect(
		stopCitation('Stop S1', 'punctuality', answer, 'en', link).split('8 to 14 Nov 2026'),
	).toHaveLength(2);
});

it('compares measured shares over the same dates in both languages', () => {
	const stop = { ...answer, value: { on_time: 0.751 } };
	const network = { kind: 'answer', answer: { ...answer, value: { on_time: 0.807 } } } as const;
	expect(stopComparison(stop, network, 'en')).toBe(
		'5.6 points below the network, which was at 80.7% over the same dates.',
	);
	expect(stopComparison(stop, network, 'fr')).toMatch(
		/^5,6 points sous la part du réseau, qui était de 80,7\s% sur les mêmes dates\.$/,
	);
	expect(stopComparison(stop, { kind: 'unreachable' }, 'en')).toBeUndefined();
	expect(
		stopComparison(
			stop,
			{
				...network,
				answer: { ...network.answer, evidence: { ...answer.evidence, start_date: '2026-11-01' } },
			},
			'en',
		),
	).toBeUndefined();
});
