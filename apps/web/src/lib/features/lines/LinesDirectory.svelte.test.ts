import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
	const TYPES = new Map<string, number>([
		['1', 1],
		['2', 0],
	]);
	const files = new Map<string, { onTime: number; readings: number }>();
	const failed = new Set<string>();
	const missing = new Set<string>();
	const gates = new Map<string, { promise: Promise<unknown>; resolve: (value: unknown) => void }>();
	const fetches = new Map<string, number>();
	const historyCalls: string[] = [];
	const state = {
		url: new URL('http://localhost/lines?provider=stm'),
		published: null as unknown,
		routes: [] as unknown[],
		gaps: [] as string[] | null,
		locale: 'en' as 'en' | 'fr',
		attribution: null as string | null,
		desktop: false,
		routesWait: null as Promise<void> | null,
		routesFailure: false,
		intersecting: true,
		now: Date.parse('2026-11-12T12:00:00Z'),
	};
	function routeFile(id: string) {
		const config = files.get(id) ?? { onTime: 900, readings: 1000 };
		return {
			generated_utc: '2026-11-11T05:00:00Z',
			id,
			methodology_version: 'reliability-2',
			periods_by_grain: [
				{ grain: 'day', date: '2026-11-10' },
				{
					grain: 'week',
					date: '2026-11-04',
					by_daytype: [
						{ grain: 'weekday', observation_count: config.readings, on_time: config.onTime },
					],
				},
			],
			periods: [
				{
					grain: 'day',
					date: '2026-11-10',
					observation_count: config.readings,
					on_time: config.onTime,
				},
			],
		};
	}
	function routesFor(count: number) {
		return Array.from({ length: count }, (_, index) => {
			const id = String(index + 1);
			return {
				id,
				short: id,
				long:
					index === 0
						? 'Sherbrooke / Station Université de Montréal et chemin de la Côte-des-Neiges'
						: `Route ${id}`,
				type: TYPES.get(id) ?? 3,
			};
		});
	}
	return { files, failed, missing, gates, fetches, historyCalls, state, routeFile, routesFor };
});

vi.mock('$app/state', () => ({
	page: {
		get url() {
			return h.state.url;
		},
		state: {},
	},
}));
vi.mock('$app/navigation', () => ({
	replaceState: (url: string | URL) => {
		h.state.url = new URL(url, 'http://localhost');
	},
	afterNavigate: () => {},
	goto: vi.fn(),
}));
vi.mock('@yesid/ui/state', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@yesid/ui/state')>();
	return {
		...actual,
		desktop: {
			get current() {
				return h.state.desktop;
			},
		},
	};
});
vi.mock('#lib/i18n/index.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/i18n/index.ts')>();
	return { ...actual, getLocale: () => h.state.locale };
});
vi.mock('#lib/v1/boot.ts', () => ({
	getV1Context: () => ({
		manifest: {
			provider: 'stm',
			get attribution() {
				return h.state.attribution;
			},
			short_name: 'STM',
			display_name: 'STM',
			tz: 'America/Toronto',
		},
		provider: { labels: { en: { operator: 'STM' }, fr: { operator: 'STM' } } },
	}),
}));
vi.mock('#lib/v1/repositories/static.ts', () => ({
	getRoutesIndex: async () => {
		if (h.state.routesWait) await h.state.routesWait;
		if (h.state.routesFailure) throw new Error('index unavailable');
		return { generated_utc: '2026-11-11T05:00:00Z', routes: h.state.routes };
	},
}));
vi.mock('#lib/v1/repositories/historic.ts', () => ({
	getPublishedReliabilityIndex: async () => h.state.published,
	getRouteReliabilityIndex: async () => null,
	getRouteReliability: async (id: string) => {
		h.fetches.set(id, (h.fetches.get(id) ?? 0) + 1);
		const gate = h.gates.get(id);
		if (gate) return gate.promise;
		if (h.missing.has(id)) return null;
		if (h.failed.has(id)) throw new Error('read failed');
		return h.routeFile(id);
	},
	// The directory is current-only: these must never be reached by a row.
	getLineHistoryDirectory: async () => {
		h.historyCalls.push('getLineHistoryDirectory');
		return null;
	},
	getLineHistoryIndex: async () => {
		h.historyCalls.push('getLineHistoryIndex');
		return null;
	},
	loadLineHistoryRange: async () => {
		h.historyCalls.push('loadLineHistoryRange');
		return null;
	},
}));
vi.mock('#lib/v1/repositories/provenance.ts', () => ({
	getProvenance: async () => ({ gaps: h.state.gaps }),
}));

class IntersectionObserverFixture {
	constructor(private callback: IntersectionObserverCallback) {}
	root = null;
	rootMargin = '200px';
	thresholds = [0];
	observe(target: Element) {
		if (!h.state.intersecting) return;
		this.callback(
			[{ isIntersecting: true, target } as unknown as IntersectionObserverEntry],
			this as unknown as IntersectionObserver,
		);
	}
	unobserve() {}
	disconnect() {}
	takeRecords() {
		return [];
	}
}

