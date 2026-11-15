import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	HistoricCollectionIndex,
	HistoricRepeatOffendersDay,
	IsoUtc,
	RepeatOffenders as RepeatOffendersData,
} from '#lib/v1/schemas/index.ts';

const harness = vi.hoisted(() => {
	const state = { url: new URL('http://localhost/repeat-offenders') };
	const page = {
		get url() {
			return state.url;
		},
		state: {},
	};
	const mirrorSearchParams = vi.fn((values: Record<string, string | null>) => {
		const next = new URL(state.url);
		for (const [key, value] of Object.entries(values)) {
			if (value == null) next.searchParams.delete(key);
			else next.searchParams.set(key, value);
		}
		state.url = next;
	});
	return {
		state,
		page,
		mirrorSearchParams,
		replaceState: vi.fn((url: string | URL) => {
			state.url = new URL(url, 'http://localhost');
		}),
		getRepeatOffenders: vi.fn(),
		getRepeatOffendersHistoryIndex: vi.fn(),
		getRepeatOffendersHistoryDay: vi.fn(),
	};
});

vi.mock('$app/state', () => ({ page: harness.page }));
vi.mock('$app/navigation', () => ({
	afterNavigate: () => {},
	replaceState: harness.replaceState,
	goto: vi.fn(),
}));
vi.mock('#lib/site/urlMirror.ts', () => ({ mirrorSearchParams: harness.mirrorSearchParams }));
vi.mock('#lib/v1/repositories/historic.ts', () => ({
	getRepeatOffenders: harness.getRepeatOffenders,
	getRepeatOffendersHistoryIndex: harness.getRepeatOffendersHistoryIndex,
	getRepeatOffendersHistoryDay: harness.getRepeatOffendersHistoryDay,
}));

import RepeatOffenders from './RepeatOffenders.svelte';

const AVAILABLE_DATES = ['2026-06-20', '2026-06-22', '2026-06-25'] as const;
const historyIndex: HistoricCollectionIndex = {
	generated_utc: '2026-07-01T00:00:00Z' as IsoUtc,
	family: 'repeat_offenders',
	selection_mode: 'date',
	collection_generation_id: 'a'.repeat(64),
	available_dates: [...AVAILABLE_DATES],
};

/**
 * One week whose trip and bus carry `label` as their line name. A retained day names its
 * dates; the current file, like today's public one, does not.
 */
