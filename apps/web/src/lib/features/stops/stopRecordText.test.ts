import { expect, it } from 'vitest';
import { measure, stateText } from '#lib/features/home/overviewRecord.fixture.ts';
import { punctualityBands, recordMessage } from '#lib/features/record/recordText.ts';
import type { RecordMeasure } from '#lib/server/engine.ts';
import { stopAccessibility, stopAnswer, stopCitation, stopDelay } from './stopRecordText.ts';

const base = measure();
const answer: RecordMeasure = {
	...base,
	value: { early: 0, on_time: 0.8, late: 0.2 },
	evidence: { ...base.evidence, counts: { early: 0, on_time: 80, late: 20, classified: 100 } },
};

it('uses the engine dates, count and denominator in both locales', () => {
	expect(stopAnswer(answer, 'en')).toMatch(/November 8 to 14, 2026, 80%.*\(80 of 100\)/);
	expect(stopAnswer(answer, 'fr')).toMatch(/Du 8 au 14 novembre 2026, 80\s%.*\(80 sur 100\)/);
	expect(punctualityBands(answer, 'en').map(({ reading }) => reading)).toEqual([
		'0% (0/100)',
		'80% (80/100)',
		'20% (20/100)',
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

it('preserves the sign of delay and distinguishes missing from measured zero', () => {
	expect(stopDelay(-30, 'en')).toBe('30 s early');
	expect(stopDelay(350, 'fr')).toBe('350 s de retard');
	expect(stopDelay(0, 'fr')).toBe('0 s');
	expect(stopDelay(null, 'fr')).toBe('Inconnu');
});

it.each<[Record<string, number>, string, string]>([
	[{ stops_accessible: 1 }, 'Accessible', 'Accessible'],
	[{ stops_not_accessible: 1 }, 'Not accessible', 'Non accessible'],
	[{ stops_no_information: 1 }, 'No information', 'Aucune information'],
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
});

it('cites the stop, dates, scope, and versions and marks older results', () => {
	const link =
		'https://transit1.yesid.dev/fr/stop/S1?provider=stm&recordFrom=2026-11-08&recordTo=2026-11-14#punctuality';
	const text = stopCitation('Arrêt S1', 'punctuality', answer, 'fr', link, true);
	for (const expected of [
		'Arrêt S1',
		'Du 8 au 14 novembre 2026',
		'80 sur 100',
		'Méthode punctuality-v2',
		'version 6',
		'calcul précédent',
		link,
	]) {
		expect(text).toContain(expected);
	}
});