import LinesIndex from './LinesIndex.svelte';
import LinesDirectory from './LinesDirectory.svelte';
import { configureV1Runtime } from '#lib/v1/runtime.ts';
import { refreshEpoch } from './__fixtures__/refreshEpoch.svelte.ts';

const CLOCK_NOW = Date.parse('2026-11-12T12:00:00Z');
let restoreRuntime: () => void = () => {};

function rowLinks(container: HTMLElement): HTMLAnchorElement[] {
	return [...container.querySelectorAll<HTMLAnchorElement>('a.directory-name')];
}

function rows(container: HTMLElement): HTMLElement[] {
	return [...container.querySelectorAll<HTMLElement>('[data-slot="entity-result-row"]')];
}

function counts(container: HTMLElement): string {
	return container.querySelector('[data-slot="directory-counts"]')?.textContent?.trim() ?? '';
}

/** The exported CSV as rows, with header-driven cell lookup so column order can evolve. */
function csvTable(csv: string): {
	header: string[];
	rows: string[][];
	cell: (row: string[], name: string) => string;
} {
	const lines = csv.split('\r\n');
	const header = lines[0].split(',').map((name) => name.replace(/^"|"$/gu, ''));
	const rows = lines.slice(1).map((line) => line.split(','));
	return {
		header,
		rows,
		cell: (row, name) => row[header.indexOf(name)] ?? '',
	};
}

beforeEach(() => {
	vi.stubGlobal('IntersectionObserver', IntersectionObserverFixture);
	restoreRuntime = configureV1Runtime({
		clock: {
			get serverNow() {
				return h.state.now;
			},
			noteServerEpochMs() {},
			subscribe() {
				return () => {};
			},
		},
		refresh: {
			get epoch() {
				return refreshEpoch.value;
			},
		},
	});
	refreshEpoch.value = 0;
	h.state.now = CLOCK_NOW;
	h.state.attribution = null;
	h.state.url = new URL('http://localhost/lines?provider=stm');
	h.state.published = { generated_utc: '2026-11-11T05:00:00Z' };
	h.state.routes = h.routesFor(235);
	h.state.gaps = [];
	h.state.locale = 'en';
	h.state.desktop = false;
	h.state.routesWait = null;
	h.state.routesFailure = false;
	h.state.intersecting = true;
	h.files.clear();
	h.failed.clear();
	h.missing.clear();
	h.gates.clear();
	h.fetches.clear();
	h.historyCalls.length = 0;
});

afterEach(() => {
	restoreRuntime();
	vi.unstubAllGlobals();
});

