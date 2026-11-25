import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { expect, it } from 'vitest';
import type { EngineResult, RankingAnswer } from '#lib/server/engine.ts';
import { recordConnection } from '../record/recordText';
import { recordState, type RecordState } from '../record/recordStates';
import OverviewRecord from './OverviewRecord.svelte';
import RecordAnswer from '../record/RecordAnswer.svelte';
import { delivered, measure, period, ranking, stateText } from './overviewRecord.fixture.ts';
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

it.each(['unconfigured', 'unreachable', 'timeout', 'busy'] as const)(
	'shows the French %s connection once per card',
	async (kind) => {
		const failed = Promise.resolve<EngineResult<never>>({ kind });
		const { container } = render(OverviewRecord, {
			props: {
				city: 'Ottawa',
				locale: 'fr',
				provider,
				href,
				record: {
					period,
					previous: previousPeriod(period),
					punctuality: failed,
					baseline: failed,
					delivery: failed,
					lines: failed,
					stops: failed,
					trend: failed,
				},
			},
		});
		if (kind === 'busy') {
			expect(await screen.findAllByText('Lecture en attente.')).toHaveLength(6);
		} else {
			const record = screen.getByRole('article', { name: overviewCopy.fr.record });
			const rankings = screen.getByRole('article', { name: overviewCopy.fr.rankings });
			expect(await within(record).findByText(recordConnection[kind].fr)).toBeVisible();
			expect(await within(rankings).findByText(recordConnection[kind].fr)).toBeVisible();
			expect(within(record).getAllByText('Indisponible')).toHaveLength(4);
			expect(within(rankings).getAllByText('Indisponible')).toHaveLength(2);
		}
		expect(container.querySelector('[data-record-state="not_measured"]')).toBeNull();
		expect(container).not.toHaveTextContent(/\b0\s?%/u);
	},
);

it('shows the sample and any supplied minimum, and keeps mixed ranking reasons unknown', async () => {
	const low = measure('too_few_to_judge');
	low.evidence.counts.classified = 12;
	const { container } = render(OverviewRecord, {
		props: {
			city: 'Montréal',
			locale: 'en',
			provider,
			href,
			record: {
				period,
				previous: previousPeriod(period),
				punctuality: answer(low),
				baseline: answer(measure('unknown')),
				delivery: answer(delivered),
				lines: answer<RankingAnswer>({
					...ranking,
					rows: [],
					excluded: [
						{ reason: 'too_few_to_judge', reason_text: stateText.too_few_to_judge, sample: 18 },
					],
				}),
				stops: answer<RankingAnswer>({
					...ranking,
					kind: 'stop',
					rows: [],
					excluded: [
						{ reason: 'too_few_to_judge', reason_text: stateText.too_few_to_judge, sample: 8 },
						{ reason: 'no_live_data', reason_text: stateText.no_live_data },
					],
				}),
			},
		},
	});
	expect(await screen.findByText('12 stop events')).toBeVisible();
	expect(await screen.findByText('18 stop events (minimum 30)')).toBeVisible();
	expect(await screen.findAllByText('Unknown')).toHaveLength(2);
	expect(container.querySelector('[data-record-state="not_measured"]')).toBeNull();
});

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
					delivery: answer({
						...delivered,
						evidence: { ...delivered.evidence, share_eligible: 0.9 },
					}),
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
		expect(record.querySelectorAll('[data-slot="stamp"]')).toHaveLength(1);
		const total = locale === 'fr' ? /^sur 507.?800 passages aux arrêts$/ : 'of 507,800 stop events';
		expect(within(record).getByText(total)).toBeVisible();
		expect(within(record).getByText(recordState('too_few_to_judge')[locale])).toBeVisible();
		const about = await screen.findByRole('article', { name: copy.about });
		const observed =
			locale === 'fr'
				? /60\s?% des 846.?333 passages prévus aux arrêts/
				: /60% of 846,333 scheduled stop events/;
		expect(within(about).getAllByText(observed)).toHaveLength(1);
		const coverage =
			locale === 'fr'
				? /État connu pour 90\s?% des 111 trajets/
				: /Status known for 90% of 111 scheduled trips/;
		expect(record).not.toHaveTextContent(coverage);
		expect(about).toHaveTextContent(coverage);
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
