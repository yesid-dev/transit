import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { flushSync } from 'svelte';
import { SvelteURL } from 'svelte/reactivity';

import type { RouteIndexEntry, StopIndexEntry } from '#lib/v1/schemas/index.ts';
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
const localeState = vi.hoisted(() => ({ locale: 'en' as 'en' | 'fr' }));
vi.mock('#lib/i18n/index.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/i18n/index.ts')>()),
	getLocale: () => localeState.locale,
}));

const urlBox = vi.hoisted(() => ({ query: 'q=ber', nav: null as URL | null }));
function setUrlQuery(q: string) {
	urlBox.query = q;
}

vi.mock('$app/state', () => ({
	page: {
		get url() {
			return urlBox.nav ?? new URL(`http://localhost/search?${urlBox.query}`);
		},
		data: {},
		state: {},
	},
}));
// Like the real mirror, it reads the router's URL while it writes.
const mirror = vi.hoisted(() => vi.fn((_: unknown) => void urlBox.nav?.search));
const navigation = vi.hoisted(() => ({
	after: [] as ((nav: { type: string; to: { url: URL } | null }) => void)[],
}));
vi.mock('$app/navigation', () => ({
	goto: () => Promise.resolve(),
	afterNavigate: (handler: (typeof navigation.after)[number]) => navigation.after.push(handler),
}));
vi.mock('#lib/site/urlMirror.ts', () => ({ mirrorSearchParams: mirror }));

vi.mock('#lib/v1/resource.svelte.ts', () => ({
	createResource: () => ({
		data: {
			schedule:
				scheduleState === 'ok' ? { date: '2026-11-21', routes: routeData, stops: stopData } : null,
			vehicles: vehicleState === 'ready' ? [{ id: '40061' }] : null,
			vehicle_state: vehicleState,
		},
		loading: scheduleState === 'loading',
		settled: scheduleState !== 'loading',
		reload,
	}),
}));

let routeData: RouteIndexEntry[] = ROUTES;
let stopData: StopIndexEntry[] = STOPS;
let scheduleState: 'ok' | 'error' | 'loading';
let vehicleState: 'ready' | 'unavailable' | 'not_tracked';
const reload = vi.fn();

beforeEach(() => {
	localeState.locale = 'en';
	routeData = ROUTES;
	stopData = STOPS;
	scheduleState = 'ok';
	vehicleState = 'ready';
	reload.mockClear();
	mirror.mockClear();
	navigation.after.length = 0;
	urlBox.nav = null;
	vi.unstubAllGlobals();
	setUrlQuery('q=ber');
});

const hubStops = (): StopIndexEntry[] =>
	Array.from({ length: 120 }, (_, i) => ({
		id: `s${i}`,
		code: String(1000 + i),
		name: `Hub ${i}`,
		lat: 0,
		lon: 0,
		mode: i % 2 ? 'metro' : 'bus',
	}));

it('takes the place of another /search URL opened on this page before writing anything back', () => {
	stopData = hubStops();
	const url = new SvelteURL('http://localhost/search?q=van');
	urlBox.nav = url;
	const view = render(SearchSurface);
	mirror.mockClear();

	url.search = '?q=hub&kind=stop&mode=metro&rows=100';
	flushSync();
	expect(mirror).not.toHaveBeenCalled();
	for (const handler of navigation.after) handler({ type: 'goto', to: { url: new URL(url.href) } });
	flushSync();

	expect(view.getByRole('textbox', { name: 'Search lines, stops and vehicles' })).toHaveValue(
		'hub',
	);
	expect(view.getByRole('tab', { name: 'Stops (60)' })).toHaveAttribute('aria-selected', 'true');
	expect(view.getByRole('button', { name: 'Métro' })).toHaveAttribute('aria-pressed', 'true');
	expect(
		within(view.getByRole('region', { name: 'Stops · 60' })).getAllByRole('link'),
	).toHaveLength(60);
	expect(mirror).toHaveBeenLastCalledWith({ q: 'hub', kind: 'stop', mode: 'metro', rows: '100' });
});

