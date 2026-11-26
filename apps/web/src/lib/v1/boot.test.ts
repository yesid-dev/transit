import { describe, expect, it, vi } from 'vitest';
import readyProviders from '../../../e2e/providers.json';

import { bootProvider, resolveLabel } from './boot';
import { CityCatalogSchema, PublicCitySchema } from './schemas/providers';

const cities = CityCatalogSchema.parse({
	...readyProviders,
	providers: readyProviders.providers.map((provider) => ({
		...provider,
		timezone: 'America/Toronto',
		bounds: null,
		lines_without_live_data: [],
	})),
});
const loadCities = async () => cities;

it('parses old and new city metadata and rejects invalid name separators', () => {
	const city = cities.providers[0]!;
	const rule = { ends: '<>', languages: '~', language_order: ['en', 'fr'] };
	expect(PublicCitySchema.parse(city)).not.toHaveProperty('name_separators');
	expect(PublicCitySchema.parse({ ...city, name_separators: rule }).name_separators).toEqual(rule);
	for (const invalid of [
		{ ends: '' },
		{ languages: ' ' },
		{ languages: '<>' },
		{ language_order: ['en', 'en'] },
		{ language_order: ['en', 'es'] },
		{ language_order: ['en'] },
	]) {
		expect(
			PublicCitySchema.safeParse({ ...city, name_separators: { ...rule, ...invalid } }).success,
		).toBe(false);
	}
});
it('keeps the optional complete service date in the public city catalog', () => {
	const [first, second] = cities.providers;
	const parsed = CityCatalogSchema.parse({
		...cities,
		providers: [
			{ ...first, record_through: '2026-11-23' },
			{ ...second, record_through: null },
		],
	});
	expect(parsed.providers.map(({ record_through }) => record_through)).toEqual([
		'2026-11-23',
		null,
	]);
	expect(first).not.toHaveProperty('record_through');
	expect(PublicCitySchema.safeParse({ ...first, record_through: '2026-11-31' }).success).toBe(
		false,
	);
});

const unavailable = async () => {
	throw new Error('catalog unavailable');
};

describe('boot provider from the public catalog', () => {
	it.each([
		['/lines/7?tab=reliability', '/lines/7?tab=reliability&provider=octranspo'],
		['/stop/3009', '/stop/3009?provider=octranspo'],
		['/trip/trip-123', '/trip/trip-123?provider=octranspo'],
		['/search?q=7', '/search?q=7&provider=octranspo'],
		['/hotspots?grain=month', '/hotspots?grain=month&provider=octranspo'],
		['/fr/search?q=7', '/fr/search?q=7&provider=octranspo'],
		[
			'/fr/lines/7/?tab=reliability&date=2026-11-10&mode=bus&tag=a&tag=b',
			'/fr/lines/7/?tab=reliability&date=2026-11-10&mode=bus&tag=a&tag=b&provider=octranspo',
		],
	])(
		'keeps the requested page and query when normalizing an Ottawa arrival: %s',
		async (path, expected) => {
			const url = new URL(path, 'https://transit.test');
			const result = await bootProvider(
				url,

				loadCities,

				{
					lat: 45.42,
					lon: -75.7,
				},
			);
			expect(result.redirectHref).toBe(expected);
			expect(url.pathname + url.search).toBe(path);
		},
	);

	it.each([
		['/lines/7?tab=reliability', { lat: 45.5, lon: -73.6 }],
		['/lines/7?tab=reliability', null],
		['/lines/7?tab=reliability&provider=octranspo', { lat: 45.5, lon: -73.6 }],
		['/lines/7?tab=reliability&provider=stm', { lat: 45.42, lon: -75.7 }],
	] as const)(
		'does not redirect default, unavailable or explicit selections: %s',
		async (path, location) => {
			const result = await bootProvider(
				new URL(path, 'https://transit.test'),

				loadCities,

				location,
			);
			expect(result.redirectHref).toBeNull();
		},
	);

	it.each(['provider=unknown', 'provider=', 'provider=stm&provider=octranspo'])(
		'normalizes %s while keeping the path and other parameters',
		async (query) => {
			const result = await bootProvider(
				new URL(`https://transit.test/fr/lines/7?tab=reliability&${query}&q=7&tag=a&tag=b`),

				loadCities,

				{ lat: 45.42, lon: -75.7 },
			);
			expect(result.providerId).toBe('stm');
			expect(result.redirectHref).toBe('/fr/lines/7?tab=reliability&provider=stm&q=7&tag=a&tag=b');
		},
	);

	it('redirects an Ottawa arrival from the catalog', async () => {
		const result = await bootProvider(
			new URL('https://transit.test/fr/map'),

			loadCities,

			{ lat: 45.42, lon: -75.7 },
		);
		expect(result).toMatchObject({
			providerId: 'octranspo',
			redirectHref: '/fr/map?provider=octranspo',

			discoveryError: false,
		});
	});

	it('retains the local default city id if catalog discovery fails', async () => {
		const result = await bootProvider(new URL('https://transit.test/'), unavailable, {
			lat: 45.42,
			lon: -75.7,
		});
		expect(result).toMatchObject({
			providerId: 'stm',
			provider: null,
			discoveryError: true,
			redirectHref: null,
		});
	});

	it.each([503, 200])(
		'preserves an explicit nondefault selection when discovery is unavailable or corrupt (%s)',
		async (status) => {
			const fetch = vi.fn(async () => new Response('{}', { status }));
			const url = new URL('https://transit.test/fr/map?provider=octranspo');
			const result = await bootProvider(
				url,

				async () => {
					const response = await fetch();
					if (!response.ok) throw new Error('unavailable');
					return CityCatalogSchema.parse(await response.json());
				},
			);
			expect(result).toMatchObject({
				providerId: 'octranspo',

				discoveryError: true,
				redirectHref: null,
			});
			expect(url.search).toBe('?provider=octranspo');

			expect(fetch).toHaveBeenCalledExactlyOnceWith();
		},
	);
});

it('resolves labels only from the local label table', () => {
	const labels = { 'status.local': 'Local status', local: 'Unrelated' };
	expect(resolveLabel('status.local', labels)).toBe('Local status');
	expect(resolveLabel('local', labels)).toBe('local');
});
