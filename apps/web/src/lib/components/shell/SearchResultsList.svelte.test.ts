import { render, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { expect, it, vi } from 'vitest';
import {
	searchHitHref,
	searchTransit,
	type ChromeSearchScope,
	type SearchSources,
} from '#lib/search/transitSearch.ts';
import type { Vehicle } from '#lib/v1/schemas/index.ts';
import SearchResultsList from './SearchResultsList.svelte';

const routes = [
	{ id: '17', short: '17', long: 'Décarie', type: 3 },
	{ id: '18', short: '18', long: 'Beaubien', type: 3 },
	{ id: '161', short: '161', long: 'Van Horne', type: 3 },
	{ id: '180', short: '180', long: 'De Salaberry', type: 3 },
];
const stops = Array.from({ length: 38 }, (_, i) => ({
	id: `s${i}`,
	code: `${5000 + i}`,
	name: `Van Horne / Rue ${i}`,
	lat: 0,
	lon: 0,
}));

function show(
	query: string,
	{
		scope = 'all',
		locale = 'en',
		sources = { routes, stops, vehicles: [] },
	}: {
		scope?: ChromeSearchScope;
		locale?: 'en' | 'fr';
		sources?: SearchSources;
	} = {},
) {
	const list = searchTransit({ surface: 'list', query, scope }, sources);
	const hrefs = {
		hit: (hit: Parameters<typeof searchHitHref>[0]) =>
			searchHitHref(hit, { path: '/', params: new URLSearchParams() }),
		all: `/search?q=${query}`,
		lines: '/lines',
		stops: '/stops',
	};
	return render(SearchResultsList, {
		props: { id: 'r', label: 'Results', list, query, locale, hrefs },
	});
}
const selected = (view: ReturnType<typeof show>) =>
	view.getAllByRole('option').filter((option) => option.getAttribute('aria-selected') === 'true');

it.each([
	['en', 'Lines · 1', 'Stops · 38', 'Line 161 · Van Horne', 'See all 39 results for “van”'],
	[
		'fr',
		'Lignes · 1',
		'Arrêts · 38',
		'Ligne 161 · Van Horne',
		'Voir les 39 résultats pour « van »',
	],
] as const)(
	'shows true totals in each heading and names each row by its text in %s',
	(locale, lines, stopsHeading, line, all) => {
		const view = show('van', { locale });
		expect(
			within(view.getByRole('group', { name: stopsHeading })).getAllByRole('option'),
		).toHaveLength(4);
		const row = within(view.getByRole('group', { name: lines })).getByRole('option', {
			name: line,
		});
		expect(row).toHaveAttribute('href', '/lines/161');
		expect(view.getByRole('option', { name: all })).toHaveAttribute('href', '/search?q=van');
	},
);

it('highlights an exact first row, and nothing otherwise', () => {
	const exact = show('18', { scope: 'route' });
	expect(selected(exact).map((option) => option.textContent?.trim())).toEqual([
		'Line 18 · Beaubien',
	]);
	exact.unmount();
	expect(selected(show('van'))).toEqual([]);
});

it('moves through every row, the pinned one included, wraps, and opens the highlighted row', async () => {
	const view = show('van');
	const options = view.getAllByRole('option');
	expect(view.component.choose()).toBe(false);
	view.component.move(-1);
	await tick();
	expect(selected(view)).toEqual([options.at(-1)]);
	view.component.move(1);
	await tick();
	expect(selected(view)).toEqual([options[0]]);
	const open = vi.fn((event: Event) => event.preventDefault());
	options[0]!.addEventListener('click', open);
	expect(view.component.choose()).toBe(true);
	expect(open).toHaveBeenCalledOnce();
});

it.each([
	['en', 'No line or stop matches “zzz”.', ['Browse all lines', 'Browse all stops']],
	[
		'fr',
		'Aucune ligne ni aucun arrêt ne correspond à « zzz ».',
		['Parcourir toutes les lignes', 'Parcourir tous les arrêts'],
	],
] as const)('offers the next steps when nothing matches in %s', (locale, message, steps) => {
	const view = show('zzz', { locale });
	expect(view.getByText(message)).toBeInTheDocument();
	expect(
		view
			.getAllByRole('option')
			.map((option) => [option.textContent?.trim(), option.getAttribute('href')]),
	).toEqual([
		[steps[0], '/lines'],
		[steps[1], '/stops'],
	]);
});

it('says nothing about matches while the indexes load', () => {
	const view = show('zzz', { sources: { routes, stops: null } });
	expect(view.queryByRole('listbox')).toBeNull();
	expect(view.queryByText(/No line or stop/)).toBeNull();
});

it.each([
	['en', 'Vehicle 40061 Line 161'],
	['fr', 'Véhicule 40061 Ligne 161'],
] as const)('names a live vehicle and its line in %s', (locale, name) => {
	const bus = { id: '40061', lat: 0, lon: 0, status: 'late', route: '161' } as Vehicle;
	const view = show('40061', { locale, sources: { routes, stops: [], vehicles: [bus] } });
	expect(view.getByRole('option', { name })).toHaveAttribute('aria-selected', 'true');
});
