vi.mock('$app/state', () => ({
	page: { url: new URL('http://localhost/lines/6?provider=octranspo'), state: {} },
}));
vi.mock('$app/navigation', () => ({ afterNavigate: () => {} }));
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RouteReliability } from '#lib/v1/index.ts';
import RouteReliabilityClusters from './RouteReliabilityClusters.svelte';
import { withClosedPeriods } from './__fixtures__/closedWeek';

vi.mock('#lib/v1/index.ts', async () => ({
	...(await import('#lib/v1/history/index.ts')),
	wilsonBounds: (await import('#lib/v1/stats.ts')).wilsonBounds,
}));
vi.mock('@yesid/motion/stores/reducedMotion', () => ({
	prefersReducedMotion: {
		subscribe(run: (value: boolean) => void) {
			run(false);
			return () => {};
		},
	},
	isPrefersReducedMotion: () => false,
}));

/** The publication the record comes from, as the line file supplies it. */
const PUBLICATION = {
	publish_generation_id: 'octranspo@2026-11-11T06:00:00Z',
	methodology_version: 'reliability-2',
} as Partial<RouteReliability>;

/** Thirty complete days ending November 10: 80 of 100 readings on time, then the week below. */
const LAST_WEEK = [70, 72, 68, 65, 71, 79, 73];
function thirtyDays(identity: Partial<RouteReliability> = PUBLICATION): RouteReliability {
	const end = Date.parse('2026-11-10T00:00:00Z');
	return withClosedPeriods({
		id: '6',
		generated_utc: '2026-11-11T06:00:00Z',
		...identity,
		periods: Array.from({ length: 30 }, (_, index) => {
			const onTime = index >= 23 ? LAST_WEEK[index - 23] : 80;
			return {
				grain: 'day',
				date: new Date(end - (29 - index) * 86_400_000).toISOString().slice(0, 10),
				observation_count: 100,
				on_time: onTime,
				otp_pct: onTime,
				avg_delay_min: 2.5,
				p50_min: 1.5,
				p90_min: 6,
				severe_pct: 9,
			};
		}),
	} as RouteReliability);
}

const citation = {
	line: '6 Greenboro / Rockcliffe',
	providerId: 'octranspo',
	providerName: 'OC Transpo',
};

function renderRecord(locale: 'en' | 'fr' = 'en') {
	return render(RouteReliabilityClusters, { data: thirtyDays(), locale, citation });
}

afterEach(() => vi.unstubAllGlobals());