function payload(
	label: string,
	generatedUtc: string,
	options: { date?: string; empty?: boolean } = {},
): RepeatOffendersData & HistoricRepeatOffendersDay {
	const entry = (type: 'trip' | 'vehicle', id: string) => ({
		rank: 1,
		type,
		id,
		route: '161',
		route_name: `${label} line`,
		observation_count: 120,
		severe_count: 60,
		severe_pct: 50,
		recurrence_days: 3,
		observed_days: 4,
		window_days: 7,
		avg_delay_min: 9.5,
	});
	const end = options.date;
	const start = end
		? new Date(Date.parse(`${end}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10)
		: null;
	const value = {
		generated_utc: generatedUtc as IsoUtc,
		methodology_version: 'reliability-2',
		by_grain: [
			{
				grain: 'week',
				window_days: 7,
				...(end ? { date: start, window_end: end } : {}),
				entries: options.empty ? [] : [entry('trip', 'T1'), entry('vehicle', 'B1')],
				tray: [],
				total_ranked_trips: options.empty ? 0 : 1,
				total_ranked_vehicles: options.empty ? 0 : 1,
				tray_total: 0,
			},
		],
	};
	// One fixture serves both lanes: the current file and a retained day.
	return (end ? { ...value, date: end } : value) as RepeatOffendersData &
		HistoricRepeatOffendersDay;
}

const current = payload('Current', '2026-06-25T12:00:00Z');
const retained20 = payload('Retained 20', '2026-06-20T23:59:59Z', { date: '2026-06-20' });
const retained22 = payload('Retained 22', '2026-06-22T23:59:59Z', { date: '2026-06-22' });

function reset(url = 'http://localhost/repeat-offenders'): void {
	harness.state.url = new URL(url);
	harness.replaceState.mockClear();
	harness.mirrorSearchParams.mockClear();
	harness.getRepeatOffenders.mockReset().mockResolvedValue(current);
	harness.getRepeatOffendersHistoryIndex.mockReset().mockResolvedValue(historyIndex);
	harness.getRepeatOffendersHistoryDay.mockReset().mockImplementation(async (date: string) => {
		if (date === '2026-06-20') return retained20;
		if (date === '2026-06-22') return retained22;
		throw new Error(`Unexpected retained date ${date}`);
	});
	sessionStorage.clear();
	localStorage.clear();
	Element.prototype.scrollIntoView = vi.fn();
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => (resolve = done));
	return { promise, resolve };
}

function controlsOf(container: HTMLElement): HTMLElement {
	const controls = container.querySelector<HTMLElement>('[data-slot="offenders-controls"]');
	if (!controls) throw new Error('Expected the ranking controls');
	return controls;
}

const finding = (label: string) => `First-ranked trip: Trip T1 on line 161 (${label} line).`;

beforeEach(() => reset());
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('RepeatOffenders retained date history', () => {
	it('shows the ranking with its history controls once discovery settles, without a day fetch', async () => {
		const discovery = deferred<HistoricCollectionIndex>();
		harness.getRepeatOffendersHistoryIndex.mockReturnValue(discovery.promise);
		const { container } = render(RepeatOffenders);
		await waitFor(() => expect(harness.getRepeatOffenders).toHaveBeenCalledTimes(1));
		await new Promise((done) => setTimeout(done, 20));

		// Nothing below the controls appears until it can stay where it lands.
		expect(container.querySelector('[data-slot="offenders-finding"]')).toBeNull();
		discovery.resolve(historyIndex);
		await screen.findByRole('heading', { name: finding('Current') });
		const controls = controlsOf(container);
		expect(controls).toHaveAccessibleName('Ranking controls');
		expect(within(controls).getByLabelText('History date')).toHaveValue('2026-06-25');
		expect(container.querySelector('[data-slot="surface-rail"]')).toBeNull();
		expect(harness.getRepeatOffendersHistoryDay).not.toHaveBeenCalled();
	});

	it('falls back to the current record when optional discovery is missing', async () => {
		reset('http://localhost/repeat-offenders?date=2026-06-20&campaign=walk');
		harness.getRepeatOffendersHistoryIndex.mockResolvedValue(null);
		const { container } = render(RepeatOffenders);

		await screen.findByRole('heading', { name: finding('Current') });
		expect(harness.getRepeatOffendersHistoryDay).not.toHaveBeenCalled();
		expect(container.querySelector('[data-slot="history-navigator"]')).toBeNull();
		expect(harness.state.url.searchParams.get('campaign')).toBe('walk');
	});

	it('reads an older day and keeps its dates in the period, record links and URL', async () => {
		reset('http://localhost/repeat-offenders?date=2026-06-22&n=5&kind=buses&campaign=walk');
		const { container } = render(RepeatOffenders);

		await screen.findByRole('heading', {
			name: 'First-ranked bus: Bus B1 on line 161 (Retained 22 line).',
		});
		expect(harness.getRepeatOffenders).not.toHaveBeenCalled();
		expect(container.querySelector('[data-slot="offenders-period"]')).toHaveTextContent(
			'June 16 to 22, 2026, 7 complete days.',
		);
		await fireEvent.click(within(screen.getByRole('list', { name: 'Buses' })).getByRole('button'));
		expect(
			container.querySelector('[data-slot="offender-row-evidence"]:not([hidden]) a'),
		).toHaveAttribute('href', '/lines/161?from=2026-06-16&to=2026-06-22');
		expect(harness.state.url.searchParams.get('campaign')).toBe('walk');
		expect(harness.state.url.searchParams.get('date')).toBe('2026-06-22');
		expect(harness.state.url.searchParams.get('kind')).toBe('buses');
		expect(harness.state.url.searchParams.get('n')).toBe('5');
	});

	it.each([
		['not-a-date', 'That date was not valid. Showing the latest repeat offenders.'],
		['2026-06-21', 'That day was not published. Showing the latest repeat offenders.'],
	] as const)('corrects %s once to current with an honest announcement', async (date, message) => {
		reset(`http://localhost/repeat-offenders?date=${date}&campaign=walk`);
		const { container } = render(RepeatOffenders);

		await screen.findByRole('heading', { name: finding('Current') });
		const announcements = container.querySelectorAll('[data-slot="history-page-announcement"]');
		await waitFor(() => expect(announcements[0]).toHaveTextContent(message));
		expect(announcements).toHaveLength(1);
		expect(harness.getRepeatOffendersHistoryDay).not.toHaveBeenCalled();
		expect(harness.state.url.searchParams.get('date')).toBeNull();
		expect(harness.state.url.searchParams.get('campaign')).toBe('walk');
	});

	it('uses gap-skipping neighbours, drops a stale day and mirrors every owned parameter', async () => {
		reset('http://localhost/repeat-offenders?date=2026-06-20&n=5&campaign=walk');
		const stale = deferred<HistoricRepeatOffendersDay>();
		let staleSignal: AbortSignal | undefined;
		harness.getRepeatOffendersHistoryDay.mockImplementation(
			(date: string, _index: HistoricCollectionIndex, ctx: { signal: AbortSignal }) => {
				if (date === '2026-06-20') {
					staleSignal = ctx.signal;
					return stale.promise;
				}
				return Promise.resolve(retained22);
			},
		);
		const { container } = render(RepeatOffenders);
		await waitFor(() => expect(harness.getRepeatOffendersHistoryDay).toHaveBeenCalledTimes(1));
		const controls = controlsOf(container);
		expect(within(controls).getByRole('button', { name: 'Previous date' })).toBeDisabled();

		await fireEvent.click(within(controls).getByRole('button', { name: 'Next date' }));
		await screen.findByRole('heading', { name: finding('Retained 22') });
		expect(staleSignal?.aborted).toBe(true);
		stale.resolve(retained20);
		await Promise.resolve();
		expect(screen.queryByText(/Retained 20 line/)).toBeNull();
		await waitFor(() =>
			expect(harness.mirrorSearchParams).toHaveBeenLastCalledWith({
				grain: null,
				date: '2026-06-22',
				n: '5',
				kind: null,
				selected: null,
			}),
		);
		expect(harness.state.url.searchParams.get('campaign')).toBe('walk');
	});

	it('keeps an advertised missing day retryable and never substitutes current', async () => {
		reset('http://localhost/repeat-offenders?date=2026-06-22');
		harness.getRepeatOffendersHistoryDay
			.mockRejectedValueOnce(new Error('advertised history artifact not found'))
			.mockResolvedValueOnce(retained22);
		render(RepeatOffenders);

		const retry = await screen.findByRole('button', { name: 'Retry' });
		expect(screen.queryByText(/Current line/)).toBeNull();
		expect(harness.getRepeatOffenders).not.toHaveBeenCalled();
		await fireEvent.click(retry);
		await screen.findByRole('heading', { name: finding('Retained 22') });
	});

	it('keeps the navigator on a published-empty retained day', async () => {
		reset('http://localhost/repeat-offenders?date=2026-06-20');
		harness.getRepeatOffendersHistoryDay.mockResolvedValue(
			payload('Empty', '2026-06-20T23:59:59Z', { date: '2026-06-20', empty: true }),
		);
		const { container } = render(RepeatOffenders);

		await screen.findByRole('heading', { name: 'No trip meets the ranking rule for these dates.' });
		expect(within(controlsOf(container)).getByLabelText('History date')).toHaveValue('2026-06-20');
		expect(container.querySelector('[data-slot="offender-rows"]')).toBeNull();
		expect(screen.getByText('This record lists no trip below the rule.')).toBeInTheDocument();
	});

	it('copies a latest-record link that still opens that record after a newer day is published', async () => {
		const writeText = vi.fn(async (_text: string) => {});
		vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
		const { unmount } = render(RepeatOffenders);
		await screen.findByRole('heading', { name: finding('Current') });
		await fireEvent.click(within(screen.getByRole('list', { name: 'Trips' })).getByRole('button'));
		const evidence = document.querySelector(
			'[data-slot="offender-row-evidence"]:not([hidden])',
		) as HTMLElement;
		await fireEvent.click(within(evidence).getByRole('button', { name: 'Copy link' }));
		const link = writeText.mock.lastCall![0];
		// The current file names no dates; the history it was discovered with ends on the 25th.
		expect(link).toBe('http://localhost/repeat-offenders?date=2026-06-25&selected=T1%40161');
		unmount();

		reset(link);
		harness.getRepeatOffendersHistoryIndex.mockResolvedValue({
			...historyIndex,
			available_dates: [...AVAILABLE_DATES, '2026-06-26'],
		});
		harness.getRepeatOffendersHistoryDay.mockResolvedValue(
			payload('Retained 25', '2026-06-25T23:59:59Z', { date: '2026-06-25' }),
		);
		render(RepeatOffenders);
		await screen.findByRole('heading', { name: finding('Retained 25') });
		expect(harness.getRepeatOffendersHistoryDay).toHaveBeenCalledWith(
			'2026-06-25',
			expect.anything(),
			expect.anything(),
		);
		expect(harness.getRepeatOffenders).not.toHaveBeenCalled();
	});
});