it.each([
	['100junk', '100junk', 50, null],
	['400 digits', '9'.repeat(400), 50, null],
	['-50', '-50', 50, null],
	['100.5', '100.5', 50, null],
	['75', '75', 50, null],
	['100', '100', 100, '100'],
	['999999950', '999999950', 120, '150'],
])('reads rows=%s as a whole number of 50-row steps', (_, value, shown, mirrored) => {
	stopData = hubStops().map((stop) => ({ ...stop, mode: 'bus' }));
	setUrlQuery(`q=hub&kind=stop&rows=${value}`);
	const view = render(SearchSurface);
	expect(
		within(view.getByRole('region', { name: 'Stops · 120' })).getAllByRole('link'),
	).toHaveLength(shown);
	expect(mirror).toHaveBeenLastCalledWith(expect.objectContaining({ rows: mirrored }));
});

it.each(['en', 'fr'] as const)(
	'keeps vehicles without evidence uncounted in %s',
	async (locale) => {
		localeState.locale = locale;
		vehicleState = 'unavailable';
		setUrlQuery('q=van horne');
		const view = render(SearchSurface);
		const en = locale === 'en';
		expect(view.getByRole('region', { name: en ? 'Lines · 1' : 'Lignes · 1' })).toBeInTheDocument();
		const group = view.getByRole('region', { name: en ? 'Vehicles' : 'Véhicules' });
		await within(group)
			.getByRole('button', { name: en ? 'Try again' : 'Réessayer' })
			.click();
		expect(reload).toHaveBeenCalledOnce();
	},
);

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
			expect(view.queryAllByRole('link', { name: /Vehicle 40061/ })).toHaveLength(
				q === '40061' ? 1 : 0,
			);
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
	});

	it('uses the shared listing search with an accessible name and magnifier', () => {
		const { container } = render(SearchSurface);
		const box = screen.getByRole('textbox', { name: 'Search lines, stops and vehicles' });
		expect(box.closest('[data-slot="listing-search-field"]')).not.toBeNull();
		expect(box.parentElement?.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
		expect(container.querySelector('label[for="surface-search-input"]')).toBeNull();
	});

	it('shows the instructional idle note before the rider types', () => {
		setUrlQuery('');
		render(SearchSurface);
		expect(screen.getByText('Search a line, stop or vehicle')).toBeInTheDocument();
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
	it('links an exact number to the vehicle record without live claims', () => {
		setUrlQuery('q=40061');
		render(SearchSurface);
		expect(screen.getByRole('link', { name: 'Vehicle 40061' })).toHaveAttribute(
			'href',
			'/vehicle/40061',
		);
	});
	it('explains when the feed does not track vehicle numbers', () => {
		vehicleState = 'not_tracked';
		setUrlQuery('q=40061&kind=vehicle');
		render(SearchSurface);
		expect(
			within(screen.getByRole('region', { name: 'Vehicles' })).getByRole('status'),
		).toHaveTextContent('does not track vehicles by number');
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
	expect(view.getByRole('textbox', { name: 'Search lines, stops and vehicles' })).toHaveValue(
		'hub',
	);
	expect(view.getByRole('tab', { name: 'Stops (60)' })).toHaveAttribute('aria-selected', 'true');
	expect(view.getByRole('button', { name: 'Métro' })).toHaveAttribute('aria-pressed', 'true');
	const stops = within(view.getByRole('region', { name: 'Stops · 60' }));
	expect(stops.getAllByRole('link')).toHaveLength(60);
	expect(view.queryByRole('region', { name: /^Lines/ })).toBeNull();
});

it('writes the query, kind and modes to the URL as they change', async () => {
	setUrlQuery('');
	const view = render(SearchSurface);
	await fireEvent.input(view.getByRole('textbox', { name: 'Search lines, stops and vehicles' }), {
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

it('keeps a missing edition distinct from zero results', async () => {
	scheduleState = 'error';
	render(SearchSurface);
	const stops = screen.getByRole('region', { name: 'Stops' });
	expect(within(stops).getByRole('status')).toHaveTextContent('Stop search is unavailable');
	expect(screen.queryByText(noMatch('en', 'ber'))).toBeNull();
	await within(stops).getByRole('button', { name: 'Try again' }).click();
	expect(reload).toHaveBeenCalledOnce();
});

it('shows schedule groups that are still loading without counts', () => {
	scheduleState = 'loading';
	render(SearchSurface);
	expect(screen.getByRole('region', { name: 'Lines' })).toBeInTheDocument();
	expect(screen.getByRole('region', { name: 'Stops' })).toBeInTheDocument();
	expect(screen.queryByText(noMatch('en', 'ber'))).toBeNull();
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
						? 'Search a line, stop or vehicle'
						: 'Rechercher une ligne, un arrêt ou un véhicule',
				);
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
