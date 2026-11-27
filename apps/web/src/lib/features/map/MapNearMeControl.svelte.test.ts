import { fireEvent, render } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import type { GeocodeSuggestion } from '#lib/geocode/types.ts';
import MapNearMeControl from './MapNearMeControl.svelte';
import MapNearbyStops from './MapNearbyStops.svelte';
import { copy } from './map.copy';

vi.mock('#lib/v1/boot', () => ({ getV1Context: () => ({ manifest: { provider: 'stm' } }) }));

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

const handlers = () => ({
	loading: false,
	error: null,
	onsearch: vi.fn(),
	onsuggestion: vi.fn(),
});

it('debounces, caches and selects suggestions with arrow keys and Enter', async () => {
	vi.useFakeTimers();
	const results: GeocodeSuggestion[] = [
		{ label: '123 Sherbrooke', lat: 45.5, lon: -73.6, source: 'geo_ca', precision: 'address' },
		{ label: '125 Sherbrooke', lat: 45.51, lon: -73.61, source: 'geo_ca', precision: 'address' },
	];
	const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results }) });
	vi.stubGlobal('fetch', fetch);
	const props = { locale: 'en' as const, copy: copy.en, ...handlers() };
	const { getByRole, getAllByRole, queryByRole } = render(MapNearMeControl, { props });
	const input = getByRole('combobox', { name: copy.en.nearMeAddressLabel });

	await fireEvent.input(input, { target: { value: results[0].label } });
	expect(fetch).not.toHaveBeenCalled();
	await vi.advanceTimersByTimeAsync(251);
	await tick();
	expect(fetch).toHaveBeenCalledTimes(1);
	const url = new URL(fetch.mock.calls[0][0], 'https://example.test');
	expect(url.searchParams.get('suggest')).toBe('1');
	expect(url.searchParams.get('limit')).toBe('4');
	expect(getAllByRole('option')).toHaveLength(results.length);
	await fireEvent.keyDown(input, { key: 'Escape' });
	expect(queryByRole('listbox')).not.toBeInTheDocument();

	await fireEvent.input(input, { target: { value: '' } });
	await fireEvent.input(input, { target: { value: results[0].label } });
	await vi.advanceTimersByTimeAsync(251);
	expect(fetch).toHaveBeenCalledTimes(1);
	await fireEvent.keyDown(input, { key: 'ArrowDown' });
	await fireEvent.keyDown(input, { key: 'ArrowDown' });
	expect(getByRole('option', { name: /125 Sherbrooke/ })).toHaveAttribute('aria-selected', 'true');
	await fireEvent.keyDown(input, { key: 'Enter' });
	expect(props.onsuggestion).toHaveBeenCalledExactlyOnceWith(results[1]);
	expect(queryByRole('listbox')).not.toBeInTheDocument();
});

it.each(['en', 'fr'] as const)(
	'describes the %s lookup and explains an unmatched place',
	(locale) => {
		const t = copy[locale];
		const { getByRole, getByText } = render(MapNearMeControl, {
			props: { locale, copy: t, ...handlers(), query: 'Sherbrooke', error: t.nearMeError },
		});
		expect(getByText(t.nearMeCollectionNotice)).toBeVisible();
		expect(getByRole('combobox', { name: t.nearMeAddressLabel })).toHaveAccessibleDescription(
			t.nearMeCollectionNotice,
		);
		expect(getByRole('status')).toHaveTextContent(
			t.nearMeNotFound('Sherbrooke').replaceAll('\u00a0', ' '),
		);
	},
);

it.each([
	['en', '1.4 km'],
	['fr', '1,4\u00a0km'],
] as const)('keeps full stop names and formats nearby distances in %s', (locale, distance) => {
	const name = 'Boulevard Saint-Laurent et Avenue du Mont-Royal';
	const { container, getByRole } = render(MapNearbyStops, {
		props: {
			locale,
			city: 'stm',
			copy: copy[locale],
			heading: 'Nearby stops',
			details: new Map([['S1', 'North']]),
			onselect: vi.fn(),
			onclear: vi.fn(),
			stops: [{ id: 'S1', code: '1001', name, lat: 45.5, lon: -73.6, distanceM: 1400 }],
		},
	});
	expect(getByRole('link', { name })).toHaveAttribute('title', name);
	expect(container.querySelector('[data-map-row-value]')?.textContent).toBe(distance);
	expect(container.querySelector('[data-map-row-code]')).toHaveTextContent('1001');
	expect(container.querySelector('small')).toHaveTextContent('North');
});