describe('Lines directory — every published line', () => {
	it.each([null, 'Contains STM data made available under CC BY 4.0.'])(
		'exports the manifest attribution exactly, including unknown %s',
		async (attribution) => {
			h.state.attribution = attribution;
			const { container } = render(LinesDirectory);
			await waitFor(() => expect(rows(container).length).toBeGreaterThan(0));
			const link = container.querySelector<HTMLAnchorElement>('[data-slot="directory-csv"]')!;
			const table = csvTable(decodeURIComponent(link.href.split(',').slice(1).join(',')));
			expect(table.cell(table.rows[0], 'attribution')).toBe('"' + (attribution ?? '') + '"');
		},
	);
	it('keeps its heading, provider and purpose while the index is loading', async () => {
		let release!: () => void;
		h.state.routesWait = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { container } = render(LinesDirectory);
		expect(screen.getByRole('heading', { level: 1, name: 'Lines' })).toBeInTheDocument();
		const header = container.querySelector('[data-slot="blueprint-listing-header"]')!;
		expect(header).toHaveTextContent('STM');
		expect(header).toHaveTextContent('Every line this network publishes');
		expect(rowLinks(container)).toHaveLength(0);
		release();
		await waitFor(() => expect(rowLinks(container)).toHaveLength(20));
	});

	it('keeps page identity when the index fails', async () => {
		h.state.routesFailure = true;
		const { container } = render(LinesDirectory);
		await screen.findByRole('alert');
		expect(screen.getByRole('heading', { level: 1, name: 'Lines' })).toBeInTheDocument();
		expect(container.querySelector('[data-slot="blueprint-listing-header"]')).toHaveTextContent(
			'STM',
		);
		expect(rowLinks(container)).toHaveLength(0);
	});

	it('keeps page identity for a genuinely empty provider index', async () => {
		h.state.routes = [];
		const { container } = render(LinesDirectory);
		await waitFor(() =>
			expect(
				container.querySelector('[data-slot="edge-state"][data-variant="empty"]'),
			).not.toBeNull(),
		);
		expect(screen.getByRole('heading', { level: 1, name: 'Lines' })).toBeInTheDocument();
		expect(container.querySelector('[data-slot="blueprint-listing-header"]')).toHaveTextContent(
			'STM',
		);
	});

	it('opens on twenty rows of the whole network and reaches every line past the old 200 cap', async () => {
		// Inventory paging must work before the row records load. Keep rows unobserved here;
		// the record-loading cases below retain immediate intersection callbacks.
		h.state.intersecting = false;
		const { container } = render(LinesDirectory);

		await waitFor(() =>
			expect(counts(container)).toBe('Showing 20 of 235 matching lines, 235 in this network.'),
		);
		expect(rowLinks(container)).toHaveLength(20);

		for (const expected of [40, 60, 80, 100, 120, 140, 160, 180, 200, 220, 235]) {
			// Scope the accessibility query to this control, rather than recomputing the
			// accessible names of every Preview button in the growing 235-line inventory.
			const pagination = container.querySelector<HTMLElement>('.directory-more')!;
			const more = within(pagination).getByRole('button', {
				name: expected === 235 ? 'Show 15 more lines' : 'Show 20 more lines',
			});
			await fireEvent.click(more);
			await waitFor(() => expect(rowLinks(container)).toHaveLength(expected));
			expect(counts(container)).toBe(
				`Showing ${expected} of 235 matching lines, 235 in this network.`,
			);
		}
		await waitFor(() => expect(rowLinks(container)).toHaveLength(235));
		expect(rowLinks(container).at(-1)?.getAttribute('href')).toMatch(/^\/lines\/235\?/);
		expect(rowLinks(container).map((link) => link.getAttribute('href')?.split('?')[0])).toEqual(
			Array.from({ length: 235 }, (_, i) => `/lines/${i + 1}`),
		);
		expect(h.fetches.size).toBe(0);
		// The page stays on the twenty-row grid, so a reload or Back restores this last page.
		expect(new URLSearchParams(h.state.url.search).get('shown')).toBe('240');
		expect(container.querySelector('.directory-more')).toBeNull();
	});

	it('numbers lines in numeric order by default, not the alphabetical order', async () => {
		const { container } = render(LinesDirectory);

		await waitFor(() => expect(counts(container)).toContain('Showing 20 of 235'));
		expect(
			rowLinks(container)
				.slice(0, 3)
				.map((a) => a.getAttribute('href')?.split('?')[0]),
		).toEqual(['/lines/1', '/lines/2', '/lines/3']);
		expect(rowLinks(container)[10]?.getAttribute('href')).toMatch(/^\/lines\/11\?/);
	});

	it('narrows by query and mode, mirrors the view in the URL, and recovers from no match', async () => {
		const { container } = render(LinesDirectory);
		await waitFor(() => expect(counts(container)).toContain('Showing 20 of 235'));

		const search = screen.getByTestId('lines-filter-input');
		await fireEvent.input(search, { target: { value: 'Route 1' } });
		await waitFor(() => expect(h.state.url.searchParams.get('q')).toBe('Route 1'));
		await waitFor(() => expect(counts(container)).toContain('matching lines, 235 in this network'));

		await fireEvent.input(search, { target: { value: 'zzz' } });
		await screen.findByText('No line matches “zzz”.');
		await fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
		await waitFor(() => expect(counts(container)).toContain('Showing 20 of 235'));
		expect(h.state.url.searchParams.get('q')).toBeNull();

		await fireEvent.click(screen.getByTestId('lines-mode-bus'));
		await waitFor(() => expect(h.state.url.searchParams.get('mode')).toBe('bus'));
		await waitFor(() => expect(counts(container)).toContain('233 matching lines'));
	});
});

