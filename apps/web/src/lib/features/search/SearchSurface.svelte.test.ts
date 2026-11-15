import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { ReliabilitySnapshot } from '#lib/v1/reliabilitySnapshot.svelte.ts';
import type { RouteIndexEntry, StopIndexEntry, Vehicle } from '#lib/v1/schemas/index.ts';
import SearchSurface from './SearchSurface.svelte';

const ROUTES: RouteIndexEntry[] = [
	{ id: '1', short: '1', long: 'Ligne 1 Verte', type: 1, color: '009EE0' },
	{ id: '161', short: '161', long: 'Van Horne', type: 3, color: null },
];
const STOPS: StopIndexEntry[] = [
	{
		id: '57191',
		code: '57191',
		name: 'Van Horne / Rockland',
		lat: 45.53,
		lon: -73.59,
		mode: 'bus',
	},
	{
		id: '10146',
		code: '10146',
		name: 'Station Berri-UQAM',
		lat: 45.51,
		lon: -73.56,
		mode: 'metro',
	},
];
const VEHICLES: Vehicle[] = [
	{
		id: '40061',
		lat: 45.5,
		lon: -73.6,
		status: 'late',
		updated_utc: '2026-06-16T00:00:00Z' as Vehicle['updated_utc'],
		route: '161',
		trip: '296851600',
		next_stop: '57191',
		bearing: 90,
		occupancy: 'few_seats',
		delay_min: 4,
	},
];

const routeSnaps = new Map<string, ReliabilitySnapshot>();
const stopSnaps = new Map<string, ReliabilitySnapshot>();
function snap(partial: Partial<ReliabilitySnapshot>): ReliabilitySnapshot {
	return { phase: 'idle', otpPct: null, verdict: null, series: [], ...partial };
}

const localeState = vi.hoisted(() => ({ locale: 'en' as 'en' | 'fr' }));
vi.mock('#lib/i18n/index.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/i18n/index.ts')>()),
	getLocale: () => localeState.locale,
}));

const urlBox = vi.hoisted(() => ({ query: 'q=ber' }));
const liveHarness = vi.hoisted(() => ({ createLiveStore: vi.fn() }));
function setUrlQuery(q: string) {
	urlBox.query = q;
}

vi.mock('$app/state', () => ({
	page: {
		get url() {
			return new URL(`http://localhost/search?${urlBox.query}`);
		},
		data: {},
		state: {},
	},
}));
const mirror = vi.hoisted(() => vi.fn());
vi.mock('#lib/site/urlMirror.ts', () => ({ mirrorSearchParams: mirror }));

vi.mock('#lib/v1/repositories/static.ts', () => ({
	getRoutesIndex: vi.fn(),
	getStopsIndex: vi.fn(),
}));
vi.mock('#lib/v1/boot.ts', () => ({
	getV1Context: () => ({ manifest: {}, labels: {}, lang: 'en' }),
}));
vi.mock('#lib/v1/live/store.svelte.ts', () => ({
	LIVE_FAMILIES: ['vehicles', 'trips', 'departures', 'alerts', 'network'],
	createLiveStore: liveHarness.createLiveStore,
}));
vi.mock('#lib/v1/reliabilitySnapshot.svelte.ts', () => ({
	createReliabilityLoader: (kind: 'route' | 'stop') => {
		const store = kind === 'route' ? routeSnaps : stopSnaps;
		return {
			get: (id: string) => store.get(id) ?? snap({}),
			request: vi.fn(),
			reliability: () => ({ destroy() {} }),
			get inFlight() {
				return 0;
			},
		};
	},
}));

vi.mock('#lib/v1/resource.svelte.ts', () => ({
	createResource: (fetcher: () => unknown) => {
		void fetcher;
		return nextResource();
	},
}));

type IndexState = 'ok' | 'error' | 'loading';
let resourceCall = 0;
let routeData: RouteIndexEntry[] = ROUTES;
let stopData: StopIndexEntry[] = STOPS;
const indexState: Record<'routes' | 'stops', IndexState> = { routes: 'ok', stops: 'ok' };
const reloads = { routes: vi.fn(), stops: vi.fn() };
function nextResource() {
	resourceCall += 1;
	const kind = resourceCall % 2 === 1 ? 'routes' : 'stops';
	const state = indexState[kind];
	const data =
		state !== 'ok'
			? null
			: kind === 'routes'
				? { generated_utc: '2026-06-16T00:00:00Z', routes: routeData }
				: { generated_utc: '2026-06-16T00:00:00Z', stops: stopData };
	const error = state === 'error' ? new Error(`${kind} failed`) : null;
	const loading = state === 'loading';
	return { data, error, loading, settled: !loading, reload: reloads[kind] };
}

