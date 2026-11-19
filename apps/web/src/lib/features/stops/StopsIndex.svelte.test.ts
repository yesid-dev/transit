import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
	const state = {
		url: new URL('http://localhost/stops?provider=stm'),
		stops: [] as unknown[],
		routes: [] as unknown[],
		route: null as unknown,
		routeFailure: false,
		routesFailure: false,
		published: null as unknown,
		locale: 'en' as 'en' | 'fr',
		desktop: false,
		now: Date.parse('2026-11-13T15:00:00Z'),
	};
	const calls = { route: [] as string[], history: [] as string[] };
	/** A network of `count` stops whose names sort in id order: "Stop 001", "Stop 002", ... */
	function stopsFor(count: number) {
		return Array.from({ length: count }, (_, index) => {
			const n = String(index + 1).padStart(3, '0');
			return {
				id: `S${n}`,
				name: `Stop ${n}`,
				code: `5${n}`,
				lat: 45.5 + index * 0.001,
				lon: -73.6,
				mode: 'bus',
				routes: ['24'],
			};
		});
	}
	return { state, calls, stopsFor };
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
		manifest: { provider: 'stm', short_name: 'STM', display_name: 'STM', tz: 'America/Toronto' },
		provider: { labels: { en: { operator: 'STM' }, fr: { operator: 'STM' } } },
	}),
}));
vi.mock('#lib/v1/repositories/static.ts', () => ({
	getStopsIndex: async () => ({ generated_utc: '2026-11-11T05:00:00Z', stops: h.state.stops }),
	getRoutesIndex: async () => {
		if (h.state.routesFailure) throw new Error('catalogue unavailable');
		return { generated_utc: '2026-11-11T05:00:00Z', routes: h.state.routes };
	},
	getRoute: async (id: string) => {
		h.calls.route.push(id);
		if (h.state.routeFailure) return null;
		return h.state.route;
	},
}));
vi.mock('#lib/v1/repositories/historic.ts', () => ({
	getPublishedReliabilityIndex: async () => h.state.published,
	// The finder reads one weekly file; a row never reaches a stop's own history.
	getStopReliability: async () => {
		h.calls.history.push('getStopReliability');
		return null;
	},
	getStopHistoryIndex: async () => {
		h.calls.history.push('getStopHistoryIndex');
		return null;
	},
}));

import StopsIndex from './StopsIndex.svelte';
import { configureV1Runtime } from '#lib/v1/runtime.ts';

const PUBLISHED = '2026-11-11T07:30:00Z';
const WINDOW = { window_start: '2026-11-04', window_end: '2026-11-10' };

/** A ranked weekly row whose share agrees with its counts, as the contract asks. */
function ranked(id: string, readings: number, late: number, rank: number) {
	const notLate = readings - late;
	return {
		state: 'ranked',
		id,
		name: id,
		rank,
		numerator: notLate,
		denominator: readings,
		pct: Math.round((100 * notLate) / readings),
		severe_pct: Math.round((1000 * late) / readings) / 10,
		...WINDOW,
	};
}

function weekly(rows: unknown[]) {
	return {
		generated_utc: PUBLISHED,
		published_utc: PUBLISHED,
		next_publish_utc: '2026-11-18T07:00:00Z',
		weekly_routes: null,
		weekly_stops: rows,
	};
}

let restoreRuntime: () => void = () => {};

const rows = (container: HTMLElement) => [
	...container.querySelectorAll<HTMLElement>('[data-slot="entity-result-row"]'),
];
const names = (container: HTMLElement) =>
	[...container.querySelectorAll<HTMLAnchorElement>('a.finder-name')].map((a) =>
		a.textContent?.trim(),
	);
const counts = (container: HTMLElement) =>
	container.querySelector('[data-slot="finder-counts"]')?.textContent?.trim() ?? '';
