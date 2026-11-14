import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import type { RouteFile, StopPrediction } from '#lib/v1/index.ts';
import LineDirections from './LineDirections.svelte';
import { detailCopy } from './lines.copy';

const DIRECTIONS: RouteFile['directions'] = [
	{
		dir: 0,
		headsign: 'Eastbound',
		stops: [
			{ id: 'sA', seq: 1, name: 'First stop' },
			{ id: 'sB', seq: 2, name: 'Second stop' },
		],
	},
	{ dir: 1, headsign: 'Westbound', stops: [{ id: 'sC', seq: 1, name: 'Third stop' }] },
];

const PREDICTIONS = new Map<string, StopPrediction>([
	['sA', { etaUtc: '2026-06-15T12:05:00Z', delayMin: 2 }],
]);

const props = (locale: 'en' | 'fr') => ({
	directions: DIRECTIONS,
	predictions: PREDICTIONS,
	locale,
	copy: detailCopy[locale],
	timeZone: 'America/Toronto',
});

describe('LineDirections', () => {
	it.each([
		['en', '8:05 a.m.', ['Stop', 'Next arrival (predicted)', 'Delay'], '2 min late'],
		['fr', '8 h 05', ['Arrêt', 'Prochain passage (prédit)', 'Retard'], '2 min en retard'],
	] as const)(
		'directions start closed and the time column is labelled in %s',
		async (locale, clock, headers, late) => {
			const { container, rerender } = render(LineDirections, { props: props(locale) });
			const [east, west] = container.querySelectorAll('details');
			expect([east.open, west.open]).toEqual([false, false]);
			const summary = east.querySelector('summary') as HTMLElement;
			expect(within(summary).getByText('Eastbound')).toBeInTheDocument();
			expect(within(summary).getByText(detailCopy[locale].stopsCount(2))).toBeInTheDocument();

			await fireEvent.click(within(summary).getByText('Eastbound'));
			expect([east.open, west.open]).toEqual([true, false]);
			const table = within(east).getByRole('table');
			expect(table).toHaveAccessibleName('Eastbound');
			const columns = within(table).getAllByRole('columnheader');
			expect(columns.map((column) => column.textContent?.trim())).toEqual(headers);
			const row = within(table).getByRole('row', { name: /First stop/ });
			const [time, delay] = within(row).getAllByRole('cell') as HTMLTableCellElement[];
			expect([time.cellIndex, delay.cellIndex]).toEqual([1, 2]);
			expect(within(time).getByText(clock)).toHaveAttribute('datetime', '2026-06-15T12:05:00Z');
			expect(delay).toHaveTextContent(late);

			await rerender({ predictions: new Map() });
			const [eastNow, westNow] = container.querySelectorAll('details');
			expect(eastNow).toBe(east);
			expect([eastNow.open, westNow.open]).toEqual([true, false]);
			const refreshed = within(eastNow).getByRole('row', { name: /First stop/ });
			expect(within(refreshed).getAllByRole('cell')).toHaveLength(1);
			expect(refreshed.querySelector('time')).toBeNull();
			await fireEvent.click(within(westNow).getByText('Westbound'));
			expect(within(westNow).getByRole('table')).toHaveAccessibleName('Westbound');
		},
	);

	it.each(['en', 'fr'] as const)(
		'keeps the stop link and explains an absent prediction across both value columns in %s',
		(locale) => {
			render(LineDirections, { props: props(locale) });
			const action = locale === 'en' ? 'View stop' : 'Voir l’arrêt';
			expect(screen.getByTitle('First stop')).toHaveTextContent('First stop');
			expect(screen.getByRole('link', { name: /First stop/ })).toHaveAccessibleName(
				`${action} 1 First stop`,
			);
			const stop = screen.getByRole('row', { name: /Second stop/ });
			expect(within(stop).getByRole('link')).toHaveAccessibleName(`${action} 2 Second stop`);
			const [empty] = within(stop).getAllByRole('cell');
			expect(empty).toHaveAttribute('colspan', '2');
			const absence = empty.querySelector('[data-slot="absent-value"]');
			expect(absence).toHaveAttribute('data-presentation', 'row');
			expect(absence).toHaveAttribute(
				'aria-label',
				locale === 'en'
					? 'No estimate, no prediction available'
					: 'Aucune estimation, aucune prévision disponible',
			);
			expect(within(stop).queryByText(/No live bus|Aucun bus en direct/)).toBeNull();
			expect(stop.querySelector('time')).toBeNull();
		},
	);

	it('renders nothing when the route carries no directions', () => {
		const { container } = render(LineDirections, {
			props: { directions: [], predictions: PREDICTIONS, locale: 'en', copy: detailCopy.en },
		});
		expect(container.querySelector('[data-slot="line-directions"]')).toBeNull();
	});
});
