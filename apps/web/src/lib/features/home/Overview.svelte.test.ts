import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { expect, it } from 'vitest';
import type { EngineResult, RankingAnswer } from '#lib/server/engine.ts';
import { recordConnection } from '../record/recordText';
import { recordState, type RecordState } from '../record/recordStates';
import Overview from './Overview.svelte';
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
		const { container } = render(Overview, {
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
			await waitFor(() =>
				expect(
					screen.getAllByText('En attente. Cette carte redemande dans quelques secondes.'),
				).toHaveLength(6),
			);
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
	const { container } = render(Overview, {
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
	expect(await screen.findByText('12 stop arrivals')).toBeVisible();
	expect(await screen.findByText('18 stop arrivals (minimum 30)')).toBeVisible();
	expect(await screen.findAllByText('Unknown')).toHaveLength(2);
	expect(container.querySelector('[data-record-state="not_measured"]')).toBeNull();
});

for (const locale of ['en', 'fr'] as const) {
	const copy = overviewCopy[locale];
	it(`renders the record, evidence and rankings in ${locale}`, async () => {
		render(Overview, {
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
		const total =
			locale === 'fr' ? /^sur 507.?800 passages aux arrêts$/ : 'of 507,800 stop arrivals';
		expect(within(record).getByText(total)).toBeVisible();
		expect(within(record).getByText(recordState('too_few_to_judge')[locale])).toBeVisible();
		const deliveryRange = within(record).getByText(
			locale === 'fr' ? /entre 81,1\s% et 91,0\s%/u : /between 81\.1% and 91\.0% ran/u,
		);
		const note = deliveryRange.closest('dd');
		expect(note).toHaveClass('col-span-full', 'font-sans');
		expect(note?.previousElementSibling).toHaveTextContent(locale === 'fr' ? /90,0\s%/u : '90.0%');
		expect(note?.previousElementSibling).not.toContainElement(deliveryRange);
		const about = await screen.findByRole('article', { name: copy.about });
		const observed =
			locale === 'fr'
				? /60,0\s% des 846.?333 passages prévus aux arrêts/u
				: /60\.0% of 846,333 scheduled stop arrivals/u;
		expect(within(about).getAllByText(observed)).toHaveLength(1);
		const coverage =
			locale === 'fr'
				? /État connu pour 90,0\s% des 111 trajets/u
				: /Status known for 90\.0% of 111 scheduled trips/u;
		expect(record).not.toHaveTextContent(coverage);
		expect(about).toHaveTextContent(coverage);
		expect(screen.getByRole('link', { name: copy.allRankings })).toHaveAttribute(
			'href',
			expect.stringContaining(`/rankings?provider=${provider}`),
		);
		const label = locale === 'fr' ? 'Copier le lien' : 'Copy link';
		await fireEvent.click(screen.getByRole('button', { name: label }));
		expect(await navigator.clipboard.readText()).toBe(
			`https://transit.test/?provider=${provider}&frameMode=record&recordFrom=2026-11-08&recordTo=2026-11-14`,
		);
	});

	it(`pins the copied link to the dates shown, and says which way rows miss, in ${locale}`, async () => {
		const plainText = (text: string | null) => text?.replace(/[\u00a0\u202f]/gu, ' ');
		render(Overview, {
			props: {
				city: 'Ottawa',
				locale,
				provider,
				// A visit without dates in its address: the default period is shown.
				href: `https://transit.test/${locale === 'fr' ? 'fr' : ''}?provider=${provider}`,
				record: {
					period,
					previous: previousPeriod(period),
					punctuality: answer(measure()),
					baseline: answer(measure()),
					delivery: answer({
						...delivered,
						evidence: {
							...delivered.evidence,
							counts: { ran: 105_782, eligible: 106_631, unconfirmed: 5343 },
						},
					}),
					lines: answer<RankingAnswer>({
						...ranking,
						rows: [
							{
								...ranking.rows[0],
								id: '659',
								sample: 778,
								value: 170 / 778,
								counts: { classified: 778, early: 560, on_time: 170, late: 48 },
							},
						],
					}),
					stops: answer<RankingAnswer>({
						...ranking,
						kind: 'stop',
						rows: [],
						state: 'no_live_data',
					}),
				},
			},
		});
		const rankings = screen.getByRole('article', { name: copy.rankings });
		await waitFor(() =>
			expect(plainText(rankings.textContent)).toContain(
				locale === 'fr' ? 'en avance 72,0 %, en retard 6,2 %' : 'early 72.0%, late 6.2%',
			),
		);
		const record = screen.getByRole('article', { name: copy.record });
		await waitFor(() =>
			expect(plainText(record.textContent)).toContain(
				locale === 'fr'
					? '5 343 autres trajets n’ont pas pu être confirmés, effectués ou non : entre 94,5 % et 99,2 % des trajets ont été effectués.'
					: '5,343 more trips could not be confirmed, run or not: between 94.5% and 99.2% ran.',
			),
		);
		const label = locale === 'fr' ? 'Copier le lien' : 'Copy link';
		await fireEvent.click(screen.getByRole('button', { name: label }));
		expect(await navigator.clipboard.readText()).toBe(
			`https://transit.test/${locale === 'fr' ? 'fr' : ''}?provider=${provider}&frameMode=record&recordFrom=2026-11-08&recordTo=2026-11-14`,
		);
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

it.each(['en', 'fr'] as const)(
	'draws every %s card with its final shape while the record is on its way',
	async (locale) => {
		const waiting = new Promise<never>(() => {});
		const t = overviewCopy[locale];
		const { container } = render(Overview, {
			props: {
				city: 'Montréal',
				locale,
				provider,
				href,
				record: {
					period,
					previous: previousPeriod(period),
					punctuality: waiting,
					baseline: waiting,
					delivery: waiting,
					lines: waiting,
					stops: waiting,
					trend: waiting,
				},
			},
		});
		for (const title of [t.record, t.live, t.rankings, t.about])
			expect(screen.getByRole('article', { name: title })).toBeVisible();
		const rankings = screen.getByRole('article', { name: t.rankings });
		const rows = rankings.querySelectorAll('[data-waiting-shape="rows"]');
		expect([...rows].map((shape) => shape.getAttribute('data-waiting-count'))).toEqual(['3', '3']);
		// About these figures: labels and the sentences that need no answer, the rest pulsing.
		const about = screen.getByRole('article', { name: t.about });
		expect(within(about).getByText(t.means)).toBeVisible();
		expect(within(about).getByText(t.definition)).toBeVisible();
		expect(about.querySelectorAll('[data-record-pending]')).toHaveLength(2);
		// "Seen an error?" is the Method row's second link, to How we measure's About Transit card.
		const report = within(about).getByRole('link', { name: t.errorRow });
		expect(report.getAttribute('href')).toMatch(/\/metrics\?.*#about-transit$/u);
		expect(within(about).getByRole('link', { name: t.method })).toBeVisible();
		expect(container).not.toHaveTextContent(/Calculating|Calcul en cours/u);
	},
);

it('keeps the error link in About these figures once the record arrives', async () => {
	render(Overview, {
		props: {
			city: 'Montréal',
			locale: 'fr',
			provider,
			href,
			record: {
				period,
				previous: previousPeriod(period),
				punctuality: answer(measure('measured')),
				baseline: answer(measure('measured')),
				delivery: answer(delivered),
				lines: answer(ranking),
				stops: answer(ranking),
			},
		},
	});
	// The waiting card is replaced by the filled one.
	await waitFor(() =>
		expect(
			screen
				.getByRole('article', { name: overviewCopy.fr.about })
				.querySelector('[data-record-pending]'),
		).toBeNull(),
	);
	const about = screen.getByRole('article', { name: overviewCopy.fr.about });
	const report = within(about).getByRole('link', { name: 'Vous avez vu une erreur?' });
	expect(report.getAttribute('href')).toMatch(/#about-transit$/u);
});
