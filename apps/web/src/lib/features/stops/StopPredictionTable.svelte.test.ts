import { render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StopPredictionTable from './StopPredictionTable.svelte';
import type { StopPrediction } from './stopLiveReadings.ts';

const now = Date.parse('2026-11-25T13:12:00Z');
const rows: StopPrediction[] = [
	{
		key: 'known',
		instance: 'known',
		trip: 'trip-1',
		line: '51',
		direction: 0,
		start: '08:00:00',
		toward: 'Gare Montréal-Ouest',
		predictedAt: now + 5 * 60_000,
		scheduledAt: now + 5 * 60_000,
		delay: 0,
	},
	{
		key: 'unknown',
		instance: 'unknown',
		trip: 'trip-2',
		line: '165',
		direction: 1,
		start: null,
		toward: null,
		predictedAt: now + 21 * 60_000,
		scheduledAt: null,
		delay: null,
	},
];

function mockContainerWidth(width: number) {
	vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width);
	vi.spyOn(window, 'getComputedStyle').mockReturnValue({
		fontSize: '16px',
	} as CSSStyleDeclaration);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('StopPredictionTable', () => {
	it.each([
		['en', ['Line', 'Toward', 'Scheduled', 'Expected', 'Status'], 'Unavailable'],
		['fr', ['Ligne', 'Vers', 'Horaire', 'Prévu', 'État'], 'Indisponible'],
	] as const)(
		'renders five columns at desktop widths with %s unavailable cells and links',
		(locale, headers, unavailable) => {
			mockContainerWidth(920);
			render(StopPredictionTable, {
				rows,
				caption: locale === 'fr' ? 'Prochains véhicules à cet arrêt' : 'Next vehicles at this stop',
				locale,
				city: 'stm',
				url: new URL('https://transit1.yesid.dev/stop/52847?provider=stm&frameMode=live'),
				timeZone: 'America/Toronto',
				now,
			});

			const table = within(screen.getByRole('table'));
			expect(table.getAllByRole('columnheader').map((cell) => cell.textContent?.trim())).toEqual(
				headers,
			);
			const bodyRows = screen.getByRole('table').querySelectorAll('tbody tr');
			expect(bodyRows).toHaveLength(2);

			const first = within(bodyRows[0] as HTMLElement);
			const firstHeader = first.getByRole('rowheader');
			expect(firstHeader.querySelector('a')).toHaveAttribute(
				'href',
				expect.stringContaining('/lines/51?'),
			);
			expect(firstHeader.textContent).not.toMatch(
				/Gare Montréal-Ouest|Toward|Vers|Scheduled|Horaire/,
			);
			expect(
				bodyRows[0].querySelector('[data-column="toward"] .data-table-cell-content'),
			).toHaveTextContent('Gare Montréal-Ouest');
			expect(
				bodyRows[0].querySelector('[data-column="scheduled"] .data-table-cell-content'),
			).toHaveTextContent('08:17');
			expect(bodyRows[0].querySelector('[data-column="expected"] a')).toHaveAttribute(
				'href',
				expect.stringContaining('/departure/'),
			);

			const secondHeader = within(bodyRows[1] as HTMLElement).getByRole('rowheader');
			expect(secondHeader.textContent).not.toMatch(
				/Unavailable|Indisponible|Scheduled|Horaire|Destination/,
			);
			expect(
				bodyRows[1].querySelector('[data-column="toward"] .data-table-cell-content'),
			).toHaveTextContent(unavailable);
			expect(
				bodyRows[1].querySelector('[data-column="scheduled"] .data-table-cell-content'),
			).toHaveTextContent(unavailable);
			expect(
				bodyRows[1].querySelector('[data-column="status"] .data-table-cell-content'),
			).toHaveTextContent(locale === 'fr' ? 'Retard inconnu' : 'Delay unknown');
			const visibleCells = Array.from(
				screen.getByRole('table').querySelectorAll('.data-table-cell-content'),
				(cell) => cell.textContent?.trim() ?? '',
			).join(' | ');
			expect(visibleCells).not.toMatch(
				/Scheduled Unavailable|Horaire Indisponible|Toward Unavailable|Vers Indisponible/,
			);
		},
	);

	it.each([
		[
			'en',
			['Line', 'Expected'],
			'Toward Gare Montréal-Ouest',
			'Scheduled 08:17',
			'Scheduled time unavailable',
			'Destination unavailable',
		],
		[
			'fr',
			['Ligne', 'Prévu'],
			'Vers Gare Montréal-Ouest',
			'Horaire 08:17',
			'Horaire indisponible',
			'Destination indisponible',
		],
	] as const)(
		'stacks prediction detail only on narrow phone rows in %s without awkward unavailable labels',
		(locale, headers, toward, scheduled, scheduledUnavailable, destinationUnavailable) => {
			mockContainerWidth(320);
			render(StopPredictionTable, {
				rows,
				caption: locale === 'fr' ? 'Prochains véhicules à cet arrêt' : 'Next vehicles at this stop',
				locale,
				city: 'stm',
				url: new URL('https://transit1.yesid.dev/stop/52847?provider=stm&frameMode=live'),
				timeZone: 'America/Toronto',
				now,
			});

			const table = within(screen.getByRole('table'));
			expect(table.getAllByRole('columnheader').map((cell) => cell.textContent?.trim())).toEqual(
				headers,
			);
			const bodyRows = screen.getByRole('table').querySelectorAll('tbody tr');
			expect(bodyRows).toHaveLength(2);

			const firstHeader = within(bodyRows[0] as HTMLElement).getByRole('rowheader');
			expect(firstHeader).toHaveTextContent(toward);
			expect(firstHeader).toHaveTextContent(scheduled);
			expect(bodyRows[0].querySelector('[data-column="expected"] a')).toHaveAttribute(
				'href',
				expect.stringContaining('/departure/'),
			);

			const secondHeader = within(bodyRows[1] as HTMLElement).getByRole('rowheader');
			expect(secondHeader).toHaveTextContent(scheduledUnavailable);
			expect(secondHeader).toHaveTextContent(destinationUnavailable);
			expect(screen.getByRole('table').textContent).not.toMatch(
				/Scheduled Unavailable|Horaire Indisponible|Toward Unavailable|Vers Indisponible/,
			);
		},
	);
});
