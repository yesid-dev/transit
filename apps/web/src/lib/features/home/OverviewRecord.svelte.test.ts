import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { expect, it } from 'vitest';
import type { RankingAnswer } from '#lib/server/engine.ts';
import { recordState, type RecordState } from '../record/recordStates';
import OverviewRecord from './OverviewRecord.svelte';
import RecordAnswer from '../record/RecordAnswer.svelte';
import { delivered, measure, period, ranking } from './overviewRecord.fixture.ts';
import { previousPeriod } from './overviewRecord.ts';
import { overviewCopy } from './overviewRecord.copy.ts';

const answer = <T>(value: T) => Promise.resolve({ kind: 'answer' as const, answer: value });
const provider = 'fixture-network';
const href = `https://transit.test/?provider=${provider}&recordFrom=2026-11-08&recordTo=2026-11-14`;
const states: RecordState[] = [
	'no_live_data',
	'not_measured',
	'too_few_to_judge',
	'unknown',
	'not_reporting',
	'not_tracked',
];

for (const locale of ['en', 'fr'] as const) {
	const copy = overviewCopy[locale];
	it(`renders the record, evidence and rankings in ${locale}`, async () => {
		render(OverviewRecord, {
			props: {
				city: 'Montréal',
				locale,
				provider,
				href,
				record: {
					period,
					previous: previousPeriod(period),
					punctuality: answer(measure()),
					baseline: answer(measure('too_few_to_judge')),
					delivery: answer(delivered),
					lines: answer(ranking),
					stops: answer<RankingAnswer>({
						...ranking,
						kind: 'stop',
						rows: [],
						state: 'no_live_data',
					}),
				},
			},
		});
		const record = screen.getByRole('article', { name: copy.record });
		expect(await within(record).findByText(copy.answer)).toBeVisible();
		expect(within(record).getByText(recordState('too_few_to_judge')[locale])).toBeVisible();
		expect(await screen.findByRole('article', { name: copy.about })).toBeVisible();
		expect(screen.getByRole('link', { name: copy.allRankings })).toHaveAttribute(
			'href',
			expect.stringContaining(`/hotspots?provider=${provider}`),
		);
		const label = locale === 'fr' ? 'Copier le lien' : 'Copy link';
		await fireEvent.click(screen.getByRole('button', { name: label }));
		expect(await navigator.clipboard.readText()).toBe(href);
	});

	it.each(states)(`renders the %s state as a mark and words in ${locale}`, (state) => {
		const reading = recordState(state);
		const { container } = render(RecordAnswer, {
			props: { value: null, sentence: reading[locale], state, locale },
		});
		expect(screen.getByText(reading[locale])).toBeVisible();
		expect(container.querySelector('[data-record-state]')).toHaveTextContent(reading.glyph);
		expect(container.querySelector('.answer-value')).toBeNull();
		expect(container).not.toHaveTextContent(/^(?:0\s?%?|[-\u2013\u2014])$/);
	});
}