describe('Lines directory — evidence states', () => {
	it('names the measure, the readings and the record’s own dates', async () => {
		const { container } = render(LinesDirectory);

		const first = await waitFor(() => {
			const row = rows(container)[0];
			if (!row?.querySelector('[data-slot="reliability-badge"]')) throw new Error('pending');
			return row;
		});
		const badge = first.querySelector('[data-slot="reliability-badge"]');
		expect(badge).toHaveTextContent('90%');
		expect(first.textContent).toContain('November 4 to 10');
		expect(first.textContent).toContain('Based on 1,000 readings');
		const label = badge?.getAttribute('aria-label');
		expect(label).toContain('90%');
		expect(label).toContain('Share of readings on time');
		expect(label).toContain('November 4 to 10');
	});

	it('says a low-sample record is not enough to judge, and never shows a bare 0%', async () => {
		h.files.set('1', { onTime: 0, readings: 12 });
		const { container } = render(LinesDirectory);

		const first = await waitFor(() => {
			const row = rows(container)[0];
			if (!row?.querySelector('[data-slot="reliability-hedge"]')) throw new Error('pending');
			return row;
		});
		expect(within(first).getByText(/Not enough readings to judge/)).toBeTruthy();
		expect(first.querySelector('[data-slot="reliability-badge"]')).toBeNull();
		expect(first.querySelector('[data-slot="reliability-hedge"]')?.textContent).not.toContain('0%');
	});

	it('keeps a measured zero as a real figure', async () => {
		h.files.set('1', { onTime: 0, readings: 1000 });
		const { container } = render(LinesDirectory);

		const badge = await waitFor(() => {
			const found = rows(container)[0]?.querySelector('[data-slot="reliability-badge"]');
			if (!found) throw new Error('pending');
			return found;
		});
		expect(badge).toHaveTextContent('0%');
	});

	it('names no live data from the provider policy, not from a missing ranking', async () => {
		h.state.gaps = ['metro_realtime'];
		const { container } = render(LinesDirectory);

		const first = await waitFor(() => {
			const row = rows(container)[0];
			if (!row?.textContent?.includes('No live data')) throw new Error('pending');
			return row;
		});
		expect(within(first).getByText('No live data')).toBeTruthy();
		expect(first.querySelector('[data-slot="reliability-badge"]')).toBeNull();
	});

	it('keeps an unknown capability unknown instead of claiming no live data', async () => {
		h.state.gaps = null;
		h.state.routes = h.routesFor(1);
		const { container } = render(LinesDirectory);

		await waitFor(() => expect(rows(container)).toHaveLength(1));
		expect(container.textContent).not.toContain('No live data');
	});

	it('offers one retry for a read that failed and never turns it into no data', async () => {
		h.state.routes = h.routesFor(3);
		h.failed.add('2');
		const { container } = render(LinesDirectory);

		const retry = await screen.findByRole('button', { name: 'Retry' });
		expect(container.textContent).toContain('This line’s record didn’t load.');
		h.failed.delete('2');
		await fireEvent.click(retry);

		await waitFor(() => expect(h.fetches.get('2')).toBe(2));
		await waitFor(() => expect(container.textContent).toContain('Based on 1,000 readings'));
		expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
	});
});

describe('Lines directory — comparison and the problem filter stay separate', () => {
	const weekly = (rowsInWeek: readonly unknown[]) => ({
		generated_utc: '2026-11-11T05:00:00Z',
		methodology_version: 'reliability-2',
		publish_generation_id: 'stm@2026-11-11T05:00:00Z',
		weekly_routes: rowsInWeek,
	});

	it('explains that comparison is unavailable rather than inventing an order', async () => {
		const { container } = render(LinesDirectory);

		await waitFor(() => expect(counts(container)).toContain('Showing 20 of 235'));
		expect(screen.getByTestId('lines-sort-worst')).toBeDisabled();
		expect(container.textContent).toContain(
			'Comparison order needs a published weekly ranking. These are the lines by number.',
		);
		expect(h.state.url.searchParams.get('sort')).toBeNull();
	});

	it('lists the published order first and the excluded lines below with their reasons', async () => {
		h.state.published = weekly([
			{
				id: '3',
				state: 'ranked',
				rank: 1,
				numerator: 30,
				denominator: 100,
				pct: 30,
				window_start: '2026-11-04',
				window_end: '2026-11-10',
			},
			{ id: '2', state: 'too_few_units', window_start: '2026-10-28', window_end: '2026-11-03' },
		]);
		const { container } = render(LinesDirectory);

		await waitFor(() => expect(screen.getByTestId('lines-sort-worst')).not.toBeDisabled());
		await fireEvent.click(screen.getByTestId('lines-sort-worst'));
		await waitFor(() => expect(h.state.url.searchParams.get('sort')).toBe('worst'));

		const rendered = rows(container);
		expect(rendered[0].querySelector('a.directory-name')?.getAttribute('href')).toMatch(
			/^\/lines\/3\?/,
		);
		expect(rendered[0].querySelector('[data-slot="reliability-badge"]')).toHaveTextContent('30%');
		// Line 1 has no published entry, line 2 has one that explains its exclusion.
		expect(rendered[1].querySelector('a.directory-name')?.getAttribute('href')).toMatch(
			/^\/lines\/1\?/,
		);
		const excluded = rendered[2];
		expect(excluded.querySelector('a.directory-name')?.getAttribute('href')).toMatch(
			/^\/lines\/2\?/,
		);
		expect(excluded.textContent).toContain('Too few vehicles measured');
		expect(excluded.textContent).toContain('October 28 to November 3');
		expect(excluded.textContent).toContain('Older week');
		expect(excluded.querySelector('[data-slot="reliability-badge"]')).toBeNull();
		expect(excluded.textContent).not.toContain('%');
	});

	it('switches to line-number order when the problem filter is chosen, and says so', async () => {
		h.state.published = weekly([
			{
				id: '3',
				state: 'ranked',
				rank: 1,
				numerator: 30,
				denominator: 100,
				pct: 30,
				window_start: '2026-11-04',
				window_end: '2026-11-10',
			},
		]);
		h.state.routes = h.routesFor(3);
		h.files.set('2', { onTime: 500, readings: 1000 });
		const { container } = render(LinesDirectory);

		await waitFor(() => expect(screen.getByTestId('lines-sort-worst')).not.toBeDisabled());
		await fireEvent.click(screen.getByTestId('lines-sort-worst'));
		await fireEvent.click(screen.getByTestId('lines-status-problem'));

		await waitFor(() => expect(h.state.url.searchParams.get('status')).toBe('problem'));
		expect(h.state.url.searchParams.get('sort')).toBeNull();
		await screen.findByText('The reliability filter lists lines by number, so weeks never mix.');
		await waitFor(() => expect(rows(container)).toHaveLength(1));
		expect(container.querySelector('a.directory-name')?.getAttribute('href')).toMatch(
			/^\/lines\/2\?/,
		);
		await waitFor(() => expect(counts(container)).toBe('Patchy or unreliable: 1 of 3 checked.'));
	});

	it('gives each row its own source identity, ranked or excluded, never the headline’s', async () => {
		h.state.published = {
			...weekly([
				{
					id: '3',
					state: 'ranked',
					rank: 1,
					numerator: 30,
					denominator: 100,
					pct: 30,
					window_start: '2026-11-04',
					window_end: '2026-11-10',
				},
				{ id: '2', state: 'too_few_units', window_start: '2026-10-28', window_end: '2026-11-03' },
			]),
			publish_generation_id: 'stm@2026-11-11T05:00:00Z',
		};
		h.state.routes = h.routesFor(3);
		const { container } = render(LinesDirectory);
		await waitFor(() => expect(screen.getByTestId('lines-sort-worst')).not.toBeDisabled());
		await fireEvent.click(screen.getByTestId('lines-sort-worst'));
		await waitFor(() => expect(h.state.url.searchParams.get('sort')).toBe('worst'));
		await waitFor(() => expect(rows(container)).toHaveLength(3));

		const [ranked, current, excluded] = rows(container).map((row) =>
			row.querySelector('a.directory-name')?.getAttribute('href'),
		);
		expect(ranked).toBe(
			'/lines/3?provider=stm&from=2026-11-04&to=2026-11-10&generation=stm%402026-11-11T05%3A00%3A00Z&published=2026-11-11T05%3A00%3A00Z&method=reliability-2',
		);
		expect(current).toBe(
			'/lines/1?provider=stm&from=2026-11-04&to=2026-11-10&published=2026-11-11T05%3A00%3A00Z&method=reliability-2',
		);
		expect(excluded).toBe(
			'/lines/2?provider=stm&from=2026-10-28&to=2026-11-03&generation=stm%402026-11-11T05%3A00%3A00Z&published=2026-11-11T05%3A00%3A00Z&method=reliability-2',
		);
	});

	it('never invents dates or identity for a row whose read has not settled', async () => {
		h.state.routes = h.routesFor(3);
		h.gates.set('1', { promise: new Promise(() => {}), resolve: () => {} });
		const { container } = render(LinesDirectory);
		await waitFor(() => expect(rows(container)).toHaveLength(3));
		expect(rows(container)[0].querySelector('a.directory-name')?.getAttribute('href')).toBe(
			'/lines/1?provider=stm',
		);
	});
});

