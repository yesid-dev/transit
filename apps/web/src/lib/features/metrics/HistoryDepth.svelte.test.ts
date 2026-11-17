import { render, screen, within } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import { HistoricAvailabilityIndexSchema } from '#lib/v1/schemas/index.ts';
import { historyDepthCopy } from './historyDepth.copy';
import { copy as healthCopy } from '#lib/features/health/health.copy.ts';
import HistoryDepth from './HistoryDepth.svelte';

const index = HistoricAvailabilityIndexSchema.parse({
	generated_utc: '2026-11-11T07:11:00Z',
	methodology_version: 'history-1',
	publish_generation_id: 'list-generation',
	families: [
		{
			family: 'network',
			selection_mode: 'range',
			index_path: 'historic/history/network/index.json',
			first_available_date: '2026-05-01',
			last_available_date: '2026-11-10',
			gaps: [],
			metrics: [
				{
					metric: 'delay',
					aggregation: 'additive',
					first_available_date: '2026-06-13',
					last_available_date: '2026-11-10',
					gaps: [],
				},
				{
					metric: 'delay_percentiles',
					aggregation: 'daily_only',
					first_available_date: '2026-10-29',
					last_available_date: '2026-11-09',
					gaps: [{ start_date: '2026-11-02', end_date: '2026-11-03', reason: 'source outage' }],
				},
				{
					metric: 'occupancy',
					aggregation: 'additive',
					first_available_date: null,
					last_available_date: null,
				},
			],
		},
	],
});
const loaded = { data: index, loading: false, settled: true, error: null, reload: vi.fn() };

describe.each(['en', 'fr'] as const)('published history in %s', (locale) => {
	const t = historyDepthCopy[locale];
	it('shows the metric’s own dates and gap evidence, never the family’s wider bounds', () => {
		const { container } = render(HistoryDepth, {
			resource: loaded,
			locale,
			detailsHref: '/data-health',
		});
		const delay = container.querySelector('[data-metric="delay"]')!;
		const percentiles = container.querySelector('[data-metric="delay_percentiles"]')!;
		expect(delay.querySelector('[data-date="first"] time')).toHaveAttribute(
			'datetime',
			'2026-06-13',
		);
		expect(percentiles.querySelector('[data-date="first"] time')).toHaveAttribute(
			'datetime',
			'2026-10-29',
		);
		expect(percentiles.querySelector('[data-date="last"] time')).toHaveAttribute(
			'datetime',
			'2026-11-09',
		);
		expect(container.querySelector('time[datetime="2026-05-01"]')).toBeNull();
		expect(percentiles.querySelectorAll('[data-gaps] time')).toHaveLength(2);
		expect(percentiles.querySelector('[data-gaps]')).toHaveTextContent('source outage');
		expect(delay.querySelector('[data-gaps]')).toHaveTextContent(t.noGaps);
		expect(percentiles.querySelector('[data-limit]')).toHaveTextContent(
			healthCopy[locale].historyCoverage.aggregation.daily_only,
		);
		expect(screen.getByText(t.intro)).toBeInTheDocument();
		expect(screen.getByText(t.limits)).toBeInTheDocument();
	});
	it('keeps missing metric dates, missing gap lists and missing dimension inventory distinct from zero', () => {
		const { container } = render(HistoryDepth, {
			resource: loaded,
			locale,
			detailsHref: '/data-health',
		});
		const occupancy = container.querySelector('[data-metric="occupancy"]')!;
		expect(occupancy.querySelectorAll('time')).toHaveLength(0);
		expect(occupancy.querySelector('[data-date="first"]')).toHaveTextContent(t.unknown);
		expect(occupancy.querySelector('[data-date="last"]')).toHaveTextContent(t.unknown);
		expect(occupancy.querySelector('[data-gaps]')).toHaveTextContent(t.unknownGaps);
		expect(screen.getAllByText(t.noInventory)).toHaveLength(2);
	});
	it('states that an absent date list leaves depth unknown', () => {
		const { container } = render(HistoryDepth, {
			resource: { ...loaded, data: null },
			locale,
			detailsHref: '/status',
		});
		expect(screen.getByRole('status')).toHaveTextContent(t.noList);
		expect(container.querySelector('table')).toBeNull();
	});
	it('identifies retained data after a failed refresh with the original list’s own publication', () => {
		render(HistoryDepth, {
			resource: { ...loaded, error: new Error('offline') },
			locale,
			detailsHref: '/data-health',
		});
		expect(screen.getByRole('status')).toHaveTextContent(t.retained);
		expect(screen.getByText('list-generation')).toBeInTheDocument();
		expect(screen.getByText('history-1')).toBeInTheDocument();
		expect(screen.getByText('2026-11-11T07:11:00Z')).toBeInTheDocument();
	});
	it('keeps explanatory scope visible while the index loads or fails, without inventing rows', async () => {
		const { container, rerender } = render(HistoryDepth, {
			resource: { ...loaded, data: null, settled: false, loading: true },
			locale,
			detailsHref: '/data-health',
		});
		expect(screen.getByText(t.intro)).toBeInTheDocument();
		expect(container.querySelector('table')).toBeNull();
		await rerender({
			resource: { ...loaded, data: null, error: new Error('offline') },
			locale,
			detailsHref: '/data-health',
		});
		expect(container.querySelector('table')).toBeNull();
		expect(screen.getByText(t.limits)).toBeInTheDocument();
		expect(within(container).getByRole('button')).toBeInTheDocument();
	});
});