beforeEach(() => {
	localeState.locale = 'en';
	routeSnaps.clear();
	stopSnaps.clear();
	resourceCall = 0;
	routeData = ROUTES;
	stopData = STOPS;
	indexState.routes = 'ok';
	indexState.stops = 'ok';
	reloads.routes.mockReset();
	reloads.stops.mockReset();
	mirror.mockReset();
	vi.unstubAllGlobals();
	setUrlQuery('q=ber');
	liveHarness.createLiveStore.mockReset().mockReturnValue({
		vehicles: { generated_utc: '2026-06-16T00:00:00Z', vehicles: VEHICLES },
		generatedUtc: '2026-06-16T00:00:00Z',
		familyStates: {
			vehicles: {
				active: true,
				retainedGeneration: '2026-06-16T00:00:00Z',
				health: { retained: true, state: 'live', ageSeconds: 0, isStale: false, notice: null },
			},
		},
		ageSeconds: 0,
		isStale: false,
		start: vi.fn(),
		stop: vi.fn(),
	});
});

describe('SearchSurface idle state', () => {
	it("preserves each surface's tied line and stop order", () => {
		routeData = [
			{ id: 'z', short: '20', long: 'Café', type: 3 },
			{ id: 'a', short: '3', long: 'Café', type: 3 },
		];
		stopData = [
			{ id: 'z', code: 'z', name: 'Zulu Hub', lat: 0, lon: 0 },
			{ id: 'a', code: 'a', name: 'Alpha Hub', lat: 0, lon: 0 },
		];
		for (const [q, name, hrefs] of [
			['café', 'Lines · 2', ['/lines/z', '/lines/a']],
			['hub', 'Stops · 2', ['/stop/z', '/stop/a']],
		] as const) {
			setUrlQuery(`q=${q}`);
			const view = render(SearchSurface);
			expect(
				within(view.getByRole('region', { name }))
					.getAllByRole('link')
					.map((r) => r.getAttribute('href')),
			).toEqual(hrefs);
			view.unmount();
		}
	});
	it("keeps exact, prefix, substring and reversed-token matches in today's order", () => {
		routeData = ['x hub', 'hub north', 'hub', 'hub x'].map((long, i) => ({
			id: `r${i}`,
			short: `n${i}`,
			long,
			type: 3,
		}));
		for (const [q, ids] of [
			['hub', ['r2', 'r1', 'r3', 'r0']],
			['x hub', ['r0', 'r3']],
			['n1', ['r1']],
			['r1', ['r1']],
			['40061', []],
			['400', []],
		] as const) {
			setUrlQuery(`q=${q}`);
			const view = render(SearchSurface);
			expect(
				view.queryByRole('region', { name: /^Lines/ })
					? within(view.getByRole('region', { name: /^Lines/ }))
							.getAllByRole('link')
							.map((r) => r.getAttribute('href'))
					: [],
			).toEqual(ids.map((id) => `/lines/${id}`));
			expect(view.queryAllByRole('link', { name: /Live bus/ })).toHaveLength(q === '40061' ? 1 : 0);
			view.unmount();
		}
	});
	it.each(['en', 'fr'] as const)('omits the catalogue census and live age in %s', (locale) => {
		localeState.locale = locale;
		setUrlQuery('');
		const { container } = render(SearchSurface);
		expect(container.querySelector('[data-slot="search-census"]')).toBeNull();
		expect(container.querySelector('[data-slot="freshness-stamp"]')).toBeNull();
		expect(screen.queryByText(/The network right now|Le réseau en ce moment/)).toBeNull();
		expect(
			screen.getByRole('button', { name: /^(Line number|Numéro de ligne)$/ }),
		).toBeInTheDocument();
	});

	it('uses the shared listing search with an accessible name and magnifier', () => {
		const { container } = render(SearchSurface);
		const box = screen.getByRole('textbox', { name: 'Search lines, stops and buses' });
		expect(box.closest('[data-slot="listing-search-field"]')).not.toBeNull();
		expect(box.parentElement?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
		expect(container.querySelector('label[for="surface-search-input"]')).toBeNull();
	});

	it('shows the instructional idle note before the rider types', () => {
		setUrlQuery('');
		render(SearchSurface);
		expect(liveHarness.createLiveStore.mock.calls[0]?.[2]).toEqual({
			families: ['vehicles'],
		});
		expect(screen.getByText('Search a line, stop or bus')).toBeInTheDocument();
	});
});

describe('SearchSurface inline reliability', () => {
	it('renders the OTP% badge on a stop result whose reliability loaded', () => {
		stopSnaps.set('10146', snap({ phase: 'ready', otpPct: 88, verdict: 'reliable', kind: 'stop' }));
		render(SearchSurface);
		expect(screen.getByText('88%')).toBeInTheDocument();
		// The row names its measure and period, not only to assistive tech.
		expect(screen.getByText('not severely late, last 7 days')).toBeInTheDocument();
	});

	it('shows no badge for a result with no reliability data (honesty)', () => {
		stopSnaps.set('10146', snap({ phase: 'empty' }));
		const { container } = render(SearchSurface);
		expect(container.querySelector('[data-slot="reliability-badge"]')).toBeNull();
		expect(screen.getByRole('link', { name: /Station Berri-UQAM/i })).toBeInTheDocument();
	});
});

describe('SearchSurface line mode + colour', () => {
	it('renders a guarded colour swatch only when the GTFS colour is present', () => {
		setUrlQuery('q=ligne');
		const { container } = render(SearchSurface);
		const swatch = container.querySelector('.entity-row-swatch') as HTMLElement | null;
		expect(swatch).not.toBeNull();
		expect(swatch?.getAttribute('style')).toContain('#009ee0');
	});

	it('tags a métro line with its mode', () => {
		setUrlQuery('q=ligne');
		render(SearchSurface);
		const lines = screen.getByRole('region', { name: /^Lines/ });
		expect(within(lines).getByText('Métro')).toBeInTheDocument();
	});
});

describe('SearchSurface stop mode tag for all modes', () => {
	it('tags a plain BUS stop with a visible mode tag (today untagged)', () => {
		setUrlQuery('q=van horne');
		render(SearchSurface);
		const stops = screen.getByRole('region', { name: /^Stops/ });
		expect(within(stops).getByText('Bus')).toBeInTheDocument();
	});
});

describe('SearchSurface scope filter', () => {
	it('restricts to lines, hiding stop results', async () => {
		setUrlQuery('q=van horne');
		render(SearchSurface);
		expect(screen.getByRole('link', { name: /161.*Van Horne/i })).toBeInTheDocument();
		expect(screen.getByRole('link', { name: /Van Horne \/ Rockland/i })).toBeInTheDocument();

		const scopeGroup = screen.getByRole('tablist', { name: 'Show' });
		await within(scopeGroup)
			.getByRole('tab', { name: /Lines \(1\)/ })
			.click();

		expect(screen.getByRole('link', { name: /161.*Van Horne/i })).toBeInTheDocument();
		expect(screen.queryByRole('link', { name: /Van Horne \/ Rockland/i })).toBeNull();
	});
});

describe('SearchSurface mode chip filter', () => {
	it('narrows to métro lines/stops when the Métro chip is on', async () => {
		setUrlQuery('q=van horne');
		render(SearchSurface);
		expect(screen.getByRole('link', { name: /161.*Van Horne/i })).toBeInTheDocument();

		const metroChip = screen.getByRole('button', { name: 'Métro' });
		await metroChip.click();

		expect(screen.queryByRole('link', { name: /161.*Van Horne/i })).toBeNull();
	});
});

describe('SearchSurface vehicle results', () => {
	it('shows a matched live bus with status, signed delay, and resolved next stop', () => {
		setUrlQuery('q=40061');
		render(SearchSurface);

		const busRow = screen.getByRole('link', { name: 'Live bus 40061, Late, Delay: +4 min' });
		expect(busRow).toBeInTheDocument();
		expect(busRow).toHaveAttribute('href', '/map?vehicle=40061');
		expect(within(busRow).getByText('Late')).toBeInTheDocument();
		expect(
			within(busRow.closest('[data-slot="entity-result-row"]')!).getByText('+4 min'),
		).toBeInTheDocument();
		expect(within(busRow).getByText('Next: Van Horne / Rockland')).toBeInTheDocument();
	});
});

describe('SearchSurface addresses on request', () => {
	const NOTICE_EN =
		"Sends this text to our server and to the Government of Canada's Geo.ca service.";

	it('carries no standing notice; the address action carries it', () => {
		setUrlQuery('');
		const idle = render(SearchSurface);
		expect(idle.queryByText(NOTICE_EN)).toBeNull();
		idle.unmount();

		setUrlQuery('q=casgrain');
		const queried = render(SearchSurface);
		const ask = queried.getByRole('button', { name: 'Search addresses for “casgrain”' });
		expect(ask).toHaveAccessibleDescription(NOTICE_EN);
	});

	it('sends the text once when asked, then lists the addresses or says why not', async () => {
		const fetch = vi.fn(async () =>
			Response.json({
				results: [{ label: '100 Casgrain', lat: 45.52, lon: -73.6, precision: 'address' }],
			}),
		);
		vi.stubGlobal('fetch', fetch);
		setUrlQuery('q=casgrain');
		const view = render(SearchSurface);
		expect(fetch).not.toHaveBeenCalled();
		await view.getByRole('button', { name: 'Search addresses for “casgrain”' }).click();
		const addresses = await view.findByRole('region', { name: 'Addresses · 1' });
		expect(fetch).toHaveBeenCalledTimes(1);
		const found = within(addresses).getByRole('link', { name: /100 Casgrain/ });
		expect(found).toHaveAttribute('href', expect.stringMatching(/^\/map\?.*near/));
		await vi.waitFor(() => expect(found).toHaveFocus());
		view.unmount();

		// Without an answer the row keeps focus and says why, aloud too.
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(null, { status: 503 })),
		);
		const failed = render(SearchSurface);
		const ask = failed.getByRole('button', { name: 'Search addresses for “casgrain”' });
		ask.focus();
		await ask.click();
		const row = await failed.findByRole('button', {
			name: 'Address search is unavailable right now.',
		});
		expect(row).toBe(ask);
		expect(row).toHaveFocus();
		expect(row).toHaveAttribute('aria-disabled', 'true');
		expect(failed.getAllByRole('status').map((status) => status.textContent)).toContain(
			'Address search is unavailable right now.',
		);
	});
});

