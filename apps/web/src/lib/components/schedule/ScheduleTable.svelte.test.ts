import { render, screen, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import { detailCopy } from '#lib/features/stops/stops.copy.ts';
import ScheduleTable, { type ScheduleRow, type ScheduleTableProps } from './ScheduleTable.svelte';

const GRID_LABELS = {
	caption: 'Scheduled service by line',
	route: 'Line',
	destination: 'Destination',
	departures: 'Departures',
};

const SERVICE_LABELS = {
	caption: 'Planned service periods',
	period: 'Period',
	window: 'Window',
	headway: 'Planned headway',
};

function scheduleChassis(container: HTMLElement, caption: string, mode: 'grid' | 'service') {
	const table = within(container).getByRole('table', { name: caption });
	const frame = table.parentElement as HTMLElement;

	expect(frame).toHaveClass('data-table-frame', 'schedule-table-frame');
	expect(frame).toHaveAttribute('data-mode', mode);
	expect(frame).toHaveAttribute('data-responsive', mode === 'service' ? 'stack' : 'scroll');
	expect(frame).toHaveAttribute('data-frame', 'card');
	expect(frame).toHaveAttribute('data-collapse', 'collapse');
	expect(frame).toHaveAttribute('data-header-band', 'terminal');
	expect(table).toHaveClass('data-table', 'schedule-table');
	expect(table.querySelectorAll('caption')).toHaveLength(1);

	return { table, frame };
}

describe('ScheduleTable — grid mode', () => {
	it('exposes a row header in every mode and no scroll region without real overflow (S5-386 F4)', () => {
		const cases: Pick<ScheduleTableProps, 'rows' | 'mode' | 'labels'>[] = [
			{
				rows: [{ kind: 'grid', route: '51', headsign: 'Nord', times: ['08:00'] }],
				mode: 'grid',
				labels: GRID_LABELS,
			},
			{
				rows: [{ kind: 'service', period: 'AM peak', window: '06:00–09:00', headway: '6.0 min' }],
				mode: 'service',
				labels: SERVICE_LABELS,
			},
		];
		for (const props of cases) {
			const view = render(ScheduleTable, { props: { ...props, locale: 'en' } });
			expect(view.getAllByRole('rowheader').length).toBeGreaterThan(0);
			const frame = view.container.querySelector('.data-table-frame');
			expect(frame).not.toHaveAttribute('role');
			expect(frame).not.toHaveAttribute('tabindex');
			view.unmount();
		}
	});

	it('renders one semantic scheduled-service table with a caption and scoped headers', () => {
		const rows: ScheduleRow[] = [
			{
				kind: 'grid',
				route: '51',
				headsign: 'Nord',
				times: ['08:00', '08:10', '08:20', '08:30', '08:40', '08:50'],
			},
		];
		render(ScheduleTable, {
			props: {
				rows,
				mode: 'grid',
				locale: 'en',
				labels: detailCopy.en.schedule.table,
				moreLabel: detailCopy.en.schedule.moreTimes,
			},
		});
		const table = screen.getByRole('table', { name: detailCopy.en.schedule.table.caption });
		expect(table).toBeInTheDocument();
		expect(
			within(table).getByRole('columnheader', { name: detailCopy.en.schedule.table.route }),
		).toHaveAttribute('scope', 'col');
		expect(
			within(table).getByRole('columnheader', { name: detailCopy.en.schedule.table.destination }),
		).toHaveAttribute('scope', 'col');
		expect(
			within(table).getByRole('columnheader', { name: detailCopy.en.schedule.table.departures }),
		).toHaveAttribute('scope', 'col');

		expect(screen.getByText('51')).toBeInTheDocument();
		expect(screen.getByText('Nord')).toBeInTheDocument();
		for (const time of rows[0].kind === 'grid' ? rows[0].times : [])
			expect(within(table).getByText(time)).toBeInTheDocument();
	});

	it('keeps every departure associated with its route row instead of a detached time grid', () => {
		const rows: ScheduleRow[] = [
			{ kind: 'grid', route: '51', times: ['08:00', '08:10', '08:20', '08:30', '08:40', '08:50'] },
		];
		const { container } = render(ScheduleTable, {
			props: { rows, mode: 'grid', locale: 'en', labels: GRID_LABELS },
		});
		const row = container.querySelector('tbody tr') as HTMLElement;
		expect(row).toHaveTextContent('51');
		expect(row).toHaveTextContent('08:00');
		expect(row).toHaveTextContent('08:50');
	});

	it('caps the shown times and prints the honest "+N more" overflow note via moreLabel', () => {
		const times = Array.from({ length: 32 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
		const rows: ScheduleRow[] = [{ kind: 'grid', route: '80', times }];
		const { container } = render(ScheduleTable, {
			props: {
				rows,
				mode: 'grid',
				locale: 'en',
				labels: GRID_LABELS,
				cap: 30,
				moreLabel: (n) => `+${n} more times`,
			},
		});
		expect(container.querySelectorAll('.stop-schedule-time').length).toBe(30);
		expect(screen.getByText('+2 more times')).toBeInTheDocument();
	});

	it('states an honest per-route AbsentValue when a listed route has NO times', () => {
		const rows: ScheduleRow[] = [{ kind: 'grid', route: '99', headsign: 'Vide', times: [] }];
		render(ScheduleTable, {
			props: { rows, mode: 'grid', locale: 'en', labels: GRID_LABELS },
		});
		expect(screen.getByText('99')).toBeInTheDocument();
		const chip = document.querySelector('[data-slot="absent-value"]');
		expect(chip).not.toBeNull();
		expect(chip?.textContent).toContain('not enough readings yet');
	});
});

describe('ScheduleTable — service mode', () => {
	it('renders planned line periods in the same semantic table chassis', () => {
		const rows: ScheduleRow[] = [
			{ kind: 'service', period: 'AM peak', window: '06:00–09:00', headway: '6.0 min' },
			{ kind: 'service', period: 'Midday', window: '09:00–15:00', headway: null },
		];
		const { container } = render(ScheduleTable, {
			props: { rows, mode: 'service', locale: 'en', labels: SERVICE_LABELS },
		});

		const table = screen.getByRole('table', { name: SERVICE_LABELS.caption });
		scheduleChassis(container, SERVICE_LABELS.caption, 'service');
		expect(within(table).getAllByRole('row')).toHaveLength(3);
		expect(
			within(table).getByRole('columnheader', { name: SERVICE_LABELS.period }),
		).toBeInTheDocument();
		expect(
			within(table).getByRole('columnheader', { name: SERVICE_LABELS.window }),
		).not.toHaveAttribute('data-numeric');
		expect(
			within(table).getByRole('columnheader', { name: SERVICE_LABELS.headway }),
		).toHaveAttribute('data-numeric', 'true');
		expect(table.querySelector('tbody [data-column="period"]')).toHaveAttribute(
			'data-align',
			'start',
		);
		expect(table.querySelector('tbody [data-column="window"]')).toHaveAttribute(
			'data-align',
			'start',
		);
		expect(table.querySelector('tbody [data-column="headway"]')).toHaveAttribute(
			'data-align',
			'end',
		);
		expect(within(table).getByText('AM peak')).toBeInTheDocument();
		expect(within(table).getByText('6.0 min')).toBeInTheDocument();
		expect(table.querySelectorAll('[data-slot="absent-value"]')).toHaveLength(1);
	});

	it.each([
		['en', 'Time window not supplied', 'Unknown, not in the schedule'],
		['fr', 'Plage horaire non fournie', 'Inconnu, absent de l’horaire'],
	] as const)(
		'says a published headway’s missing time window was not supplied, in its cell only (%s)',
		(locale, windowName, headwayName) => {
			const rows: ScheduleRow[] = [
				{ kind: 'service', period: 'AM peak', window: null, headway: '6.0 min' },
				{ kind: 'service', period: 'Midday', window: '09:00–15:00', headway: null },
			];
			render(ScheduleTable, {
				props: { rows, mode: 'service', locale, labels: SERVICE_LABELS },
			});

			const table = screen.getByRole('table', { name: SERVICE_LABELS.caption });
			const windowCell = table.querySelector('tbody [data-column="window"]') as HTMLElement;
			const headwayCell = table.querySelectorAll('tbody [data-column="headway"]')[1] as HTMLElement;
			expect(windowCell).toHaveTextContent(windowName);
			expect(headwayCell).toHaveAttribute('data-column', 'headway');
			expect(within(headwayCell as HTMLElement).getByLabelText(headwayName)).toBeInTheDocument();
		},
	);
});