const rowFor = (container: HTMLElement, name: string) =>
	rows(container).find((row) => row.querySelector('a.finder-name')?.textContent?.trim() === name)!;

beforeEach(() => {
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
		refresh: { epoch: 0 },
	});
	h.state.url = new URL('http://localhost/stops?provider=stm');
	h.state.stops = h.stopsFor(45);
	h.state.routes = [{ id: '24', short: '24', long: 'Sherbrooke', type: 3 }];
	h.state.route = null;
	h.state.routeFailure = false;
	h.state.routesFailure = false;
	h.state.published = weekly([
		ranked('S003', 80, 1, 1),
		{ state: 'too_few_units', id: 'S002', ...WINDOW },
	]);
	h.state.locale = 'en';
	h.state.now = Date.parse('2026-11-13T15:00:00Z');
	h.state.desktop = false;
	h.calls.route.length = 0;
	h.calls.history.length = 0;
});

afterEach(() => {
	restoreRuntime();
	vi.unstubAllGlobals();
});

describe('Stops finder — every published stop', () => {
	it('lists the network in twenty-row steps with true counts, the last step at its real size', async () => {
		h.state.stops = h.stopsFor(41);
		const { container } = render(StopsIndex);
		await waitFor(() => expect(rows(container)).toHaveLength(20));
		expect(counts(container)).toBe('Showing 20 of 41 matching stops, 41 in this network.');
		await fireEvent.click(screen.getByRole('button', { name: 'Show 20 more stops' }));
		await fireEvent.click(screen.getByRole('button', { name: 'Show the last stop' }));
		expect(rows(container)).toHaveLength(41);
		expect(counts(container)).toBe('Showing 41 of 41 matching stops, 41 in this network.');
		expect(h.state.url.searchParams.get('shown')).toBe('60');
		expect(screen.queryByRole('button', { name: /more stops|last stop/ })).toBeNull();
	});

	it('reaches every match past the old 100-row search cap', async () => {
		h.state.stops = h.stopsFor(130);
		h.state.url = new URL('http://localhost/stops?provider=stm&q=stop&shown=140');
		const { container } = render(StopsIndex);
		await waitFor(() => expect(rows(container)).toHaveLength(130));
		expect(counts(container)).toBe('Showing 130 of 130 matching stops, 130 in this network.');
	});

	it('names each row by stop, sign code, mode and lines, linking to its record', async () => {
		const { container } = render(StopsIndex);
		await waitFor(() => expect(rows(container).length).toBeGreaterThan(0));
		const row = rowFor(container, 'Stop 001');
		expect(row.querySelector('.finder-meta')?.textContent).toBe('Code 5001 · Bus · Line 24');
		expect(row.querySelector('a.finder-name')?.getAttribute('href')).toBe(
			'/stop/S001?provider=stm',
		);
	});
});

