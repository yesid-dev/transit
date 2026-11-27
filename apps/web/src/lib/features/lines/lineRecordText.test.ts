import { describe, expect, it } from 'vitest';
import type { RecordMeasure, RecordSeries } from '#lib/server/engine.ts';
import { measure, period, stateText } from '#lib/features/home/overviewRecord.fixture.ts';
import { punctualityBands, recordMessage } from '#lib/features/record/recordText.ts';
import {
	crowdingFinding,
	lineAnswer,
	lineCitation,
	offeredFinding,
	waitingFinding,
} from './lineRecordText.ts';

it.each([
	['en', 'On the gaps Transit could measure, estimated waits were 0.6 min longer than scheduled.'],
	[
		'fr',
		'Pour les intervalles que Transit a pu mesurer, l’attente estimée dépassait l’horaire de 0,6 min.',
	],
] as const)('limits excess wait to measured gaps in %s', (locale, sentence) => {
	const basedOn = measure();
	const fixture: RecordMeasure = {
		...basedOn,
		value: { excess_wait_time: 37.51566405237588 },
		evidence: {
			...basedOn.evidence,
			counts: {
				observed_headways: 36474,
				covered_scheduled_headways: 29394,
				frequent_headways: 58113,
			},
		},
	};
	expect(waitingFinding(fixture, locale)?.replace(/[\u00a0\u202f]/gu, ' ')).toBe(sentence);
});

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

describe('Line Record text', () => {
	it('explains the exact dates and counts and keeps a measured zero', () => {
		expect(lineAnswer(answer, answer.evidence, 'en')).toContain('8 to 14 Nov 2026, 80.0%');
		expect(lineAnswer(answer, answer.evidence, 'en')).toContain('(80 of 100)');
		expect(lineAnswer(answer, answer.evidence, 'fr')).toContain('du 8 au 14 nov. 2026');
		expect(lineAnswer(answer, answer.evidence, 'fr')).toContain('(80 sur 100)');
		expect(punctualityBands(answer, 'en').map(({ reading }) => reading)).toEqual([
			'0.0% (0/100) · 50.0% of 200 scheduled stops observed',
			'80.0% (80/100) · 50.0% of 200 scheduled stops observed',
			'20.0% (20/100) · 50.0% of 200 scheduled stops observed',
		]);
	});

	it.each(['no_live_data', 'not_measured', 'too_few_to_judge', 'unknown', 'not_tracked'] as const)(
		'keeps the bilingual %s state with no numeric share',
		(state) => {
			const unavailable = { ...answer, state, state_text: stateText[state] };
			expect(recordMessage({ kind: 'answer', answer: unavailable }, 'fr')).toBe(
				stateText[state].fr,
			);
			expect(punctualityBands(unavailable, 'en').map(({ reading }) => reading)).toEqual(
				Array(3).fill(stateText[state].en),
			);
		},
	);

	it('cites the result, scoped URL and the engine versions in Québec French', () => {
		const href = `https://transit1.yesid.dev/fr/lines/24?provider=stm&direction=1&recordFrom=${period.from}&recordTo=${period.to}#punctuality`;
		const citation = lineCitation('24 · Sherbrooke', 'Ponctualité', answer, 'fr', href);
		for (const text of ['24 · Sherbrooke', '80 sur 100', 'Méthode v2', 'nettoyage v6', href])
			expect(citation).toContain(text);
	});

	it.each(['en', 'fr'] as const)('says the dates once in a %s citation', (locale) => {
		const title = locale === 'en' ? 'On-time performance' : 'Ponctualité';
		const citation = lineCitation('24 · Sherbrooke', title, answer, locale, 'x');
		const dates = locale === 'en' ? '8 to 14 Nov 2026' : 'Du 8 au 14 nov. 2026';
		expect(citation).toContain(`${title}. ${dates}.`);
		expect(citation.split(dates)).toHaveLength(2);
		expect(citation).toContain(locale === 'en' ? '80 of 100' : '80 sur 100');
	});
});

it.each([
	['en', 'Vehicles most often had few seats free: 33.9% of the time.'],
	[
		'fr',
		'Les véhicules avaient le plus souvent peu de places assises libres\u00a0: 33,9\u00a0% du temps.',
	],
] as const)('says the most frequent occupancy in plain words, in %s', (locale, sentence) => {
	expect(crowdingFinding({ key: 'crowding_few_seats', share: 0.339 }, locale)).toBe(sentence);
});

it('says reported percentages and leaves unknown levels unsaid', () => {
	expect(crowdingFinding({ key: 'percentage', percentage: 40, share: 0.2 }, 'en')).toBe(
		'Vehicles most often were reported 40.0% full: 20.0% of the time.',
	);
	expect(crowdingFinding({ key: 'crowding_unheard_of', share: 0.2 }, 'en')).toBeNull();
});

it('says the busiest planned hour in trips an hour', () => {
	const cell = (hour: number, rate: number) => ({
		key: { hour },
		state: 'measured' as const,
		state_text: { en: '', fr: '' },
		value: { scheduled_frequency: rate },
		evidence: { counts: {}, days_included: [] },
	});
	const series = { cells: [cell(7, 21.17), cell(0, 3.86)] } as unknown as RecordSeries;
	expect(offeredFinding(series, 'en')).toBe(
		'Planned service peaked from 07:00 to 08:00: about 21 trips an hour.',
	);
	expect(offeredFinding(series, 'fr')?.replace(/[\u00a0\u202f]/gu, ' ')).toBe(
		'Le service prévu culminait de 7 h à 8 h : environ 21 trajets par heure.',
	);
});
