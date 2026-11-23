import { describe, expect, it } from 'vitest';
import type { RecordMeasure } from '#lib/server/engine.ts';
import { measure, period, stateText } from '#lib/features/home/overviewRecord.fixture.ts';
import { punctualityBands, recordMessage } from '#lib/features/record/recordText.ts';
import { lineAnswer, lineCitation } from './lineRecordText.ts';

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
		expect(lineAnswer(answer, answer.evidence, 'en')).toContain('November 8 to 14, 2026, 80%');
		expect(lineAnswer(answer, answer.evidence, 'en')).toContain('(80 of 100)');
		expect(lineAnswer(answer, answer.evidence, 'fr')).toContain('Du 8 au 14 novembre 2026');
		expect(lineAnswer(answer, answer.evidence, 'fr')).toContain('(80 sur 100)');
		expect(punctualityBands(answer, 'en').map(({ reading }) => reading)).toEqual([
			'0% (0/100) · 50% of 200 scheduled stops observed',
			'80% (80/100) · 50% of 200 scheduled stops observed',
			'20% (20/100) · 50% of 200 scheduled stops observed',
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
		for (const text of [
			'24 · Sherbrooke',
			'80 sur 100',
			'Méthode punctuality-v2',
			'version 6',
			href,
		])
			expect(citation).toContain(text);
	});
});
