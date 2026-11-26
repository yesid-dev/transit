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

function mockContainerWidth(width: number, fontSize = 16) {
	vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width);
	vi.spyOn(window, 'getComputedStyle').mockReturnValue({
		fontSize: `${fontSize}px`,
	} as CSSStyleDeclaration);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('StopPredictionTable', () => {
	it.each([
		['en', ['Line', 'Toward', 'Scheduled', 'Expected', 'Status'], 'Unavailable', 'Delay unknown'],
		['fr', ['Ligne', 'Vers', 'Horaire', 'Prévu', 'État'], 'Indisponible', 'Retard inconnu'],
	] as const)(
		'renders five columns with compact labelled stack mode in %s and links to line and departure',
		(locale, headers, unavailable, unknownDelay) => {
			mockContainerWidth(920);
			const { container } = render(StopPredictionTable, {
				rows,
				caption: locale === 'fr' ? 'Prochains véhicules à cet arrêt' : 'Next vehicles at this stop',
				locale,
				city: 'stm',
				url: new URL('https://transit1.yesid.dev/stop/52847?provider=stm&frameMode=live'),
				timeZone: 'America/Toronto',
				now,
			});

			const frame = container.querySelector('[data-slot="data-table-frame"]');
			expect(frame).toHaveAttribute('data-responsive', 'stack');
			expect(frame).toHaveAttribute('data-stack-at', 'compact');

			const table = within(screen.getByRole('table'));
			expect(table.getAllByRole('columnheader').map((cell) => cell.textContent?.trim())).toEqual(
				headers,
			);
			const bodyRows = screen.getByRole('table').querySelectorAll('tbody tr');
			expect(bodyRows).toHaveLength(2);

			const first = bodyRows[0] as HTMLElement;
			expect(
				Array.from(first.querySelectorAll('.data-table-stack-label'), (el) =>
					el.textContent?.trim(),
				),
			).toEqual(headers);
			const firstHeader = within(first).getByRole('rowheader');
			expect(firstHeader.querySelector('a')).toHaveAttribute(
				'href',
				expect.stringContaining('/lines/51?'),
			);
			expect(firstHeader.querySelector('.data-table-cell-content')?.textContent).not.toMatch(
				/Gare Montréal-Ouest|Toward|Vers|Scheduled|Horaire/,
			);
			expect(
				first.querySelector('[data-column="toward"] .data-table-cell-content'),
			).toHaveTextContent('Gare Montréal-Ouest');
			expect(
				first.querySelector('[data-column="scheduled"] .data-table-cell-content'),
			).toHaveTextContent('08:17');
			expect(first.querySelector('[data-column="expected"] a')).toHaveAttribute(
				'href',
				expect.stringContaining('/departure/'),
			);

			const second = bodyRows[1] as HTMLElement;
			expect(
				second.querySelector('[data-column="toward"] .data-table-cell-content'),
			).toHaveTextContent(unavailable);
			expect(
				second.querySelector('[data-column="scheduled"] .data-table-cell-content'),
			).toHaveTextContent(unavailable);
			expect(
				second.querySelector('[data-column="status"] .data-table-cell-content'),
			).toHaveTextContent(unknownDelay);
			const visibleCells = Array.from(
				screen.getByRole('table').querySelectorAll('.data-table-cell-content'),
				(cell) => cell.textContent?.trim() ?? '',
			).join(' | ');
			expect(visibleCells).not.toMatch(
				/Scheduled Unavailable|Horaire Indisponible|Toward Unavailable|Vers Indisponible/,
			);
		},
	);

	it('keeps compact labelled stack mode at 320px and falls back to horizontal scroll below 12rem', () => {
		mockContainerWidth(256, 16);
		const compact = render(StopPredictionTable, {
			rows,
			caption: 'Next vehicles at this stop',
			locale: 'en',
			city: 'stm',
			url: new URL('https://transit1.yesid.dev/stop/52847?provider=stm&frameMode=live'),
			timeZone: 'America/Toronto',
			now,
		});
		expect(compact.container.querySelector('[data-slot="data-table-frame"]')).toHaveAttribute(
			'data-responsive',
			'stack',
		);
		compact.unmount();

		mockContainerWidth(326, 32);
		const zoomed = render(StopPredictionTable, {
			rows,
			caption: 'Next vehicles at this stop',
			locale: 'en',
			city: 'stm',
			url: new URL('https://transit1.yesid.dev/stop/52847?provider=stm&frameMode=live'),
			timeZone: 'America/Toronto',
			now,
		});
		expect(zoomed.container.querySelector('[data-slot="data-table-frame"]')).toHaveAttribute(
			'data-responsive',
			'scroll',
		);
	});
});
