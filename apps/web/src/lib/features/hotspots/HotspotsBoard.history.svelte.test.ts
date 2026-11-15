import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataRefresh } from '#lib/stores/index.ts';
import type {
	HistoricCollectionIndex,
	HistoricHotspotsDay,
	Hotspots,
	IsoUtc,
} from '#lib/v1/schemas/index.ts';

const harness = vi.hoisted(() => {
	const state = {
		url: new URL('http://localhost/hotspots'),
	};
	const page = {
		get url() {
			return state.url;
		},
		state: {},
	};
	const replaceState = vi.fn((url: string | URL) => {
		state.url = new URL(url, 'http://localhost');
	});
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
		replaceState,
		mirrorSearchParams,
		goto: vi.fn(),
		locale: { value: 'en' as 'en' | 'fr' },
		getHotspots: vi.fn(),
		getHotspotsHistoryIndex: vi.fn(),
		getHotspotsHistoryDay: vi.fn(),
	};
});

vi.mock('$app/state', () => ({ page: harness.page }));
vi.mock('$app/navigation', () => ({
	afterNavigate: () => {},
	replaceState: harness.replaceState,
	goto: harness.goto,
}));
vi.mock('#lib/site/urlMirror.ts', () => ({
	mirrorSearchParams: harness.mirrorSearchParams,
}));
vi.mock('#lib/i18n/index.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/i18n/index.ts')>();
	return { ...actual, getLocale: () => harness.locale.value };
});
vi.mock('#lib/v1/repositories/historic.ts', () => ({
	getHotspots: harness.getHotspots,
	getHotspotsHistoryIndex: harness.getHotspotsHistoryIndex,
	getHotspotsHistoryDay: harness.getHotspotsHistoryDay,
}));

import HotspotsBoard from './HotspotsBoard.svelte';

const AVAILABLE_DATES = ['2026-06-20', '2026-06-22', '2026-06-25'] as const;

const historyIndex: HistoricCollectionIndex = {
	generated_utc: '2026-07-01T00:00:00Z' as IsoUtc,
	family: 'hotspots',
	selection_mode: 'date',
	collection_generation_id: 'a'.repeat(64),
	available_dates: [...AVAILABLE_DATES],
};

/** A file anchored to `date`: its week ends there, as the retained day schema requires. */
function payload(
	label: string,
	generatedUtc: string,
	options: { empty?: boolean; rankedEmpty?: boolean; date?: string } = {},
): Hotspots | HistoricHotspotsDay {
	const end = options.date ?? '2026-06-25';
	const start = new Date(Date.parse(`${end}T00:00:00Z`) - 6 * 86_400_000)
		.toISOString()
		.slice(0, 10);
	const value: Hotspots = {
		generated_utc: generatedUtc as IsoUtc,
		hotspots: [],
		by_grain: [
			{
				grain: 'week',
				date: start,
				window_end: end,
				entries:
					options.empty || options.rankedEmpty
						? []
						: [
								{
									rank: 1,
									type: 'route',
									id: '161',
									name: `${label} line`,
									severe_pct: 50,
									severe_count: 60,
									observation_count: 120,
								},
								{
									rank: 1,
									type: 'stop',
									id: 'S1',
									name: `${label} stop`,
									severe_pct: 50,
									severe_count: 45,
									observation_count: 90,
								},
							],
				tray: options.empty
					? []
					: [
							{
								type: 'route',
								id: 'R-null',
								name: `${label} null tray`,
								severe_pct: 4,
								observation_count: null,
							},
							{
								type: 'stop',
								id: 'S-zero',
								name: `${label} zero tray`,
								severe_pct: 0,
								observation_count: 0,
							},
						],
				total_ranked_routes: options.empty || options.rankedEmpty ? 0 : 1,
				total_ranked_stops: options.empty || options.rankedEmpty ? 0 : 1,
				tray_total: options.empty ? 0 : 2,
			},
		],
	};
	return options.date ? { ...value, date: options.date } : value;
}

const current = payload('Current', '2026-06-25T12:00:00Z') as Hotspots;
const retained20 = payload('Retained 20', '2026-06-20T23:59:59Z', {
	date: '2026-06-20',
}) as HistoricHotspotsDay;
const retained22 = payload('Retained 22', '2026-06-22T23:59:59Z', {
	date: '2026-06-22',
}) as HistoricHotspotsDay;

