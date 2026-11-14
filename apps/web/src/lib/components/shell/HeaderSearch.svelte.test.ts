import { fireEvent, render, within } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { goto } from '$app/navigation';
import { searchTransit, type ChromeSearchScope } from '#lib/search/transitSearch.ts';
import HeaderSearch from './HeaderSearch.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
afterEach(() => vi.clearAllMocks());

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
const path = (href: string | null) => {
	const url = new URL(href ?? '', 'https://transit.local');
	url.searchParams.delete('provider');
	return url.pathname + url.search;
};

function show(
	query: string,
	at = '/',
	scope: ChromeSearchScope = 'all',
	locale: 'en' | 'fr' = 'en',
) {
	const list = searchTransit({ surface: 'list', query, scope }, { routes, stops, vehicles: [] });
	const url = new URL(at, 'https://transit.local');
	const view = render(HeaderSearch, {
		props: { locale, providerId: 'stm', url, scope, list, query },
	});
	return { ...view, input: view.getByRole('combobox', { name: /^(Search|Rechercher)/ }) };
}

it('shows true totals in each heading and links each row to its record', () => {
	const view = show('van');
	const stopsGroup = view.getByRole('group', { name: 'Stops · 38' });
	expect(within(stopsGroup).getAllByRole('option')).toHaveLength(4);
	const line = within(view.getByRole('group', { name: 'Lines · 1' })).getByRole('option', {
		name: 'Line 161 · Van Horne',
	});
	expect(path(line.getAttribute('href'))).toBe('/lines/161');
	const all = view.getByRole('option', { name: 'See all 39 results for “van”' });
	expect(path(all.getAttribute('href'))).toBe('/search?q=van');
	expect(view.input).toHaveAttribute('aria-controls', view.getByRole('listbox').id);
	expect(view.input).toHaveAttribute('aria-expanded', 'true');
});

it('Enter with nothing highlighted opens the search page', async () => {
	const view = show('van');
	expect(view.input).not.toHaveAttribute('aria-activedescendant');
	await fireEvent.keyDown(view.input, { key: 'Enter' });
	expect(path(String(vi.mocked(goto).mock.calls[0]?.[0]))).toBe('/search?q=van');
});

const opened = (option: HTMLElement) => {
	const click = vi.fn((event: Event) => event.preventDefault());
	option.addEventListener('click', click);
	return click;
};

it('an exact line number is highlighted on a line page, and Enter opens that line', async () => {
	const view = show('18', '/lines/17?tab=reliability&grain=week', 'route');
	const line = view.getByRole('option', { name: 'Line 18 · Beaubien' });
	expect(line).toHaveAttribute('aria-selected', 'true');
	expect(view.input).toHaveAttribute('aria-activedescendant', line.id);
	expect(path(line.getAttribute('href'))).toBe('/lines/18?tab=reliability&grain=week');
	const click = opened(line);
	await fireEvent.keyDown(view.input, { key: 'Enter' });
	expect(click).toHaveBeenCalledOnce();
	expect(goto).not.toHaveBeenCalled();
});

it('Down and Up move through every row and wrap, the pinned row included; Enter opens the row', async () => {
	const view = show('van');
	const options = view.getAllByRole('option');
	expect(options).toHaveLength(6);
	await fireEvent.keyDown(view.input, { key: 'ArrowUp' });
	expect(view.input).toHaveAttribute('aria-activedescendant', options[5]!.id);
	await fireEvent.keyDown(view.input, { key: 'ArrowDown' });
	expect(view.input).toHaveAttribute('aria-activedescendant', options[0]!.id);
	expect(options[0]).toHaveAttribute('aria-selected', 'true');
	const click = opened(options[0]!);
	await fireEvent.keyDown(view.input, { key: 'Enter' });
	expect(click).toHaveBeenCalledOnce();
	expect(goto).not.toHaveBeenCalled();
});

it('Escape closes, then clears; Tab closes and moves on', async () => {
	const view = show('van');
	await fireEvent.keyDown(view.input, { key: 'Escape' });
	expect(view.queryByRole('listbox')).toBeNull();
	expect(view.input).toHaveAttribute('aria-expanded', 'false');
	expect(view.input).toHaveValue('van');
	await fireEvent.keyDown(view.input, { key: 'Escape' });
	expect(view.input).toHaveValue('');
	await fireEvent.input(view.input, { target: { value: 'van' } });
	expect(view.getByRole('listbox')).toBeInTheDocument();
	const tab = await fireEvent.keyDown(view.input, { key: 'Tab' });
	expect(tab).toBe(true);
	expect(view.queryByRole('listbox')).toBeNull();
});