it('preserves mode filtering relative to stop deduplication', async () => {
	stopData = [
		{ id: 'rail-first', code: 'r', name: 'Station Central', lat: 0, lon: 0, mode: 'rail' },
		{ id: 'metro-second', code: 'm', name: 'Station Central', lat: 0, lon: 0, mode: 'metro' },
	];
	setUrlQuery('q=central');
	const view = render(SearchSurface);
	expect(view.getByRole('link', { name: /Station Central/ })).toHaveAttribute(
		'href',
		'/stop/rail-first',
	);
	await view.getByRole('button', { name: 'Métro' }).click();
	expect(view.queryByRole('region', { name: /^Stops/ })).toBeNull();
	expect(view.getByText('No line or stop matches “central”.')).toBeInTheDocument();
});

it.each(['en', 'fr'] as const)(
	'counts every match in each heading and Show all reveals exactly that many in %s',
	async (locale) => {
		localeState.locale = locale;
		const en = locale === 'en';
		routeData = Array.from({ length: 8 }, (_, i) => ({
			id: `r${i}`,
			short: String(i),
			long: 'Hub',
			type: 3,
		}));
		stopData = Array.from({ length: 120 }, (_, i) => ({
			id: `s${i}`,
			code: String(1000 + i),
			name: `Hub ${i}`,
			lat: 0,
			lon: 0,
		}));
		setUrlQuery('q=hub');
		const view = render(SearchSurface);
		const lines = within(view.getByRole('region', { name: en ? 'Lines · 8' : 'Lignes · 8' }));
		expect(lines.getAllByRole('link')).toHaveLength(6);
		const stops = () =>
			within(view.getByRole('region', { name: en ? 'Stops · 120' : 'Arrêts · 120' }));
		expect(stops().getAllByRole('link')).toHaveLength(6);

		await stops()
			.getByRole('button', { name: en ? 'Show all 120 stops' : 'Afficher les 120 arrêts' })
			.click();
		expect(view.queryByRole('region', { name: en ? /^Lines/ : /^Lignes/ })).toBeNull();
		expect(mirror).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'stop' }));
		const more = en ? /^Show \d+ more stops$/ : /^Afficher \d+ autres arrêts$/;
		const revealed = [stops().getAllByRole('link').length];
		for (let button = stops().queryByRole('button', { name: more }); button; ) {
			await button.click();
			revealed.push(stops().getAllByRole('link').length);
			button = stops().queryByRole('button', { name: more });
		}
		expect(revealed).toEqual([50, 100, 120]);
		await vi.waitFor(() => expect(document.activeElement).toBe(stops().getAllByRole('link')[100]));
		expect(mirror).toHaveBeenLastCalledWith(expect.objectContaining({ rows: '150' }));
	},
);