describe('Stops finder — each row’s weekly record', () => {
	it('shows the stop page’s own late share, rounded as published, with its week and readings', async () => {
		const { container } = render(StopsIndex);
		await waitFor(() =>
			expect(
				rowFor(container, 'Stop 003').querySelector('[data-slot="stop-row-figure"]'),
			).not.toBeNull(),
		);
		const row = rowFor(container, 'Stop 003');
		// 1 late reading of 80 is exactly 1.25%: one decimal, half away from zero, as the publisher rounds.
		const figure = within(row).getByRole('img', {
			name: '1.3% of readings more than 5 minutes late, November 4 to 10, 2026 · 7 complete days',
		});
		expect(figure.textContent).toContain('1.3%');
		expect(row.querySelector('[data-slot="stop-row-detail"]')?.textContent).toBe(
			'November 4 to 10, 2026 · 80 readings',
		);
		expect(row.querySelector('a.finder-name')?.getAttribute('href')).toBe(
			'/stop/S003?provider=stm&from=2026-11-04&to=2026-11-10',
		);
	});

	it('keeps absence in words, never a reassuring zero', async () => {
		const { container } = render(StopsIndex);
		await waitFor(() =>
			expect(
				rowFor(container, 'Stop 002').querySelector('[data-slot="stop-row-state"]'),
			).not.toBeNull(),
		);
		const tooFew = rowFor(container, 'Stop 002');
		expect(tooFew.textContent).toContain('No share');
		expect(tooFew.textContent).toContain('Too few readings this week');
		const unlisted = rowFor(container, 'Stop 001');
		expect(unlisted.textContent).toContain('Not in this week’s record');
		expect(container.textContent).not.toMatch(/\b0(\.0)?\s?%/u);
		expect(h.calls.history).toEqual([]);
	});

	it('holds the figure’s room, unread, while the weekly file loads', async () => {
		let release: (value: unknown) => void = () => {};
		h.state.published = new Promise((resolve) => (release = resolve));
		const { container } = render(StopsIndex);
		await waitFor(() => expect(rows(container).length).toBeGreaterThan(0));
		const row = rowFor(container, 'Stop 003');
		expect(row.querySelector('.finder-held[aria-hidden="true"]')).not.toBeNull();
		expect(row.querySelector('[data-slot="stop-row-detail"]')?.textContent).toBe('');
		release(weekly([ranked('S003', 80, 1, 1)]));
		await waitFor(() => expect(row.querySelector('[data-slot="stop-row-figure"]')).not.toBeNull());
	});
});

describe('Stops finder — narrowing and recovery', () => {
	it('says what did not match and clears back to the whole network', async () => {
		const { container } = render(StopsIndex);
		await waitFor(() => expect(rows(container)).toHaveLength(20));
		await fireEvent.input(screen.getByTestId('stops-filter-input'), { target: { value: 'zzz' } });
		const notice = await screen.findByText('No stop matches “zzz”.');
		expect(h.state.url.searchParams.get('q')).toBe('zzz');
		await fireEvent.click(
			within(notice.closest('[role="status"]')!).getByRole('button', { name: 'Clear filters' }),
		);
		await waitFor(() => expect(rows(container)).toHaveLength(20));
		expect(h.state.url.searchParams.has('q')).toBe(false);
	});

	it('follows a chosen line in travel order, naming directions only by their headsign', async () => {
		h.state.route = {
			id: '24',
			directions: [
				{
					dir: 0,
					headsign: 'Est',
					stops: [
						{ id: 'S005', seq: 1 },
						{ id: 'S001', seq: 2 },
					],
				},
				{ dir: 1, headsign: null, stops: [{ id: 'S001', seq: 1 }] },
			],
		};
		h.state.url = new URL('http://localhost/stops?provider=stm&route=24');
		const { container } = render(StopsIndex);
		await waitFor(() => expect(rows(container)).toHaveLength(3));
		expect(names(container)).toEqual(['Stop 005', 'Stop 001', 'Stop 001']);
		expect(counts(container)).toBe('Showing 3 of 3 stops on line 24.');
		const metas = [...container.querySelectorAll('.finder-meta')].map((meta) => meta.textContent);
		expect(metas[0]).toContain('Towards Est');
		expect(metas[2]).not.toMatch(/Towards|Direction/u);
		expect(container.textContent).not.toContain('Direction 0');
	});

	it('says when a line has no published stop list, and offers the way back', async () => {
		h.state.routeFailure = true;
		h.state.url = new URL('http://localhost/stops?provider=stm&route=24');
		render(StopsIndex);
		const notice = await screen.findByText('No published stop list for this line.');
		await fireEvent.click(
			within(notice.closest('[role="status"]')!).getByRole('button', { name: 'Clear filters' }),
		);
		await waitFor(() => expect(h.state.url.searchParams.has('route')).toBe(false));
	});

	it('orders by the published ranking only when a current one exists, and says what it is', async () => {
		h.state.published = weekly([ranked('S040', 100, 30, 1), ranked('S003', 80, 1, 2)]);
		const { container } = render(StopsIndex);
		await waitFor(() => expect(screen.getByTestId('stops-sort-late')).toBeEnabled());
		await fireEvent.click(screen.getByTestId('stops-sort-late'));
		await waitFor(() =>
			expect(names(container).slice(0, 3)).toEqual(['Stop 040', 'Stop 003', 'Stop 001']),
		);
		expect(container.querySelector('[data-slot="finder-order-context"]')?.textContent).toContain(
			'Published ranking for November 4 to 10, 2026, by readings more than 5 minutes late.',
		);
		expect(h.state.url.searchParams.get('sort')).toBe('late');
	});

	it('explains why the published order is unavailable when no current week exists', async () => {
		h.state.now = Date.parse('2026-12-20T12:00:00Z');
		render(StopsIndex);
		const order = await screen.findByTestId('stops-sort-late');
		expect(order).toBeDisabled();
		expect(order).toHaveAccessibleDescription(
			'This order needs a current weekly record. The stops stay in their usual order.',
		);
	});
});