describe('Lines directory — preview, links and citation', () => {
	it.each(['1', '235'])(
		'focuses a phone URL preview for line %s and returns to a useful results target',
		async (id) => {
			h.state.url = new URL(`http://localhost/lines?provider=stm&line=${id}`);
			const { container } = render(LinesDirectory);
			const heading = await screen.findByRole('heading', { name: `Line ${id}` });
			await waitFor(() => expect(document.activeElement).toBe(heading));
			await fireEvent.click(screen.getByRole('button', { name: 'Back to results' }));
			await waitFor(() => expect(h.state.url.searchParams.get('line')).toBeNull());
			const button = container.querySelector(`[data-directory-preview-id="${id}"]`);
			expect(document.activeElement).toBe(
				button ?? screen.getByRole('region', { name: 'Lines in this network' }),
			);
		},
	);

	it('returns to the results when filtering removed the original Preview button', async () => {
		h.state.routes = h.routesFor(3);
		h.files.set('1', { onTime: 1000, readings: 1000 });
		h.files.set('2', { onTime: 100, readings: 1000 });
		const { container } = render(LinesDirectory);
		await waitFor(() => expect(rowLinks(container)).toHaveLength(3));
		const origin = screen.getByRole('button', { name: 'Preview line 1' });
		await fireEvent.click(origin);
		await screen.findByRole('heading', { name: 'Line 1' });
		await fireEvent.click(screen.getByTestId('lines-status-problem'));
		await waitFor(() => expect(origin.isConnected).toBe(false));
		await fireEvent.click(screen.getByRole('button', { name: 'Back to results' }));
		await waitFor(() =>
			expect(document.activeElement).toBe(
				screen.getByRole('region', { name: 'Lines in this network' }),
			),
		);
	});

	it('copies a complete absolute record URL and exposes that same URL on clipboard denial', async () => {
		h.state.desktop = true;
		const writeText = vi.fn().mockRejectedValue(new Error('denied'));
		vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
		render(LinesDirectory);
		await screen.findByRole('link', { name: 'Download this record (CSV)' });
		await fireEvent.click(screen.getByRole('button', { name: 'Copy record link' }));
		const href =
			'http://localhost/lines/1?provider=stm&from=2026-11-04&to=2026-11-10&published=2026-11-11T05%3A00%3A00Z&method=reliability-2';
		expect(writeText).toHaveBeenCalledWith(href);
		expect(await screen.findByRole('textbox', { name: 'Copy this link:' })).toHaveValue(href);
	});

	it('stays closed on the phone until Preview is chosen, then returns focus to the row', async () => {
		const { container } = render(LinesDirectory);
		await waitFor(() => expect(counts(container)).toContain('Showing 20 of 235'));

		expect(screen.queryByRole('heading', { name: 'Line 1' })).toBeNull();
		const preview = screen.getAllByRole('button', { name: /Preview line/ })[0];
		await fireEvent.click(preview);

		const heading = await screen.findByRole('heading', { name: 'Line 1' });
		expect(h.state.url.searchParams.get('line')).toBe('1');
		expect(document.activeElement).toBe(heading);

		await fireEvent.click(screen.getByRole('button', { name: 'Back to results' }));
		await waitFor(() => expect(h.state.url.searchParams.get('line')).toBeNull());
		expect(document.activeElement).toBe(preview);
	});

	it('defaults the desktop preview to the first visible line without moving focus', async () => {
		h.state.desktop = true;
		render(LinesDirectory);

		const heading = await screen.findByRole('heading', { name: 'Line 1' });
		expect(document.activeElement).not.toBe(heading);
	});

	it('links the Record with the selected evidence’s own dates and provider', async () => {
		const { container } = render(LinesDirectory);

		await waitFor(() =>
			expect(rowLinks(container)[0]?.getAttribute('href')).toContain('from=2026-11-04'),
		);
		expect(rowLinks(container)[0]?.getAttribute('href')).toBe(
			'/lines/1?provider=stm&from=2026-11-04&to=2026-11-10&published=2026-11-11T05%3A00%3A00Z&method=reliability-2',
		);
	});

	it('keeps a requested date range out of the directory and says it is unsupported', async () => {
		h.state.url = new URL('http://localhost/lines?provider=stm&from=2026-10-01&to=2026-10-07');
		const { container } = render(LinesDirectory);

		await screen.findByText(/This directory always shows the current published week\./);
		await waitFor(() =>
			expect(rowLinks(container)[0]?.getAttribute('href')).toContain('from=2026-11-04'),
		);
		expect(h.state.url.searchParams.get('from')).toBe('2026-10-01');
	});

	it('cites the exact record behind the selected row', async () => {
		h.state.desktop = true;
		const writeText = vi.fn().mockResolvedValue(undefined);
		vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
		render(LinesDirectory);

		await screen.findByRole('heading', { name: 'Line 1' });
		await fireEvent.click(await screen.findByRole('button', { name: 'Cite this record' }));

		await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
		const cited = writeText.mock.calls[0][0] as string;
		expect(cited).toContain('Transit (localhost).');
		expect(cited).toContain('Line 1, STM');
		expect(cited).toContain('90%');
		expect(cited).toContain('November 4 to 10, 2026');
		expect(cited).toContain('1,000');
		expect(cited).toMatch(/Record published Nov\.? 11, 2026/);
		expect(cited).toContain('method reliability-2');
		expect(cited).toMatch(
			/http:\/\/localhost\/lines\/1\?provider=stm&from=2026-11-04&to=2026-11-10&published=2026-11-11T05%3A00%3A00Z&method=reliability-2$/u,
		);
		expect(cited.toLowerCase()).not.toContain('permanent');
	});
	it('exports exactly the displayed rows as a CSV download', async () => {
		h.state.url = new URL('http://localhost/lines?provider=stm&shown=40');
		h.missing.add('30');
		const { container } = render(LinesDirectory);
		await waitFor(() => expect(rows(container)).toHaveLength(40));

		const link = container.querySelector<HTMLAnchorElement>('[data-slot="directory-csv"]')!;
		expect(link.getAttribute('download')).toBe('lines-displayed-records.csv');
		const csv = await waitFor(() => {
			const text = decodeURIComponent(link.href.split(',').slice(1).join(','));
			const table = csvTable(text);
			const plain = (value: string) => value.replace(/^"|"$/gu, '');
			if (plain(table.cell(table.rows[0] ?? [], 'value_pct')) !== '90')
				throw new Error('evidence still arriving');
			if (plain(table.cell(table.rows[29] ?? [], 'evidence_state')) !== 'not-published')
				throw new Error('evidence still arriving');
			return text;
		});
		const table = csvTable(csv);
		expect(table.rows).toHaveLength(40);
		expect(table.header).toContain('line_id');
		expect(table.header).toContain('evidence_state');
		expect(table.cell(table.rows[0], 'line_id')).toBe('"1"');
		expect(table.cell(table.rows[0], 'window_from')).toBe('"2026-11-04"');
		// Line 30 publishes no file: its own state, and no invented figure.
		expect(table.cell(table.rows[29], 'line_id')).toBe('"30"');
		expect(table.cell(table.rows[29], 'value_pct')).toBe('');
	});

	it('writes each displayed row’s own Record URL identity and the selected row’s own', async () => {
		h.state.published = {
			generated_utc: '2026-11-11T05:00:00Z',
			methodology_version: 'reliability-2',
			publish_generation_id: 'stm@2026-11-11T05:00:00Z',
			weekly_routes: [
				{
					id: '3',
					state: 'ranked',
					rank: 1,
					numerator: 30,
					denominator: 100,
					pct: 30,
					window_start: '2026-11-04',
					window_end: '2026-11-10',
				},
			],
		};
		h.state.routes = h.routesFor(3);
		h.state.desktop = true;
		const { container } = render(LinesDirectory);
		await waitFor(() => expect(screen.getByTestId('lines-sort-worst')).not.toBeDisabled());
		await fireEvent.click(screen.getByTestId('lines-sort-worst'));
		await waitFor(() => expect(rows(container)).toHaveLength(3));

		const displayed = container.querySelector<HTMLAnchorElement>('[data-slot="directory-csv"]')!;
		const table = csvTable(decodeURIComponent(displayed.href.split(',').slice(1).join(',')));
		const plain = (value: string) => value.replace(/^"|"$/gu, '');
		const ranked = new URL(plain(table.cell(table.rows[0], 'record_url')));
		expect(ranked.searchParams.get('generation')).toBe('stm@2026-11-11T05:00:00Z');
		expect(ranked.searchParams.get('published')).toBe('2026-11-11T05:00:00Z');
		expect(ranked.searchParams.get('method')).toBe('reliability-2');
		const current = new URL(plain(table.cell(table.rows[1], 'record_url')));
		expect(current.searchParams.get('generation')).toBeNull();
		expect(current.searchParams.get('published')).toBe('2026-11-11T05:00:00Z');
		expect(current.searchParams.get('method')).toBe('reliability-2');

		const selected = await waitFor(() => {
			const link = container.querySelector<HTMLAnchorElement>('[data-slot="directory-record-csv"]');
			if (!link) throw new Error('selected export still arriving');
			return link;
		});
		const selectedTable = csvTable(decodeURIComponent(selected.href.split(',').slice(1).join(',')));
		const selectedUrl = new URL(plain(selectedTable.cell(selectedTable.rows[0], 'record_url')));
		expect(selectedUrl.searchParams.get('generation')).toBe('stm@2026-11-11T05:00:00Z');
		expect(selectedUrl.searchParams.get('from')).toBe('2026-11-04');
		expect(selectedUrl.searchParams.get('to')).toBe('2026-11-10');
	});

	it.each([
		['en', 'November 4 to 10, 7 complete days'],
		['fr', 'du 4 au 10 novembre, 7 jours complets'],
	] as const)('names the selected period once in %s', async (locale, expected) => {
		h.state.desktop = true;
		h.state.locale = locale;
		const { container } = render(LinesDirectory);
		await waitFor(() =>
			expect(container.querySelector('.preview-dates')).toHaveTextContent(expected),
		);
		expect(container.querySelector('.preview-dates')?.textContent?.trim()).toBe(expected);
	});

	it('exports the selected record only when a figure and complete days exist', async () => {
		h.state.desktop = true;
		const { container } = render(LinesDirectory);

		const link = await waitFor(() => {
			const found = container.querySelector<HTMLAnchorElement>(
				'[data-slot="directory-record-csv"]',
			);
			if (!found) throw new Error('no record export yet');
			return found;
		});
		expect(link.getAttribute('download')).toBe('line-1-2026-11-04-2026-11-10-selected-record.csv');
		const csv = decodeURIComponent(link.href.split(',').slice(1).join(','));
		const table = csvTable(csv);
		expect(table.rows).toHaveLength(1);
		expect(table.cell(table.rows[0], 'value_pct')).toBe('90');
	});

	it('offers no record export for a selection with no published figure', async () => {
		h.state.desktop = true;
		h.state.url = new URL('http://localhost/lines?provider=stm&line=30');
		const { container } = render(LinesDirectory);

		await waitFor(() =>
			expect(container.querySelector('[data-slot="directory-preview"]')).not.toBeNull(),
		);
		expect(container.querySelector('[data-slot="directory-record-csv"]')).toBeNull();
	});

	it('selects a published line with an opaque id, and never fetches an unknown one', async () => {
		const opaque = 'ligne 24/été';
		h.state.routes = [
			...h.routesFor(3),
			{ id: opaque, short: '24 bis', long: 'Ligne opaque', type: 3 },
		];
		h.state.url = new URL(`http://localhost/lines?provider=stm&line=${encodeURIComponent(opaque)}`);
		const { container, unmount } = render(LinesDirectory);

		expect(await screen.findByRole('heading', { name: 'Line 24 bis' })).toBeTruthy();
		await waitFor(() => expect(h.fetches.get(opaque)).toBe(1));
		const recordLink = container.querySelector<HTMLAnchorElement>(
			'[data-slot="directory-preview"] a',
		);
		expect(recordLink?.getAttribute('href')).toContain(encodeURIComponent(opaque));
		unmount();

		h.fetches.clear();
		h.state.url = new URL(
			`http://localhost/lines?provider=stm&line=${encodeURIComponent('ghost/id')}`,
		);
		const next = render(LinesDirectory);
		await waitFor(() =>
			expect(next.container.querySelector('[data-slot="entity-result-row"]')).not.toBeNull(),
		);
		expect(next.container.querySelector('[data-slot="directory-preview"]')).toBeNull();
		expect(h.fetches.has('ghost/id')).toBe(false);
	});

	it('keeps a selectable fallback when the clipboard refuses', async () => {
		h.state.desktop = true;
		vi.stubGlobal('navigator', {
			...navigator,
			clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
		});
		render(LinesDirectory);

		await screen.findByRole('heading', { name: 'Line 1' });
		await fireEvent.click(await screen.findByRole('button', { name: 'Cite this record' }));

		const fallback = await waitFor(() => {
			const area = document.querySelector<HTMLTextAreaElement>(
				'[data-slot="record-copy"] textarea',
			);
			if (!area) throw new Error('no fallback yet');
			return area;
		});
		expect(fallback.value).toContain('Line 1, STM');
		expect(fallback.readOnly).toBe(true);
		expect(document.activeElement).toBe(fallback);
	});
});

