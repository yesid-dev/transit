import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataRefresh } from '#lib/stores/index.ts';
import type {
	HistoricCollectionIndex,
	HistoricRepeatOffendersDay,
	IsoUtc,
	RepeatOffenders,
} from '#lib/v1/schemas/index.ts';

const harness = vi.hoisted(() => {
	const state = { url: new URL('http://localhost/repeat-offenders') };
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
		getRepeatOffenders: vi.fn(),
		getRepeatOffendersHistoryIndex: vi.fn(),
		getRepeatOffendersHistoryDay: vi.fn(),
		capturedLadders: [] as Array<{ entries: readonly unknown[]; result: unknown }>,
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
	getRepeatOffenders: harness.getRepeatOffenders,
	getRepeatOffendersHistoryIndex: harness.getRepeatOffendersHistoryIndex,
	getRepeatOffendersHistoryDay: harness.getRepeatOffendersHistoryDay,
}));
vi.mock('./selectors/offenderLadder', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./selectors/offenderLadder')>();
	return {
		...actual,
		selectOffenderLadder: (...args: Parameters<typeof actual.selectOffenderLadder>) => {
			const result = actual.selectOffenderLadder(...args);
			harness.capturedLadders.push({ entries: args[0], result });
			return result;
		},
	};
});

import RepeatOffendersBoard from './RepeatOffenders.svelte';
import { copy as repeatCopy } from './repeatOffenders.copy';

const AVAILABLE_DATES = ['2026-06-20', '2026-06-22', '2026-06-25'] as const;
const historyIndex: HistoricCollectionIndex = {
	generated_utc: '2026-07-01T00:00:00Z' as IsoUtc,
	family: 'repeat_offenders',
	selection_mode: 'date',
	collection_generation_id: 'b'.repeat(64),
	available_dates: [...AVAILABLE_DATES],
};

function windowStart(date: string, days: number): string {
	const value = new Date(`${date}T00:00:00Z`);
	value.setUTCDate(value.getUTCDate() - (days - 1));
	return value.toISOString().slice(0, 10);
}

function payload(
	label: string,
	generatedUtc: string,
	options: { date?: string; empty?: boolean } = {},
): RepeatOffenders | HistoricRepeatOffendersDay {
	const endpoint = options.date ?? '2026-06-25';
	const entries = options.empty
		? []
		: [
				{
					rank: 1,
					type: 'trip',
					id: `${label}-trip`,
					route: '11',
					route_name: `${label} trip`,
					severe_pct: 62,
					observation_count: 210,
					wilson_lo: 30,
					wilson_hi: 44,
					recurrence_days: 5,
					observed_days: 7,
					avg_delay_min: 9.4,
				},
				{
					rank: 1,
					type: 'vehicle',
					id: `${label}-vehicle`,
					route: '55',
					route_name: `${label} vehicle`,
					severe_pct: 48,
					observation_count: 180,
					recurrence_days: 4,
					observed_days: 6,
					avg_delay_min: 7,
				},
			];
	const value: RepeatOffenders = {
		generated_utc: generatedUtc as IsoUtc,
		offenders: [],
		by_grain: [
			{
				grain: 'week',
				window_days: 7,
				total_ranked_trips: entries.length === 0 ? 0 : 1,
				total_ranked_vehicles: entries.length === 0 ? 0 : 1,
				entries,
				tray: [],
				...(options.date ? { date: windowStart(endpoint, 7), window_end: endpoint } : {}),
			},
			{
				grain: 'month',
				window_days: 30,
				total_ranked_trips: entries.length === 0 ? 0 : 1,
				total_ranked_vehicles: entries.length === 0 ? 0 : 1,
				entries,
				tray: [],
				...(options.date ? { date: windowStart(endpoint, 30), window_end: endpoint } : {}),
			},
		],
	};
	return options.date ? ({ ...value, date: options.date } as HistoricRepeatOffendersDay) : value;
}

const current = payload('Current', '2026-06-25T12:00:00Z') as RepeatOffenders;
const retained20 = payload('Retained 20', '2026-06-20T23:59:59Z', {
	date: '2026-06-20',
}) as HistoricRepeatOffendersDay;
const retained22 = payload('Retained 22', '2026-06-22T23:59:59Z', {
	date: '2026-06-22',
}) as HistoricRepeatOffendersDay;

function reset(url = 'http://localhost/repeat-offenders'): void {
	harness.state.url = new URL(url);
	harness.locale.value = 'en';
	harness.replaceState.mockClear();
	harness.mirrorSearchParams.mockClear();
	harness.goto.mockClear();
	harness.getRepeatOffenders.mockReset().mockResolvedValue(current);
	harness.getRepeatOffendersHistoryIndex.mockReset().mockResolvedValue(historyIndex);
	harness.getRepeatOffendersHistoryDay.mockReset().mockImplementation(async (date: string) => {
		if (date === '2026-06-20') return retained20;
		if (date === '2026-06-22') return retained22;
		throw new Error(`Unexpected retained date ${date}`);
	});
	harness.capturedLadders = [];
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
	if (!rail) throw new Error('Expected the desktop Repeat Offenders rail');
	return rail;
}