it('restores the query, kind, modes and revealed rows from the URL', () => {
	stopData = Array.from({ length: 120 }, (_, i) => ({
		id: `s${i}`,
		code: String(1000 + i),
		name: `Hub ${i}`,
		lat: 0,
		lon: 0,
		mode: i % 2 ? 'metro' : 'bus',
	}));
	setUrlQuery('q=hub&kind=stop&mode=metro&rows=100');
	const view = render(SearchSurface);
	expect(view.getByRole('textbox', { name: 'Search lines, stops and buses' })).toHaveValue('hub');
	expect(view.getByRole('tab', { name: 'Stops (60)' })).toHaveAttribute('aria-selected', 'true');
	expect(view.getByRole('button', { name: 'Métro' })).toHaveAttribute('aria-pressed', 'true');
	const stops = within(view.getByRole('region', { name: 'Stops · 60' }));
	expect(stops.getAllByRole('link')).toHaveLength(60);
	expect(view.queryByRole('region', { name: /^Lines/ })).toBeNull();
});

it('writes the query, kind and modes to the URL as they change', async () => {
	setUrlQuery('');
	const view = render(SearchSurface);
	await fireEvent.input(view.getByRole('textbox', { name: 'Search lines, stops and buses' }), {
		target: { value: 'van horne' },
	});
	expect(mirror).toHaveBeenLastCalledWith({ q: 'van horne', kind: null, mode: null, rows: null });
	await view.getByRole('tab', { name: /^Stops/ }).click();
	await view.getByRole('button', { name: 'Métro' }).click();
	expect(mirror).toHaveBeenLastCalledWith({
		q: 'van horne',
		kind: 'stop',
		mode: 'metro',
		rows: null,
	});
});