describe('Lines directory — URL ownership', () => {
	it('restores query order, filter, selection and page size from the URL', async () => {
		h.state.published = {
			generated_utc: '2026-11-11T05:00:00Z',
			weekly_routes: [
				{
					id: '3',
					state: 'ranked',
					rank: 1,
					numerator: 30,
					denominator: 100,
					pct: 30,
					window_start: '2026-11-04',
					window_end: '2026-11-10',
				},
			],
		};
		h.state.url = new URL(
			'http://localhost/lines?provider=stm&mode=bus&sort=worst&line=3&shown=40',
		);
		const { container } = render(LinesDirectory);

		await waitFor(() => expect(rows(container)).toHaveLength(40));
		expect(container.querySelector('a.directory-name')?.getAttribute('href')).toMatch(
			/^\/lines\/3\?/,
		);
		expect(await screen.findByRole('heading', { name: 'Line 3' })).toBeTruthy();
	});

	it('resolves a URL that asks for two different weeks to the problem filter in number order', async () => {
		h.state.url = new URL('http://localhost/lines?provider=stm&sort=worst&status=problem');
		const { container } = render(LinesDirectory);

		await waitFor(() => expect(counts(container)).toContain('Patchy or unreliable:'));
		expect(h.state.url.searchParams.get('sort')).toBeNull();
		expect(h.state.url.searchParams.get('status')).toBe('problem');
	});
});