function reset(url = 'http://localhost/hotspots'): void {
	harness.state.url = new URL(url);
	harness.locale.value = 'en';
	harness.replaceState.mockClear();
	harness.mirrorSearchParams.mockClear();
	harness.goto.mockClear();
	harness.getHotspots.mockReset().mockResolvedValue(current);
	harness.getHotspotsHistoryIndex.mockReset().mockResolvedValue(historyIndex);
	harness.getHotspotsHistoryDay.mockReset().mockImplementation(async (date: string) => {
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

function desktopRail(container: HTMLElement): HTMLElement {
	const rail = container.querySelector<HTMLElement>('[data-slot="surface-rail"]');
	if (!rail) throw new Error('Expected the desktop Hotspots rail');
	return rail;
}

const finding = (label: string) => `First-ranked line: ${label} line.`;

beforeEach(() => reset());
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe('HotspotsBoard retained date history', () => {
	it('keeps the current record while discovering dates without fetching a day artifact', async () => {
		const { container } = render(HotspotsBoard);
		await screen.findByRole('heading', { name: finding('Current') });
		await waitFor(() => expect(harness.getHotspotsHistoryIndex).toHaveBeenCalledTimes(1));

		expect(harness.getHotspots).toHaveBeenCalledTimes(1);
		expect(harness.getHotspotsHistoryDay).not.toHaveBeenCalled();
		const rail = desktopRail(container);
		expect(within(rail).getByLabelText('History date')).toHaveValue('2026-06-25');
		expect(rail.querySelector('[data-slot="grain-picker"]')).toBeNull();
		expect(
			container.querySelector('[data-slot="hotspots-controls"] [data-slot="grain-picker"]'),
		).not.toBeNull();
	});

	it('falls back to the current record when optional discovery is missing', async () => {
		reset('http://localhost/hotspots?date=2026-06-20&campaign=walk');
		harness.getHotspotsHistoryIndex.mockResolvedValue(null);
		const { container } = render(HotspotsBoard);

		await screen.findByRole('heading', { name: finding('Current') });
		expect(harness.getHotspots).toHaveBeenCalledTimes(1);
		expect(harness.getHotspotsHistoryDay).not.toHaveBeenCalled();
		expect(container.querySelector('[data-slot="history-navigator"]')).toBeNull();
		expect(harness.state.url.searchParams.get('campaign')).toBe('walk');
	});

	it('reads an older artifact and keeps its dates in the record links and the URL', async () => {
		reset('http://localhost/hotspots?date=2026-06-22&n=5&kind=stops&campaign=walk');
		const { container } = render(HotspotsBoard);

		await screen.findByRole('heading', { name: 'First-ranked stop: Retained 22 stop.' });
		expect(harness.getHotspots).not.toHaveBeenCalled();
		expect(harness.getHotspotsHistoryDay).toHaveBeenCalledWith(
			'2026-06-22',
			historyIndex,
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(container.querySelector('[data-slot="hotspots-period"]')).toHaveTextContent(
			'June 16 to 22, 2026, 7 complete days.',
		);
		expect(container.querySelector('time[datetime="2026-06-22"]')).not.toBeNull();
		expect(
			within(screen.getByRole('list', { name: 'Published excluded stops' })).getByRole('link'),
		).toHaveAttribute('href', '/stop/S-zero?from=2026-06-16&to=2026-06-22');
		expect(harness.state.url.searchParams.get('campaign')).toBe('walk');
		expect(harness.state.url.searchParams.get('date')).toBe('2026-06-22');
		expect(harness.state.url.searchParams.get('kind')).toBe('stops');
		expect(harness.state.url.searchParams.get('n')).toBe('5');
	});

	it('keeps retained excluded rows when no line ranks, with readings and no invented zero', async () => {
		reset('http://localhost/hotspots?date=2026-06-20');
		harness.getHotspotsHistoryDay.mockResolvedValue(
			payload('Retained tray only', '2026-06-20T23:59:59Z', {
				date: '2026-06-20',
				rankedEmpty: true,
			}),
		);
		render(HotspotsBoard);

		await screen.findByRole('heading', { name: 'No line ranks for these dates.' });
		const excluded = screen.getByRole('list', { name: 'Published excluded lines' });
		const nullRow = within(excluded).getByText('Retained tray only null tray').closest('li')!;
		expect(nullRow).toHaveTextContent('Reading count not published');
		expect(nullRow).not.toHaveTextContent(/\b0\b/);
	});

	it('canonicalizes an explicit latest date to current and cleans only date', async () => {
		reset('http://localhost/hotspots?date=2026-06-25&grain=month&campaign=walk');
		render(HotspotsBoard);

		await screen.findByRole('heading', { name: finding('Current') });
		await waitFor(() => expect(harness.state.url.searchParams.get('date')).toBeNull());
		expect(harness.getHotspots).toHaveBeenCalledTimes(1);
		expect(harness.getHotspotsHistoryDay).not.toHaveBeenCalled();
		expect(harness.state.url.searchParams.get('campaign')).toBe('walk');
	});

	it.each([
		['2026-06-25', null],
		['2026-06-21', 'That day was not published. Showing the latest hotspots.'],
	] as const)(
		'forgets cleaned explicit date %s so a later discovery refresh cannot resurrect it',
		async (rawDate, correction) => {
			reset(`http://localhost/hotspots?date=${rawDate}`);
			const newlyAdvertised = payload('Newly advertised', '2026-06-25T23:59:59Z', {
				date: rawDate,
			}) as HistoricHotspotsDay;
			harness.getHotspotsHistoryDay.mockResolvedValue(newlyAdvertised);
			const { container } = render(HotspotsBoard);

			await screen.findByRole('heading', { name: finding('Current') });
			await waitFor(() => expect(harness.state.url.searchParams.get('date')).toBeNull());
			if (correction) {
				expect(
					container.querySelector('[data-slot="history-page-announcement"]'),
				).toHaveTextContent(correction);
			}

			harness.getHotspotsHistoryIndex.mockResolvedValue({
				...historyIndex,
				available_dates: ['2026-06-20', '2026-06-21', '2026-06-25', '2026-06-26'],
			});
			dataRefresh.bumpEpoch();
			await waitFor(() => expect(harness.getHotspotsHistoryIndex).toHaveBeenCalledTimes(2));
			await waitFor(() => expect(harness.getHotspots).toHaveBeenCalledTimes(2));
			expect(harness.getHotspotsHistoryDay).not.toHaveBeenCalled();
			expect(screen.queryByText(/Newly advertised line/)).toBeNull();
			expect(harness.state.url.searchParams.get('date')).toBeNull();
		},
	);

	it.each([
		['not-a-date', 'That date was not valid. Showing the latest hotspots.'],
		['2026-06-21', 'That day was not published. Showing the latest hotspots.'],
	] as const)('corrects %s once to current with an honest announcement', async (date, message) => {
		reset(`http://localhost/hotspots?date=${date}&campaign=walk`);
		const { container } = render(HotspotsBoard);

		await screen.findByRole('heading', { name: finding('Current') });
		const rail = desktopRail(container);
		await waitFor(() =>
			expect(rail.querySelector('[data-slot="history-announcement"]')).toHaveTextContent(message),
		);
		const announcements = container.querySelectorAll('[data-slot="history-page-announcement"]');
		expect(announcements).toHaveLength(1);
		expect(announcements[0]).toHaveTextContent(message);
		expect(announcements[0]).toHaveAttribute('aria-live', 'polite');
		expect(harness.getHotspotsHistoryDay).not.toHaveBeenCalled();
		expect(harness.state.url.searchParams.get('date')).toBeNull();
		expect(harness.state.url.searchParams.get('campaign')).toBe('walk');
	});

	it('uses gap-skipping neighbors and suppresses an aborted stale date completion', async () => {
		reset('http://localhost/hotspots?date=2026-06-20');
		const stale = deferred<HistoricHotspotsDay>();
		let staleSignal: AbortSignal | undefined;
		harness.getHotspotsHistoryDay.mockImplementation(
			(date: string, _index: HistoricCollectionIndex, ctx: { signal: AbortSignal }) => {
				if (date === '2026-06-20') {
					staleSignal = ctx.signal;
					return stale.promise;
				}
				return Promise.resolve(retained22);
			},
		);
		const { container } = render(HotspotsBoard);
		await waitFor(() => expect(harness.getHotspotsHistoryDay).toHaveBeenCalledTimes(1));
		const rail = desktopRail(container);
		expect(within(rail).getByRole('button', { name: 'Previous date' })).toBeDisabled();
		expect(within(rail).getByRole('button', { name: 'Next date' })).not.toBeDisabled();

		await fireEvent.click(within(rail).getByRole('button', { name: 'Next date' }));
		await screen.findByRole('heading', { name: finding('Retained 22') });
		expect(staleSignal?.aborted).toBe(true);
		stale.resolve(retained20);
		await Promise.resolve();
		expect(screen.queryByText(/Retained 20 line/)).toBeNull();
		expect(harness.state.url.searchParams.get('date')).toBe('2026-06-22');
	});

	it('mirrors date, period, n, kind and selection atomically without clobbering others', async () => {
		reset('http://localhost/hotspots?date=2026-06-20&n=5&kind=stops&campaign=walk');
		const { container } = render(HotspotsBoard);
		await screen.findByRole('heading', { name: 'First-ranked stop: Retained 20 stop.' });
		const rail = desktopRail(container);

		await fireEvent.click(within(rail).getByRole('button', { name: 'Next date' }));
		await screen.findByRole('heading', { name: 'First-ranked stop: Retained 22 stop.' });
		await waitFor(() =>
			expect(harness.mirrorSearchParams).toHaveBeenLastCalledWith({
				grain: null,
				date: '2026-06-22',
				n: '5',
				kind: 'stops',
				selected: null,
			}),
		);
		for (const [values] of harness.mirrorSearchParams.mock.calls) {
			expect(Object.keys(values).sort()).toEqual(['date', 'grain', 'kind', 'n', 'selected']);
		}
		expect(harness.state.url.searchParams.get('campaign')).toBe('walk');
	});

	it('keeps an advertised missing day visibly retryable and never substitutes current', async () => {
		reset('http://localhost/hotspots?date=2026-06-22');
		harness.getHotspotsHistoryDay
			.mockRejectedValueOnce(new Error('advertised history artifact not found'))
			.mockResolvedValueOnce(retained22);
		render(HotspotsBoard);

		const retry = await screen.findByRole('button', { name: 'Retry' });
		expect(screen.queryByText(/Current line/)).toBeNull();
		expect(harness.getHotspots).not.toHaveBeenCalled();
		await fireEvent.click(retry);
		await screen.findByRole('heading', { name: finding('Retained 22') });
		expect(harness.getHotspotsHistoryDay).toHaveBeenCalledTimes(2);
	});

	it('keeps the navigator rail on a published-empty retained day', async () => {
		reset('http://localhost/hotspots?date=2026-06-20');
		harness.getHotspotsHistoryDay.mockResolvedValue(
			payload('Empty retained', '2026-06-20T23:59:59Z', {
				date: '2026-06-20',
				empty: true,
			}),
		);
		const { container } = render(HotspotsBoard);

		await screen.findByRole('heading', { name: 'No line ranks for these dates.' });
		expect(within(desktopRail(container)).getByLabelText('History date')).toHaveValue('2026-06-20');
		expect(container.querySelector('[data-slot="hotspot-rows"]')).toBeNull();
	});

	it('refetches the selected historical lane globally and shows its accepted timestamp', async () => {
		reset('http://localhost/hotspots?date=2026-06-22');
		render(HotspotsBoard);
		await screen.findByRole('heading', { name: finding('Retained 22') });

		expect(document.querySelector('.header__meta time')).toHaveAttribute('datetime', '2026-06-22');
		dataRefresh.bumpEpoch();
		await waitFor(() => expect(harness.getHotspotsHistoryDay).toHaveBeenCalledTimes(2));
		expect(harness.getHotspots).not.toHaveBeenCalled();
		expect(harness.state.url.searchParams.get('date')).toBe('2026-06-22');
	});
});
