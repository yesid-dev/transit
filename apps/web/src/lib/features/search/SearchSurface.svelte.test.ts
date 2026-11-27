import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { expect, it, vi, beforeEach } from 'vitest';
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
	Array.from({ length: 1160 }, (_, i) => ({
		id: `s${i}`,
		code: String(51000 + i),
		name: `Laurier / Avenue ${i}`,
		lat: 45.53,
		lon: -73.59,
	}));

it('leaves focus alone on load and focuses the field when a reader chooses an example', async () => {
	vi.stubGlobal('matchMedia', (query: string) => ({
		matches: query === '(hover: hover) and (pointer: fine)',
	}));
	setUrlQuery('');
	render(SearchSurface);
	const field = screen.getByRole('textbox');
	const example = await screen.findByRole('link', { name: /^1$/ });
	expect(document.body).toHaveFocus();

	await fireEvent.click(example);
	expect(field).toHaveFocus();
	expect(field).toHaveValue('1');
});

it.each(['en', 'fr'] as const)(
	'pages through ranked stop results and carries focus in %s',
	async (locale) => {
		localeState.locale = locale;
		stopData = hubStops();
		setUrlQuery('q=laurier&kind=stop&mode=metro');
		const view = render(SearchSurface);
		const fr = locale === 'fr';
		const stops = () =>
			within(view.getByRole('region', { name: fr ? /^Arrêts · 1/ : 'Stops · 1,160' }));
		expect(stops().getAllByRole('link')).toHaveLength(6);
		expect(stops().getByRole('status')).toHaveTextContent(
			fr ? /6 sur 1.160$/ : 'Showing 6 of 1,160',
		);
		expect(view.queryByRole('button', { name: 'Métro' })).toBeNull();
		await fireEvent.click(
			stops().getByRole('button', { name: fr ? 'Afficher plus' : 'Show more' }),
		);
		expect(stops().getAllByRole('link')).toHaveLength(12);
		await vi.waitFor(() => expect(stops().getAllByRole('link')[6]).toHaveFocus());
		expect(mirror).toHaveBeenLastCalledWith({ q: 'laurier', kind: 'stop', mode: null, rows: '12' });
	},
);

it('takes the query, kind and existing row count from a new search URL before writing back', () => {
	stopData = hubStops();
	const url = new SvelteURL('http://localhost/search?q=van');
	urlBox.nav = url;
	const view = render(SearchSurface);
	mirror.mockClear();
	url.search = '?q=laurier&kind=stop&rows=50';
	flushSync();
	expect(mirror).not.toHaveBeenCalled();
	for (const handler of navigation.after) handler({ type: 'goto', to: { url: new URL(url.href) } });
	flushSync();
	expect(view.getByRole('textbox', { name: 'Line, stop, vehicle or page' })).toHaveValue('laurier');
	expect(view.getByRole('tab', { name: 'Stops (1,160)' })).toHaveAttribute('aria-selected', 'true');
	expect(
		within(view.getByRole('region', { name: 'Stops · 1,160' })).getAllByRole('link'),
	).toHaveLength(50);
	expect(mirror).toHaveBeenLastCalledWith({ q: 'laurier', kind: 'stop', mode: null, rows: '50' });
});

it.each([
	['en', '', 'Try a search'],
	['fr', '', 'Essayez une recherche'],
	['en', 'x', 'Enter a line number or at least two letters.'],
	['fr', '---', 'Saisissez un numéro de ligne ou au moins deux lettres.'],
	['en', 'zzzz', 'Nothing found for “zzzz” in lines, stops, vehicles, pages.'],
	[
		'fr',
		'zzzz',
		'Aucun résultat pour « zzzz » dans les lignes, les arrêts, les véhicules, les pages.',
	],
] as const)('shows the matching state for %s query %s', (locale, q, message) => {
	localeState.locale = locale;
	setUrlQuery('q=' + encodeURIComponent(q));
	render(SearchSurface);
	expect(screen.getByText(message)).toBeVisible();
	if (q) expect(screen.getByText(message)).toHaveAttribute('role', 'status');
});