it.each(['en', 'fr'] as const)(
	'keeps line results when the stop index fails, never counting stops as zero, in %s',
	async (locale) => {
		localeState.locale = locale;
		const en = locale === 'en';
		indexState.stops = 'error';
		setUrlQuery('q=van horne');
		const view = render(SearchSurface);
		const lines = view.getByRole('region', { name: en ? 'Lines · 1' : 'Lignes · 1' });
		expect(within(lines).getByRole('link', { name: /161.*Van Horne/ })).toBeInTheDocument();
		const stops = view.getByRole('region', { name: en ? 'Stops' : 'Arrêts' });
		expect(view.getByRole('tab', { name: en ? 'Stops' : 'Arrêts' })).toBeInTheDocument();
		await within(stops)
			.getByRole('button', { name: en ? 'Retry' : 'Réessayer' })
			.click();
		expect(reloads.stops).toHaveBeenCalledTimes(1);
	},
);

it('shows a group that is still loading without a count and without hiding the other', () => {
	indexState.routes = 'loading';
	setUrlQuery('q=van horne');
	const view = render(SearchSurface);
	expect(view.getByRole('region', { name: 'Lines' })).toBeInTheDocument();
	expect(view.getByRole('region', { name: 'Stops · 1' })).toBeInTheDocument();
	expect(view.queryByText('No line or stop matches “van horne”.')).toBeNull();
});

