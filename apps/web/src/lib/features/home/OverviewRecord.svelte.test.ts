import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { expect, it } from 'vitest';
import type { MeasureAnswer, RankingAnswer } from '#lib/server/engine.ts';
import OverviewRecord from './OverviewRecord.svelte';
import { delivered, measure, period, ranking, stateText } from './overviewRecord.fixture.ts';
import { previousPeriod } from './overviewRecord.ts';

const answer = <T>(value: T) => Promise.resolve({ kind: 'answer' as const, answer: value });
const unavailable = Promise.resolve({ kind: 'unconfigured' as const });
const href = 'https://transit.test/?provider=stm&recordFrom=2026-11-08&recordTo=2026-11-14';

it('renders three independent measures, ranked evidence and the citation', async () => {
	render(OverviewRecord, {
		props: {
			city: 'Montréal',
			locale: 'en',
			href,
			record: {
				period,
				previous: previousPeriod(period),
				punctuality: answer<MeasureAnswer>({
					...measure(),
					measure: 'punctuality',
					value: { ...measure().value, early: 0.1, late: 0.088 },
					evidence: {
						...measure().evidence,
						counts: { ...measure().evidence.counts, early: 50780, late: 44665 },
					},
				}),
				baseline: answer(measure('too_few_to_judge')),
				delivery: answer(delivered),
				lines: answer(ranking),
				stops: answer<RankingAnswer>({
					...ranking,
					kind: 'stop',
					rows: [],
					excluded: [{ reason: 'no_live_data', reason_text: stateText.no_live_data }],
				}),
			},
		},
	});
	const main = screen.getByRole('region', { name: 'On-time performance' });
	expect(await within(main).findByText(/412,355 of 507,800/)).toBeVisible();
	expect(within(main).getByRole('heading', { name: 'Early departures' })).toBeVisible();
	expect(within(main).getByText(/10% \(50,780\/507,800\)/)).toBeVisible();
	expect(within(main).getByText(/on time misses the vehicle/)).toBeVisible();
	expect(within(main).getByText('Only measured days are included.')).toBeVisible();
	expect(await screen.findByText('Too few to judge')).toBeVisible();
	const service = screen.getByRole('region', { name: 'Service delivered' });
	expect(await within(service).findByText(/90 of 100/)).toBeVisible();
	expect(await screen.findByText(/Estimated range 37% to 43%/)).toBeVisible();
	expect(screen.getByText(/fewer than 30 observed stop events/)).toBeVisible();
	expect(await screen.findByText('No live data')).toBeVisible();
	await fireEvent.click(screen.getByText('Cite'));
	expect(screen.getByText(/Method punctuality-v2. Data cleaning version 6/)).toBeInTheDocument();
});

it('shows the French connection state while keeping the link action usable', async () => {
	render(OverviewRecord, {
		props: {
			locale: 'fr',
			city: 'Ottawa',
			href,
			record: {
				period,
				previous: previousPeriod(period),
				punctuality: unavailable,
				baseline: unavailable,
				delivery: unavailable,
				lines: unavailable,
				stops: unavailable,
			},
		},
	});
	const region = screen.getByRole('region', { name: 'Ponctualité' });
	expect(await within(region).findByText(/Les chiffres s’afficheront ici/)).toBeVisible();
	expect(region).not.toHaveTextContent('0 %');
	await fireEvent.click(screen.getByRole('button', { name: 'Copier le lien' }));
	expect(await screen.findByText('Lien copié.')).toBeVisible();
	expect(await navigator.clipboard.readText()).toBe(href);
});