describe('Stops finder — nearby, on request only', () => {
	it('asks for the position only on action and never writes it to the URL', async () => {
		const getCurrentPosition = vi.fn((success: PositionCallback) =>
			success({ coords: { latitude: 45.5, longitude: -73.6 } } as GeolocationPosition),
		);
		vi.stubGlobal('navigator', { ...navigator, geolocation: { getCurrentPosition } });
		vi.stubGlobal('isSecureContext', true);
		const { container } = render(StopsIndex);
		await waitFor(() => expect(rows(container)).toHaveLength(20));
		expect(getCurrentPosition).not.toHaveBeenCalled();
		await fireEvent.click(screen.getByRole('button', { name: 'Stops near me' }));
		// The seed spaces stops about 111 m apart northwards: nine fall within 1 km.
		await waitFor(() => expect(counts(container)).toBe('Showing 9 of 9 stops within 1 km.'));
		expect(names(container)[0]).toBe('Stop 001');
		expect(rowFor(container, 'Stop 002').querySelector('.finder-meta')?.textContent).toContain(
			'110 m',
		);
		expect(h.state.url.search).not.toMatch(/45\.5|73\.6|near/u);
		await fireEvent.click(screen.getByRole('button', { name: 'Stop using my location' }));
		await waitFor(() => expect(rows(container)).toHaveLength(20));
	});

	it('says plainly when the position is refused', async () => {
		vi.stubGlobal('navigator', {
			...navigator,
			geolocation: {
				getCurrentPosition: (_: PositionCallback, failure: PositionErrorCallback) =>
					failure({ code: 1, PERMISSION_DENIED: 1, TIMEOUT: 3 } as GeolocationPositionError),
			},
		});
		vi.stubGlobal('isSecureContext', true);
		render(StopsIndex);
		await fireEvent.click(await screen.findByRole('button', { name: 'Stops near me' }));
		expect(
			await screen.findByText('Location permission was refused. Filter by name or code instead.'),
		).toBeInTheDocument();
	});

	it('leads to the address search with the reader’s provider', async () => {
		render(StopsIndex);
		expect(await screen.findByRole('link', { name: 'Near an address' })).toHaveAttribute(
			'href',
			'/search?provider=stm',
		);
	});
});