it.each([
	['en', 'missing trip', 'Daily report', 'Rankings and reports', /\/receipt$/],
	['fr', 'rapport', 'Rapport quotidien', 'Classements et rapports', /\/receipt$/],
	['en', 'on time', 'How we measure', 'About the data', /\/metrics$/],
] as const)('finds pages in %s: %s', (locale, q, name, group, href) => {
	localeState.locale = locale;
	setUrlQuery('q=' + encodeURIComponent(q));
	const view = render(SearchSurface);
	const pages = within(view.getByRole('region', { name: 'Pages · 1' }));
	const link = pages.getByRole('link', { name: new RegExp(name) });
	expect(link).toHaveTextContent(group);
	expect(link.getAttribute('href')).toMatch(href);
});

it('gives the live vehicles their own clock, inside their group', () => {
	setUrlQuery('q=40061');
	const view = render(SearchSurface);
	const vehicles = view.getByRole('region', { name: 'Live vehicles · 1' });
	expect(within(vehicles).getByRole('link', { name: /Live bus 40061/ })).toBeInTheDocument();
	expect(vehicles.querySelector('[data-slot="freshness-stamp"]')).not.toBeNull();
	expect(view.container.querySelectorAll('[data-slot="freshness-stamp"]')).toHaveLength(1);
});

it.each(['CRÉMAZIE', 'cremazie', 'Berri-UQAM', 'uqam berri'])(
	'matches accents and punctuation without changing labels: %s',
	(q) => {
		stopData = [{ id: 'c', code: 'c', name: 'Station Crémazie', lat: 0, lon: 0 }, STOPS[1]];
		setUrlQuery('q=' + encodeURIComponent(q));
		const view = render(SearchSurface);
		expect(view.getByRole('link', { name: /Station/ })).toHaveTextContent(
			q.toLowerCase().includes('mazie') ? 'Station Crémazie' : 'Station Berri-UQAM',
		);
	},
);

it.each(['en', 'fr'] as const)(
	'distinguishes blank, punctuation-only and unmatched queries in both locales: %s',
	async (locale) => {
		localeState.locale = locale;
		for (const q of ['', '   ', '---', 'zzzz']) {
			setUrlQuery('q=' + encodeURIComponent(q));
			const view = render(SearchSurface);
			expect(view.queryAllByRole('region')).toHaveLength(0);
			if (q === 'zzzz') expect(view.getByText(noMatch(locale, q))).toBeInTheDocument();
			else {
				expect(view.getByRole('note')).toHaveTextContent(
					locale === 'en'
						? 'Search a line, stop or bus'
						: 'Rechercher une ligne, un arrêt ou un bus',
				);
				expect(
					view.getByRole('button', { name: locale === 'en' ? 'Line number' : 'Numéro de ligne' }),
				).toBeInTheDocument();
				expect(view.container.querySelector('[data-slot="freshness-stamp"]')).toBeNull();
			}
			view.unmount();
		}
		setUrlQuery('q=van horne');
		const view = render(SearchSurface);
		await view.getByRole('button', { name: 'Métro' }).click();
		expect(view.getByText(noMatch(locale, 'van horne'))).toBeInTheDocument();
	},
);
const noMatch = (locale: 'en' | 'fr', q: string) =>
	locale === 'en'
		? `No line or stop matches “${q}”.`
		: `Aucune ligne ni aucun arrêt ne correspond à « ${q} ».`;

it('keeps stop codes, cross-street order and existing stop representatives', () => {
	stopData = [
		{ id: 'first', code: '100', name: 'Park / Road', lat: 0, lon: 0 },
		{ id: 'same-code', code: '100', name: 'Park / Road', lat: 0, lon: 0 },
		{ id: 'other', code: '200', name: 'Park / Road', lat: 0, lon: 0 },
		{ id: 'station-first', code: '300', name: 'Station Central', lat: 0, lon: 0 },
		{ id: 'station-second', code: '400', name: 'Station Central', lat: 0, lon: 0 },
	];
	for (const [q, hrefs] of [
		['100', ['/stop/first']],
		['road park', ['/stop/first', '/stop/other']],
		['central', ['/stop/station-first', '/stop/station-second']],
	] as const) {
		setUrlQuery('q=' + q);
		const view = render(SearchSurface);
		expect(
			within(view.getByRole('region', { name: /^Stops/ }))
				.getAllByRole('link')
				.map((r) => r.getAttribute('href')),
		).toEqual(hrefs);
		view.unmount();
	}
});
