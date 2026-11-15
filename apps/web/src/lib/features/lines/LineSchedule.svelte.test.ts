import { render, screen, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import LineSchedule from './LineSchedule.svelte';
import { RouteFileSchema } from '#lib/v1/schemas/index.ts';

const file = RouteFileSchema.parse({
	id: '1',
	generated_utc: '2026-11-15T12:00:00Z',
	first_departure: '04:59',
	last_departure: '26:01',
	service_periods: [
		{ shift: 'am_peak', window: '06:00–09:00', headway_min: 9 },
		{ shift: 'night', window: null, headway_min: 30.5 },
	],
	directions: [],
});
describe.each(['en', 'fr'] as const)('LineSchedule in %s', (locale) => {
	it('shows the no-live capability and available planned service with its own load date', () => {
		const { container } = render(LineSchedule, {
			props: {
				file,
				locale,
				noLive: true,
				loadedUtc: '2026-11-12T12:00:00Z',
				recordHref: '/lines/1',
				shareUrl: 'https://transit.yesid.dev/lines/1?provider=octranspo',
			},
		});
		expect(container).toHaveTextContent(
			locale === 'en' ? 'No live data for this line' : 'Aucune donnée en direct pour cette ligne',
		);
		expect(container).toHaveTextContent(
			locale === 'en'
				? 'Excluded from performance rates, counts and rankings.'
				: 'Exclue des taux, des totaux et des classements de performance.',
		);
		expect(container.querySelector('time')).toHaveAttribute('datetime', '2026-11-12T12:00:00Z');
		expect(
			container.querySelector('[data-variant="live"], [data-slot="no-predictions"]'),
		).toBeNull();
		const table = screen.getByRole('table');
		expect(table).toHaveTextContent(
			locale === 'en' ? 'Time window not supplied' : 'Plage horaire non fournie',
		);
		expect(table).toHaveTextContent(locale === 'en' ? '30.5 min' : '30,5 min');
		expect(container).toHaveTextContent('26:01');
		const csv = screen.getByRole('link', { name: /CSV/ });
		expect(decodeURIComponent(csv.getAttribute('href')!)).toContain('"night","","30.5"');
	});
	it('does not borrow a publication date or show invalid planned intervals as zero', () => {
		const { container } = render(LineSchedule, {
			props: {
				file: { ...file, service_periods: [{ shift: 'night', window: null, headway_min: -2 }] },
				locale,
				recordHref: '/lines/1',
				shareUrl: 'https://transit.yesid.dev/lines/1',
			},
		});
		expect(container.querySelector('time')).toBeNull();
		expect(container).toHaveTextContent(
			locale === 'en'
				? 'Schedule load date not supplied.'
				: 'Date de chargement de l’horaire non fournie.',
		);
		expect(within(screen.getByRole('table')).queryByText(/-2|0 min/)).toBeNull();
	});
	it('rounds planned minutes once and withholds nonfinite, negative, zero and subprecision values', () => {
		const inputs = [2.55, 30.5, 0, -0, -2, Number.NaN, Number.POSITIVE_INFINITY, 0.01];
		const { container } = render(LineSchedule, {
			props: {
				file: {
					...file,
					service_periods: inputs.map((headway_min, i) => ({
						shift: `period ${i}`,
						window: null,
						headway_min,
					})),
				},
				locale,
				recordHref: '/lines/1',
				shareUrl: 'https://transit.yesid.dev/lines/1',
			},
		});
		const cells = [...screen.getByRole('table').querySelectorAll('tbody [data-column="headway"]')];
		expect(cells.slice(0, 2).map((cell) => cell.textContent?.trim())).toEqual(
			locale === 'en' ? ['2.6 min', '30.5 min'] : ['2,6 min', '30,5 min'],
		);
		expect(cells.slice(2).every((cell) => cell.querySelector('[data-slot="absent-value"]'))).toBe(
			true,
		);
		expect(container).not.toHaveTextContent(/NaN|Infinity|−0 min|-0 min/);
	});
});