describe('Lines directory — current-only and bounded reads', () => {
	it('never fans out retained-history discovery or partitions across the listing', async () => {
		const { container } = render(LinesDirectory);
		await waitFor(() => expect(rows(container)).toHaveLength(20));

		expect(h.historyCalls).toEqual([]);
	});

	it('asks only for the rows it shows, not for the whole network', async () => {
		const { container } = render(LinesDirectory);
		await waitFor(() => expect(rows(container)).toHaveLength(20));
		await waitFor(() => expect(h.fetches.size).toBe(20));

		expect(h.fetches.has('235')).toBe(false);
	});

	it('withdraws the comparison when its publication is past its deadline', async () => {
		h.state.published = {
			generated_utc: '2026-11-11T05:00:00Z',
			weekly_routes: [
				{
					id: '3',
					state: 'ranked',
					rank: 1,
					numerator: 30,
					denominator: 100,
					pct: 30,
					window_start: '2026-11-04',
					window_end: '2026-11-10',
				},
			],
		};
		h.state.now = Date.parse('2026-12-01T12:00:00Z');
		render(LinesDirectory);

		await waitFor(() => expect(screen.getByTestId('lines-sort-worst')).toBeDisabled());
		expect(h.state.url.searchParams.get('sort')).toBeNull();
	});
});

describe('LinesIndex owns the directory’s lifetime', () => {
	it('remounts the directory on a data refresh, so no stale evidence survives', async () => {
		render(LinesIndex);
		await waitFor(() => expect(h.fetches.get('1')).toBe(1));

		refreshEpoch.value += 1;

		await waitFor(() => expect(h.fetches.get('1')).toBe(2));
	});
});