describe('line Record: one answer, its evidence and its actions', () => {
	it('answers the 7-day record once, outside every collapsible section', () => {
		const { container } = renderRecord();
		const answer = container.querySelector('[data-slot="record-answer"]') as HTMLElement;
		expect(answer).toHaveTextContent('November 4 to 10, 7 complete days');
		expect(answer).toHaveTextContent('71% of readings were on time.');
		expect(answer).toHaveTextContent('On time: from 1 minute early to less than 5 minutes late.');
		expect(answer).toHaveTextContent('Transit’s classification: uneven punctuality.');
		expect(container.querySelectorAll('[data-slot="record-figure"]')).toHaveLength(1);
		expect(container.querySelector('[data-slot="verdict"]')).toBeNull();
		expect(container.querySelector('[data-slot="verdict-kpis"]')).toBeNull();
		const evidence = container.querySelector('[data-slot="record-evidence"]') as HTMLElement;
		expect(evidence).toHaveTextContent('Based on 700 readings. These are not trips or passengers.');
		expect(evidence).toHaveTextContent(
			'No comparison with the previous 7 days is published for this line yet.',
		);
		expect(evidence).toHaveTextContent('Uncertainty range: 68% to 74%.');
		expect(evidence).toHaveTextContent(
			'Repeated readings from the same trip can make this range too narrow.',
		);
		for (const block of [answer, evidence]) expect(block.closest('.section-card')).toBeNull();
	});

	it('offers the periods by short names and states the chosen dates once, in words', () => {
		renderRecord();
		for (const name of ['Latest complete day', 'Last 7 days', 'Last 30 days', 'Date range'])
			expect(screen.getAllByRole('radio', { name }).length).toBeGreaterThan(0);
	});

	it('draws one measure a day with a labelled reference and a table on request', async () => {
		const { container } = renderRecord();
		const daily = container.querySelector('[data-slot="record-daily"]') as HTMLElement;
		expect(daily).toHaveTextContent(
			'Between 65% and 79% each day. Lowest on Saturday, November 7.',
		);
		expect(daily).toHaveTextContent('Dashed line: Transit’s 80% classification reference.');
		const chart = within(daily).getByRole('list');
		expect(within(chart).getAllByRole('listitem')).toHaveLength(7);
		expect(within(chart).getAllByRole('listitem')[3]).toHaveTextContent(
			'Saturday, November 7: 65%',
		);
		const toggle = within(daily).getByRole('button', { name: 'View table' });
		expect(toggle).toHaveAttribute('aria-expanded', 'false');
		await fireEvent.click(toggle);
		expect(toggle).toHaveAttribute('aria-expanded', 'true');
		expect(toggle).toHaveAccessibleName('Hide table');
		const table = within(daily).getByRole('table', {
			name: 'Readings on time and average delay, November 4 to 10',
		});
		const rows = within(table).getAllByRole('row').slice(1);
		expect(rows).toHaveLength(7);
		expect(rows[0]).toHaveTextContent(/^Wednesday, November 470%1002\.5 min$/u);
		// A 7-day record publishes its average delay but no median or 90th percentile.
		const delays = daily.querySelector('[data-slot="record-delays"]') as HTMLElement;
		expect(delays.querySelector('[data-metric="avg"] dd')).toHaveTextContent('2.5 min');
		for (const metric of ['p50', 'p90'])
			expect(delays.querySelector(`[data-metric="${metric}"] dd`)).toHaveTextContent(
				'Not published for this period',
			);
	});

	it('copies a link that keeps the provider, the record view and the exact dates', async () => {
		const writeText = vi.fn(async () => {});
		vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
		renderRecord();
		await fireEvent.click(screen.getByRole('button', { name: 'Copy link' }));
		expect(writeText).toHaveBeenCalledWith(
			'http://localhost/lines/6?provider=octranspo&from=2026-11-04&to=2026-11-10',
		);
		await waitFor(() => expect(screen.getByText('Link copied')).toBeInTheDocument());
	});

	it('copies a citation naming the published record: date, generation and method', async () => {
		const writeText = vi.fn(async () => {});
		vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
		renderRecord();
		await fireEvent.click(screen.getByRole('button', { name: 'Cite this record' }));
		expect(writeText).toHaveBeenCalledWith(
			'Transit (localhost). Line 6 Greenboro / Rockcliffe, OC Transpo: 71% of readings on time, November 4 to 10, 2026, based on 700 readings. Record published Nov 11, 2026, generation octranspo@2026-11-11T06:00:00Z, method reliability-2. http://localhost/lines/6?provider=octranspo&from=2026-11-04&to=2026-11-10',
		);
	});

	it('leaves out publication fields the record does not supply, inventing none', async () => {
		const writeText = vi.fn(async (_text: string) => {});
		vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
		render(RouteReliabilityClusters, { data: thirtyDays({}), locale: 'fr', citation });
		await fireEvent.click(screen.getByRole('button', { name: 'Citer ce bilan' }));
		const text = writeText.mock.calls[0][0];
		expect(text).toMatch(/selon 700 relevés\. Bilan publié le 11 nov\. 2026\. http:/u);
		expect(text).not.toMatch(/génération|méthode/u);
	});

	it('shows no share, delay or severe share from zero readings', async () => {
		const { container } = render(RouteReliabilityClusters, {
			data: {
				id: '6',
				generated_utc: '2026-11-11T06:00:00Z',
				periods_by_grain: [{ grain: 'day', date: '2026-11-10' }],
				periods: [
					{
						grain: 'day',
						date: '2026-11-10',
						observation_count: 0,
						on_time: 0,
						otp_pct: 0,
						avg_delay_min: 0,
						p50_min: 0,
						severe_pct: 0,
					},
				],
			} as unknown as RouteReliability,
			locale: 'en',
			citation,
		});
		expect(container.querySelector('[data-slot="record-figure"]')).toBeNull();
		expect(container.querySelector('[data-slot="record-answer"]')).toHaveTextContent(
			'No share of readings on time is published for this period.',
		);
		for (const metric of ['avg', 'p50', 'p90'])
			expect(container.querySelector(`[data-metric="${metric}"] dd`)).toHaveTextContent(
				'Not published for this period',
			);
		await fireEvent.click(screen.getByRole('button', { name: 'Show the detail' }));
		expect(
			container.querySelector('[data-slot="severe-share"] .block-value'),
		).not.toHaveTextContent('0%');
	});

	it('speaks French with French typography', () => {
		const { container } = renderRecord('fr');
		const answer = container.querySelector('[data-slot="record-answer"]') as HTMLElement;
		expect(answer).toHaveTextContent('Du 4 au 10 novembre, 7 jours complets');
		expect(answer.textContent).toMatch(/71\s%\sdes relevés étaient à l’heure\./u);
		expect(container.querySelector('[data-slot="record-evidence"]')?.textContent).toMatch(
			/Selon 700 relevés\. Ce ne sont ni des trajets ni des passagers\./u,
		);
	});
});