it.each(['en', 'fr'] as const)(
	'distinguishes an unavailable index from zero matches in %s',
	async (locale) => {
		localeState.locale = locale;
		scheduleState = 'error';
		vehicleState = 'unavailable';
		const view = render(SearchSurface);
		const fr = locale === 'fr';
		expect(view.getByRole('tab', { name: fr ? 'Arrêts' : 'Stops' })).toBeVisible();
		expect(
			view.getByText(
				fr
					? 'L’index de recherche est temporairement indisponible.'
					: 'The search index is temporarily unavailable.',
			),
		).toBeVisible();
		expect(view.queryByText(/Nothing found|Aucun résultat/)).toBeNull();
		await fireEvent.click(view.getByRole('button', { name: fr ? 'Réessayer' : 'Try again' }));
		expect(reload).toHaveBeenCalledOnce();
	},
);

it('shows loading while the index is pending', () => {
	scheduleState = 'loading';
	vehicleState = 'unavailable';
	render(SearchSurface);
	expect(screen.getByText('Loading the search index…')).toBeVisible();
	expect(screen.queryByText(/Nothing found/)).toBeNull();
});

it('explains missing vehicle tracking once and leaves the count absent', async () => {
	vehicleState = 'not_tracked';
	setUrlQuery('q=40061');
	const view = render(SearchSurface);
	const tab = view.getByRole('tab', { name: 'Vehicles' });
	expect(view.getAllByText('This feed does not track vehicles by number.')).toHaveLength(1);
	await fireEvent.click(tab);
	expect(view.getAllByText('This feed does not track vehicles by number.')).toHaveLength(1);
	expect(view.queryByText(/Nothing found/)).toBeNull();
});

it.each([
	['en', 'rapport quotidien', 'Daily report', '/receipt'],
	['fr', 'daily report', 'Rapport quotidien', '/fr/receipt'],
	['en', '40061', 'Vehicle 40061', '/vehicle/40061'],
	['en', 'ligne', /1.*Ligne 1 Verte.*Métro/, '/lines/1'],
	['en', '57191', /57191.*Van Horne \/ Rockland/, '/stop/57191'],
] as const)('links the matching record or page for %s query %s', (locale, query, name, href) => {
	localeState.locale = locale;
	setUrlQuery('q=' + encodeURIComponent(query));
	render(SearchSurface);
	expect(screen.getByRole('link', { name })).toHaveAttribute('href', href);
});

it('sends an address only on request and focuses the address result', async () => {
	const fetch = vi.fn(async () =>
		Response.json({
			results: [{ label: '100 Casgrain', lat: 45.52, lon: -73.6, precision: 'address' }],
		}),
	);
	vi.stubGlobal('fetch', fetch);
	setUrlQuery('q=casgrain');
	const view = render(SearchSurface);
	expect(fetch).not.toHaveBeenCalled();
	const ask = view.getByRole('button', { name: 'Search addresses for “casgrain”' });
	expect(ask).toHaveAccessibleDescription(
		"Sends this text to our server and to the Government of Canada's Geo.ca service.",
	);
	await fireEvent.click(ask);
	const found = await view.findByRole('link', { name: /100 Casgrain/ });
	expect(fetch).toHaveBeenCalledOnce();
	expect(found).toHaveAttribute('href', expect.stringMatching(/^\/map\?.*near/));
	await vi.waitFor(() => expect(found).toHaveFocus());
});

it.each([
	['', 'Try a search'],
	['q=ber', 'Station Berri-UQAM'],
	['q=zzzz', 'Nothing found for “zzzz”'],
])('keeps examples and results in the same column as the field (%s)', (query, text) => {
	setUrlQuery(query);
	const view = render(SearchSurface);
	const column = view.container.querySelector('[data-slot="search-column"]')!;
	const card = column.querySelector('[data-search-card]');
	expect(column.querySelector('h1')).not.toBeNull();
	expect(
		within(column as HTMLElement).getByRole('textbox', { name: 'Line, stop, vehicle or page' }),
	).toBeInTheDocument();
	if (query) {
		expect(card).toHaveTextContent(text);
		expect(card).toHaveAttribute('data-interactive', 'true');
	} else {
		expect(card).toBeNull();
		expect(column).toHaveTextContent(text);
	}
});