describe('Stops finder — selected preview', () => {
	it('previews a stop with its record, Map and record links that keep provider and week', async () => {
		const { container } = render(StopsIndex);
		await waitFor(() => expect(rows(container)).toHaveLength(20));
		const button = screen.getByRole('button', { name: 'Preview stop Stop 003' });
		await fireEvent.click(button);
		const preview = await screen.findByRole('region', { name: 'Stop 003' });
		expect(h.state.url.searchParams.get('stop')).toBe('S003');
		await waitFor(() =>
			expect(within(preview).getByRole('heading', { name: 'Stop 003' })).toHaveFocus(),
		);
		expect(preview.querySelector('[data-slot="stops-preview-figure"]')?.textContent).toContain(
			'1.3% of readings indicated a delay of more than 5 minutes.',
		);
		expect(preview.querySelector('[data-slot="stops-preview-period"]')?.textContent).toBe(
			'November 4 to 10, 2026 · 7 complete days',
		);
		expect(preview.textContent).toContain('80 readings; 1 more than 5 minutes late.');
		expect(within(preview).getByRole('link', { name: 'Open record' })).toHaveAttribute(
			'href',
			'/stop/S003?provider=stm&from=2026-11-04&to=2026-11-10',
		);
		const map = within(preview).getByRole('link', { name: 'Show on map' }).getAttribute('href')!;
		const mapUrl = new URL(map, 'http://localhost');
		expect(mapUrl.pathname).toBe('/map');
		expect(mapUrl.searchParams.get('provider')).toBe('stm');
		expect(mapUrl.searchParams.get('stop')).toBe('S003');
		expect(within(preview).getByRole('link', { name: 'Download CSV' })).toHaveAttribute(
			'download',
			'transit-stm-stop-5003-2026-11-04-to-2026-11-10.csv',
		);
		expect(within(preview).getByRole('button', { name: 'Cite this record' })).toBeInTheDocument();

		await fireEvent.click(within(preview).getByRole('button', { name: 'Back to results' }));
		await waitFor(() => expect(button).toHaveFocus());
		expect(h.state.url.searchParams.has('stop')).toBe(false);
	});

	it('says why a stop has no share in its preview, with no export or citation', async () => {
		h.state.url = new URL('http://localhost/stops?provider=stm&stop=S001');
		render(StopsIndex);
		const preview = await screen.findByRole('region', { name: 'Stop 001' });
		await waitFor(() =>
			expect(preview.textContent).toContain('This stop is not in the latest weekly record.'),
		);
		expect(within(preview).queryByRole('link', { name: 'Download CSV' })).toBeNull();
		expect(within(preview).queryByRole('button', { name: 'Cite this record' })).toBeNull();
	});

	it('previews the first row on desktop without a selection', async () => {
		h.state.desktop = true;
		render(StopsIndex);
		expect(await screen.findByRole('region', { name: 'Stop 001' })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Back to results' })).toBeNull();
	});
});

describe('Stops finder — French', () => {
	it('speaks French throughout, with French number and percent formats', async () => {
		h.state.locale = 'fr';
		h.state.stops = h.stopsFor(1200).map((stop, index) => (index === 2 ? stop : stop));
		const { container } = render(StopsIndex);
		await waitFor(() => expect(rows(container)).toHaveLength(20));
		expect(counts(container)).toBe(
			`20 arrêts affichés sur ${(1200).toLocaleString('fr-CA')} correspondants, ${(1200).toLocaleString('fr-CA')} dans ce réseau.`,
		);
		await waitFor(() =>
			expect(
				rowFor(container, 'Stop 003').querySelector('[data-slot="stop-row-figure"]'),
			).not.toBeNull(),
		);
		expect(rowFor(container, 'Stop 003').textContent).toMatch(/1,3\s%/u);
		expect(screen.getByRole('button', { name: 'Afficher 20 arrêts de plus' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Arrêts près de moi' })).toBeInTheDocument();
	});
});

describe('Stops finder — a failed line catalogue', () => {
	it('still lists every stop, naming lines by their published id', async () => {
		h.state.routesFailure = true;
		const { container } = render(StopsIndex);
		await waitFor(() => expect(rows(container)).toHaveLength(20));
		expect(screen.queryByText('Data unavailable')).toBeNull();
		expect(rowFor(container, 'Stop 001').querySelector('.finder-meta')?.textContent).toBe(
			'Code 5001 · Bus · Line 24',
		);
	});
});