beforeEach(() => reset());
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

describe('RepeatOffenders retained date history', () => {
	it('keeps an old one-day recurrence out of retained rankings', async () => {
		reset('http://localhost/repeat-offenders?date=2026-06-22');
		const retained = structuredClone(retained22);
		for (const grain of retained.by_grain ?? []) {
			Object.assign(grain.entries[0], { recurrence_days: 1, observed_days: 3 });
		}
		harness.getRepeatOffendersHistoryDay.mockResolvedValue(retained);
		const { container } = render(RepeatOffendersBoard);
		await waitFor(() =>
			expect(container.querySelector('[data-slot="offender-tray"]')).not.toBeNull(),
		);
		expect(JSON.stringify(harness.capturedLadders.map((item) => item.entries))).not.toContain(
			'Retained 22-trip',
		);
	});

	it('keeps current data intact while discovering optional dates without fetching a day artifact', async () => {
		const { container } = render(RepeatOffendersBoard);
		await screen.findAllByText('Current trip');
		await waitFor(() => expect(harness.getRepeatOffendersHistoryIndex).toHaveBeenCalledTimes(1));

		expect(harness.getRepeatOffenders).toHaveBeenCalledTimes(1);
		expect(harness.getRepeatOffendersHistoryDay).not.toHaveBeenCalled();
		const rail = desktopRail(container);
		expect(within(rail).getByLabelText('History date')).toHaveValue('2026-06-25');
		expect(rail.querySelector('[data-slot="history-navigator"]')).not.toBeNull();
		expect(
			rail
				.querySelector('[data-slot="history-navigator"]')
				?.compareDocumentPosition(rail.querySelector('[data-slot="grain-picker"]')!),
		).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
		expect(screen.getByTestId('sections-controls').querySelectorAll('button')).toHaveLength(1);
		expect(screen.getAllByRole('link', { name: /Current trip/ })[0]).toHaveAttribute(
			'href',
			'/lines/11',
		);
		const mobile = container.querySelector('[data-slot="surface-rail-mobile"]') as HTMLElement;
		await fireEvent.click(mobile.querySelector(':scope > button') as HTMLButtonElement);
		const sheet = mobile.querySelector('[role="dialog"]') as HTMLElement;
		const mobileHistory = sheet.querySelector('[data-slot="history-navigator"]')!;
		const mobileGrain = sheet.querySelector('[data-slot="grain-picker"]')!;
		expect(mobileHistory.compareDocumentPosition(mobileGrain)).toBe(
			Node.DOCUMENT_POSITION_FOLLOWING,
		);
	});

	it('falls back to current and removes only date when optional discovery is missing', async () => {
		reset('http://localhost/repeat-offenders?date=2026-06-20&grain=month&campaign=walk');
		harness.getRepeatOffendersHistoryIndex.mockResolvedValue(null);
		const { container } = render(RepeatOffendersBoard);

		await screen.findAllByText('Current trip');
		await waitFor(() => expect(harness.state.url.searchParams.get('date')).toBeNull());
		expect(harness.getRepeatOffendersHistoryDay).not.toHaveBeenCalled();
		expect(container.querySelector('[data-slot="history-navigator"]')).toBeNull();
		expect(harness.state.url.searchParams.get('grain')).toBe('month');
		expect(harness.state.url.searchParams.get('campaign')).toBe('walk');
	});

	it('loads only a valid older artifact and derives cards, timestamp, captions, and links from it', async () => {
		reset('http://localhost/repeat-offenders?date=2026-06-22&grain=month&n=5&campaign=walk');
		const { container } = render(RepeatOffendersBoard);

		await screen.findAllByText('Retained 22 trip');
		expect(harness.getRepeatOffenders).not.toHaveBeenCalled();
		expect(harness.getRepeatOffendersHistoryDay).toHaveBeenCalledWith(
			'2026-06-22',
			historyIndex,
			expect.objectContaining({ signal: expect.any(AbortSignal) }),
		);
		expect(screen.queryByText(/Current trip/)).toBeNull();
		expect(screen.getAllByText(/Available retained observations ending/)[0]).toHaveTextContent(
			'Jun 22',
		);
		expect(container.querySelector('time[datetime="2026-06-22"]')).not.toBeNull();
		const link = screen.getAllByRole('link', { name: /Retained 22 trip/ })[0];
		expect(link).toHaveAttribute('href', '/lines/11');
		expect(link.getAttribute('href')).not.toContain('date=');
		expect(screen.getByText(repeatCopy.en.history.retainedWorstSubtitle)).toBeInTheDocument();
		expect(harness.state.url.searchParams.get('campaign')).toBe('walk');
	});

	it('canonicalizes explicit latest to current and cannot resurrect it after discovery refresh', async () => {
		reset('http://localhost/repeat-offenders?date=2026-06-25&grain=month&campaign=walk');
		harness.getRepeatOffendersHistoryDay.mockResolvedValue(
			payload('Resurrected', '2026-06-25T23:59:59Z', {
				date: '2026-06-25',
			}) as HistoricRepeatOffendersDay,
		);
		render(RepeatOffendersBoard);

		await screen.findAllByText('Current trip');
		await waitFor(() => expect(harness.state.url.searchParams.get('date')).toBeNull());
		harness.getRepeatOffendersHistoryIndex.mockResolvedValue({
			...historyIndex,
			available_dates: [...AVAILABLE_DATES, '2026-06-26'],
		});
		dataRefresh.bumpEpoch();
		await waitFor(() => expect(harness.getRepeatOffendersHistoryIndex).toHaveBeenCalledTimes(2));
		await waitFor(() => expect(harness.getRepeatOffenders).toHaveBeenCalledTimes(2));
		expect(harness.getRepeatOffendersHistoryDay).not.toHaveBeenCalled();
		expect(screen.queryByText(/Resurrected trip/)).toBeNull();
		expect(harness.state.url.searchParams.get('grain')).toBe('month');
		expect(harness.state.url.searchParams.get('campaign')).toBe('walk');
	});

	it.each([
		['', 'That date was not valid. Showing the latest repeat offenders.'],
		['not-a-date', 'That date was not valid. Showing the latest repeat offenders.'],
		['2026-01-01', 'That date is outside retained history. Showing the latest repeat offenders.'],
		['2026-06-21', 'That day was not published. Showing the latest repeat offenders.'],
	] as const)('corrects %s once with one honest live announcement', async (date, message) => {
		reset(`http://localhost/repeat-offenders?date=${date}&campaign=walk`);
		const { container } = render(RepeatOffendersBoard);

		await screen.findAllByText('Current trip');
		await waitFor(() =>
			expect(container.querySelector('[data-slot="history-page-announcement"]')).toHaveTextContent(
				message,
			),
		);
		const navigatorCopy = container.querySelector('[data-slot="history-announcement"]');
		const mobile = container.querySelector('[data-slot="surface-rail-mobile"]') as HTMLElement;
		await fireEvent.click(mobile.querySelector(':scope > button') as HTMLButtonElement);
		expect(container.querySelectorAll('[data-slot="history-announcement"]')).toHaveLength(1);
		expect(container.querySelector('[data-slot="history-announcement"]')).toBe(navigatorCopy);
		for (const copy of container.querySelectorAll('[data-slot="history-announcement"]')) {
			expect(copy).not.toHaveAttribute('role');
			expect(copy).not.toHaveAttribute('aria-live');
		}
		expect(container.querySelectorAll('[data-slot="history-page-announcement"]')).toHaveLength(1);
		expect(harness.getRepeatOffendersHistoryDay).not.toHaveBeenCalled();
		expect(harness.state.url.searchParams.get('date')).toBeNull();
	});

	it('uses gap-skipping neighbors and suppresses an aborted stale completion', async () => {
		reset('http://localhost/repeat-offenders?date=2026-06-20&grain=month&n=5');
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
		const { container } = render(RepeatOffendersBoard);
		await waitFor(() => expect(harness.getRepeatOffendersHistoryDay).toHaveBeenCalledTimes(1));
		const rail = desktopRail(container);

		await fireEvent.click(within(rail).getByRole('button', { name: 'Next date' }));
		await screen.findAllByText('Retained 22 trip');
		expect(staleSignal?.aborted).toBe(true);
		stale.resolve(retained20);
		await Promise.resolve();
		expect(screen.queryByText(/Retained 20 trip/)).toBeNull();
		expect(harness.state.url.searchParams.get('date')).toBe('2026-06-22');
		expect(harness.state.url.searchParams.get('grain')).toBe('month');
		expect(harness.state.url.searchParams.get('n')).toBe('5');
	});

	it('mirrors date, grain, and n atomically without clobbering unrelated parameters', async () => {
		reset('http://localhost/repeat-offenders?date=2026-06-20&grain=month&n=5&campaign=walk');
		const { container } = render(RepeatOffendersBoard);
		await screen.findAllByText('Retained 20 trip');

		await fireEvent.click(
			within(desktopRail(container)).getByRole('button', { name: 'Next date' }),
		);
		await screen.findAllByText('Retained 22 trip');
		await waitFor(() =>
			expect(harness.mirrorSearchParams).toHaveBeenLastCalledWith({
				date: '2026-06-22',
				grain: 'month',
				n: '5',
			}),
		);
		for (const [values] of harness.mirrorSearchParams.mock.calls) {
			expect(Object.keys(values).sort()).toEqual(['date', 'grain', 'n']);
		}
		expect(harness.state.url.searchParams.get('campaign')).toBe('walk');
	});

	it('keeps an advertised missing day visibly retryable and never substitutes current', async () => {
		reset('http://localhost/repeat-offenders?date=2026-06-22');
		harness.getRepeatOffendersHistoryDay
			.mockRejectedValueOnce(new Error('advertised history artifact not found'))
			.mockResolvedValueOnce(retained22);
		render(RepeatOffendersBoard);

		const retry = await screen.findByRole('button', { name: 'Retry' });
		expect(screen.queryByText(/Current trip/)).toBeNull();
		expect(harness.getRepeatOffenders).not.toHaveBeenCalled();
		await fireEvent.click(retry);
		await screen.findAllByText('Retained 22 trip');
		expect(harness.getRepeatOffendersHistoryDay).toHaveBeenCalledTimes(2);
	});

	it('preserves current published-empty no-rail behavior even when dates exist', async () => {
		harness.getRepeatOffenders.mockResolvedValue(
			payload('Current empty', '2026-06-25T12:00:00Z', { empty: true }),
		);
		const { container } = render(RepeatOffendersBoard);

		await waitFor(() =>
			expect(container.querySelector('[data-slot="offenders-empty"]')).not.toBeNull(),
		);
		await waitFor(() => expect(harness.getRepeatOffendersHistoryIndex).toHaveBeenCalledTimes(1));
		expect(container.querySelector('[data-slot="surface-rail"]')).toBeNull();
		expect(container.querySelector('[data-slot="surface-rail-mobile"]')).toBeNull();
		expect(harness.getRepeatOffendersHistoryDay).not.toHaveBeenCalled();
	});

	it('keeps both rails and the navigator on a published-empty retained date', async () => {
		reset('http://localhost/repeat-offenders?date=2026-06-20');
		harness.getRepeatOffendersHistoryDay.mockResolvedValue(
			payload('Retained empty', '2026-06-20T23:59:59Z', {
				date: '2026-06-20',
				empty: true,
			}),
		);
		const { container } = render(RepeatOffendersBoard);

		await waitFor(() =>
			expect(container.querySelector('[data-slot="offenders-empty"]')).not.toBeNull(),
		);
		expect(desktopRail(container)).not.toBeNull();
		expect(container.querySelector('[data-slot="surface-rail-mobile"]')).not.toBeNull();
		expect(within(desktopRail(container)).getByLabelText('History date')).toHaveValue('2026-06-20');
		expect(container.querySelectorAll('[data-toc^="repeat-"]')).toHaveLength(0);
	});

	it('refreshes the current lane without fetching a date and shows the current payload timestamp', async () => {
		render(RepeatOffendersBoard);
		await screen.findAllByText('Current trip');

		expect(document.querySelector('.header__meta time')).toHaveAttribute('datetime', '2026-06-25');
		dataRefresh.bumpEpoch();
		await waitFor(() => expect(harness.getRepeatOffenders).toHaveBeenCalledTimes(2));
		expect(harness.getRepeatOffendersHistoryIndex).toHaveBeenCalledTimes(2);
		expect(harness.getRepeatOffendersHistoryDay).not.toHaveBeenCalled();
		expect(harness.state.url.searchParams.get('date')).toBeNull();
	});

	it('refreshes only the selected retained lane and shows its accepted timestamp', async () => {
		reset('http://localhost/repeat-offenders?date=2026-06-22');
		render(RepeatOffendersBoard);
		await screen.findAllByText('Retained 22 trip');

		expect(document.querySelector('.header__meta time')).toHaveAttribute('datetime', '2026-06-22');
		dataRefresh.bumpEpoch();
		await waitFor(() => expect(harness.getRepeatOffendersHistoryDay).toHaveBeenCalledTimes(2));
		expect(harness.getRepeatOffenders).not.toHaveBeenCalled();
		expect(harness.state.url.searchParams.get('date')).toBe('2026-06-22');
	});

	it('defines complete English and French retained-history copy without changing current copy', () => {
		expect(repeatCopy.en.cards.worst.subtitle).toMatch(/\?$/);
		expect(repeatCopy.fr.cards.worst.subtitle).toMatch(/\?$/);
		expect(repeatCopy.en.history).toMatchObject({
			retainedWorstSubtitle: expect.not.stringMatching(/current/i),
			retainedHeroNone: expect.not.stringMatching(/right now/i),
		});
		expect(repeatCopy.fr.history.navigator.picker.single).toBeTruthy();
		expect(repeatCopy.fr.history.retainedWindow('13 juill. 2026')).toContain('13 juill. 2026');
	});
});