it.each([
	['en', '1 line, 38 stops'],
	['fr', '1 ligne, 38 arrêts'],
] as const)('announces the totals in %s once typing pauses', async (locale, said) => {
	vi.useFakeTimers();
	try {
		const view = show('van', '/', 'all', locale);
		const status = view.getByRole('status');
		expect(status).toHaveTextContent('');
		await vi.advanceTimersByTimeAsync(500);
		expect(status).toHaveTextContent(said);
	} finally {
		vi.useRealTimers();
	}
});

it.each([
	['en', 'No line or stop matches “zzz”.', ['Browse all lines', 'Browse all stops'], ''],
	[
		'fr',
		'Aucune ligne ni aucun arrêt ne correspond à « zzz ».',
		['Parcourir toutes les lignes', 'Parcourir tous les arrêts'],
		'/fr',
	],
] as const)(
	'offers the next steps when nothing matches in %s',
	(locale, message, steps, prefix) => {
		const view = show('zzz', '/', 'all', locale);
		expect(view.getByText(message)).toBeInTheDocument();
		expect(
			view
				.getAllByRole('option')
				.map((option) => [option.textContent?.trim(), path(option.getAttribute('href'))]),
		).toEqual([
			[steps[0], `${prefix}/lines`],
			[steps[1], `${prefix}/stops`],
		]);
	},
);

it('says nothing about matches while the indexes load', () => {
	const list = searchTransit({ surface: 'list', query: 'zzz' }, { routes, stops: null });
	const view = render(HeaderSearch, {
		props: {
			locale: 'en',
			providerId: 'stm',
			url: new URL('https://transit.local/'),
			scope: 'all',
			list,
			query: 'zzz',
		},
	});
	expect(view.queryByRole('listbox')).toBeNull();
	expect(view.queryByText(/No line or stop/)).toBeNull();
	expect(view.getByRole('combobox', { name: 'Search the network' })).toHaveAttribute(
		'aria-expanded',
		'false',
	);
});

it.each([
	['en', '1 line. Stops have not been searched yet.'],
	['fr', '1 ligne. Les arrêts n’ont pas encore été cherchés.'],
] as const)(
	'speaks only the groups it searched and names the one it could not, in %s',
	async (locale, said) => {
		vi.useFakeTimers();
		try {
			const list = searchTransit({ surface: 'list', query: 'van' }, { routes, stops: null });
			const url = new URL('https://transit.local/');
			const view = render(HeaderSearch, {
				props: { locale, providerId: 'stm', url, scope: 'all', list, query: 'van' },
			});
			await vi.advanceTimersByTimeAsync(500);
			expect(view.getByRole('status').textContent).toBe(said);
		} finally {
			vi.useRealTimers();
		}
	},
);

it('waits 500 ms after every edit, even when the totals stay the same', async () => {
	vi.useFakeTimers();
	try {
		const view = show('van');
		const status = view.getByRole('status');
		await vi.advanceTimersByTimeAsync(250);
		const list = searchTransit({ surface: 'list', query: 'va', scope: 'all' }, { routes, stops });
		await view.rerender({ query: 'va', list });
		await vi.advanceTimersByTimeAsync(250);
		expect(status.textContent).toBe('');
		await vi.advanceTimersByTimeAsync(250);
		expect(status.textContent).toBe('1 line, 38 stops');
	} finally {
		vi.useRealTimers();
	}
});

it('restarts the wait when an edit only adds or removes a trailing space', async () => {
	vi.useFakeTimers();
	try {
		const view = show('van');
		const status = view.getByRole('status');
		// Edits at 250 ms and 500 ms: each one restarts the 500 ms wait.
		for (const value of ['van ', 'van']) {
			await vi.advanceTimersByTimeAsync(250);
			expect(status.textContent).toBe('');
			await fireEvent.input(view.input, { target: { value } });
		}
		await vi.advanceTimersByTimeAsync(499);
		expect(status.textContent).toBe('');
		await vi.advanceTimersByTimeAsync(1);
		expect(status.textContent).toBe('1 line, 38 stops');
	} finally {
		vi.useRealTimers();
	}
});
