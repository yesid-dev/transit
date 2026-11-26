import { fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { goto } from '$app/navigation';
import { searchTransit } from '#lib/search/transitSearch.ts';
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

function show(query: string, at = '/', locale: 'en' | 'fr' = 'en') {
	const list = searchTransit({ query }, { routes, stops, vehicles: [] });
	const url = new URL(at, 'https://transit.local');
	const view = render(HeaderSearch, {
		props: { locale, providerId: 'stm', url, list, query },
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
	const all = view.getByRole('option', { name: 'See all results' });
	expect(path(all.getAttribute('href'))).toBe('/search?q=van&kind=route');
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
	const view = show('18', '/lines/17?tab=reliability&grain=week');
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
	expect(options).toHaveLength(7);
	await fireEvent.keyDown(view.input, { key: 'ArrowUp' });
	expect(view.input).toHaveAttribute('aria-activedescendant', options[6]!.id);
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
		const view = show('van', '/', locale);
		const status = view.getByRole('status');
		expect(status).toHaveTextContent('');
		await vi.advanceTimersByTimeAsync(500);
		expect(status).toHaveTextContent(said);
	} finally {
		vi.useRealTimers();
	}
});

it.each([
	[
		'en',
		'Nothing found for “zzz” in lines, stops, vehicles, pages.',
		['Browse all lines', 'Browse all stops', 'Search addresses for “zzz”'],
		'',
	],
	[
		'fr',
		'Aucun résultat pour « zzz » dans les lignes, les arrêts, les véhicules, les pages.',
		[
			'Parcourir toutes les lignes',
			'Parcourir tous les arrêts',
			'Chercher des adresses pour « zzz »',
		],
		'/fr',
	],
] as const)(
	'offers the next steps when nothing matches in %s',
	(locale, message, steps, prefix) => {
		const view = show('zzz', '/', locale);
		expect(view.getByText(message)).toBeInTheDocument();
		const options = view.getAllByRole('option');
		expect(options.slice(0, 2).map((option) => path(option.getAttribute('href')))).toEqual([
			`${prefix}/lines`,
			`${prefix}/stops`,
		]);
		expect(options.slice(0, 2).map((option) => option.textContent?.trim())).toEqual(
			steps.slice(0, 2),
		);
		// The address request comes last, after the browse rows.
		expect(options).toHaveLength(3);
		expect(options[2]).toHaveAccessibleName(steps[2]);
	},
);

it('says nothing about matches while the indexes load', () => {
	const list = searchTransit({ query: 'zzz' }, { routes, stops: null });
	const view = render(HeaderSearch, {
		props: {
			locale: 'en',
			providerId: 'stm',
			url: new URL('https://transit.local/'),

			list: { ...list, indexSettled: false },
			query: 'zzz',
		},
	});
	expect(view.queryByRole('listbox')).toBeNull();
	expect(view.queryByText(/Nothing found/)).toBeNull();
	expect(view.getByText('Loading the search index…')).toBeVisible();
	expect(view.getByRole('combobox', { name: 'Search the network' })).toHaveAttribute(
		'aria-expanded',
		'false',
	);
});

it.each([
	['en', '1 line. The search index is temporarily unavailable.'],
	['fr', '1 ligne. L’index de recherche est temporairement indisponible.'],
] as const)(
	'speaks only the counts it has and says that the index is unavailable, in %s',
	async (locale, said) => {
		vi.useFakeTimers();
		try {
			const list = searchTransit({ query: 'van' }, { routes, stops: null });
			const url = new URL('https://transit.local/');
			const view = render(HeaderSearch, {
				props: { locale, providerId: 'stm', url, list, query: 'van' },
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
		const list = searchTransit({ query: 'va' }, { routes, stops });
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

const geocoded = (...labels: string[]) =>
	new Response(
		JSON.stringify({
			results: labels.map((label, i) => ({
				label,
				lat: 45 + i,
				lon: -73,
				source: 'geo_ca',
				precision: 'address',
			})),
		}),
	);

it('does not call the geocoder while typing', async () => {
	const request = vi.spyOn(globalThis, 'fetch');
	vi.useFakeTimers();
	try {
		const view = show('cas');
		for (const value of ['casg', 'casgrain'])
			await fireEvent.input(view.input, { target: { value } });
		await vi.advanceTimersByTimeAsync(2_000);
		expect(request).not.toHaveBeenCalled();
	} finally {
		vi.useRealTimers();
		request.mockRestore();
	}
});

it('calls it once when the address row is chosen, and that row carries the notice', async () => {
	const request = vi
		.spyOn(globalThis, 'fetch')
		.mockResolvedValue(geocoded('5333 Avenue Casgrain', 'Casgrain Street', 'Third'));
	try {
		const view = show('casgrain');
		const ask = view.getByRole('option', { name: 'Search addresses for “casgrain”' });
		expect(ask).toHaveAccessibleDescription(
			"Sends this text to our server and to the Government of Canada's Geo.ca service.",
		);
		await fireEvent.click(ask);
		const first = await view.findByRole('option', { name: 'Address 5333 Avenue Casgrain' });
		await waitFor(() => expect(first).toHaveAttribute('aria-selected', 'true'));
		expect(view.getAllByRole('option', { name: /^Address / })).toHaveLength(2);
		expect(view.queryByRole('option', { name: /^Search addresses/ })).toBeNull();
		expect(request).toHaveBeenCalledOnce();
		expect(String(request.mock.calls[0]![0])).toBe(
			'/api/geocode?provider=stm&lang=en&q=casgrain&suggest=1&limit=2',
		);
	} finally {
		request.mockRestore();
	}
});

it.each([
	['nothing is found', () => geocoded(), 'No address found for “casgrain”.'],
	[
		'the lookup fails',
		() => new Response('', { status: 503 }),
		'Address search is unavailable right now.',
	],
])('says so on the address row when %s', async (_, answer, said) => {
	const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer());
	try {
		const view = show('casgrain');
		await fireEvent.click(view.getByRole('option', { name: /^Search addresses/ }));
		expect(await view.findByRole('option', { name: said })).toHaveAttribute(
			'aria-disabled',
			'true',
		);
	} finally {
		request.mockRestore();
	}
});

it('carries no standing notice on the field', () => {
	const view = show('van');
	expect(view.input).not.toHaveAttribute('aria-describedby');
	expect(view.queryByText(/Your searches are sent/)).toBeNull();
});

it.each([
	['en', () => geocoded(), 'No address found for “casgrain”.'],
	['fr', () => geocoded(), 'Aucune adresse trouvée pour « casgrain ».'],
	['en', () => new Response('', { status: 503 }), 'Address search is unavailable right now.'],
] as const)(
	'speaks the address outcome after no transit match (%s)',
	async (locale, answer, said) => {
		const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer());
		try {
			const view = show('casgrain', '/', locale);
			await fireEvent.click(
				view.getByRole('option', { name: /^(Search addresses|Chercher des adresses)/ }),
			);
			await waitFor(() => expect(view.getByRole('status')).toHaveTextContent(said));
		} finally {
			request.mockRestore();
		}
	},
);
