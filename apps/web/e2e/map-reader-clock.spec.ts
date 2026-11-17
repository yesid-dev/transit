import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { SURFACE_NAV } from '../src/lib/content/nav';
import { copy as mapCopy } from '../src/lib/features/map/map.copy';
import { PUBLISHED_LOCALES } from '../src/lib/i18n/config';
import { localizeHref } from '../src/lib/i18n/routing';

const fixture = (name: string) =>
	JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const map = SURFACE_NAV.find((item) => item.key === 'map')!.href;
// The fixture data server is a separate origin; its published snapshot is not a page resource.
test.use({ bypassCSP: true });
const GENERATED = '2026-06-15T12:00:00Z';
const FIRST_ETA = '2026-06-15T12:05:00Z';
const SECOND_ETA = '2026-06-15T12:10:00Z';
const publishedStop = fixture('stops-index.json').stops[0];
const publishedStopFile = fixture('stop.json');
const publishedDepartures = fixture('departures.json');
const publishedAlerts = fixture('alerts.json');
const providers = fixture('providers.json').providers as {
	id: string;
	fit_bounds: [number, number, number, number];
}[];

/**
 * Each provider keeps the published fixture stop, moved inside its own published fit bounds so
 * the real near-me search accepts the origin. The instant and the reader clock are unchanged.
 */
function networkFor(provider: 'stm' | 'octranspo') {
	const bounds = providers.find((row) => row.id === provider)?.fit_bounds;
	if (!bounds) throw new Error(`missing published bounds for ${provider}`);
	const [west, south, east, north] = bounds;
	const atBoundsCentre = provider !== 'stm';
	const lat = atBoundsCentre ? (south + north) / 2 : publishedStop.lat;
	const lon = atBoundsCentre ? (west + east) / 2 : publishedStop.lon;
	const stop = { ...publishedStop, lat, lon };
	return {
		stop,
		address: {
			lat,
			lon,
			label: 'Fixture address',
			source: 'geo_ca',
			precision: 'address',
		},
		stopsIndex: { ...fixture('stops-index.json'), stops: [stop] },
		stopFile: { ...publishedStopFile, lat, lon },
		departures: {
			...publishedDepartures,
			stops: {
				[stop.id]: [
					{ route: '80', trip: 'T1', eta_utc: FIRST_ETA, delay_min: 0 },
					{ route: '80', trip: 'T2', eta_utc: SECOND_ETA, delay_min: 2 },
				],
			},
		},
		trips: {
			...fixture('trips.json'),
			generated_utc: GENERATED,
			trips: {
				T1: {
					status: 'on_time',
					route: '80',
					delay_min: 0,
					stops: [{ stop: stop.id, eta_utc: FIRST_ETA, delay_min: 0 }],
				},
			},
		},
		vehicles: {
			generated_utc: GENERATED,
			vehicles: [
				{
					id: 'V1',
					lat,
					lon,
					status: 'on_time',
					delay_min: 0,
					route: '80',
					trip: 'T1',
					next_stop: stop.id,
					reported_utc: GENERATED,
					updated_utc: GENERATED,
				},
			],
		},
		alerts: publishedAlerts,
	};
}

async function serveNetwork(page: Page, provider: 'stm' | 'octranspo'): Promise<void> {
	const network = networkFor(provider);
	await page.route('**/api/geocode**', (route) =>
		route.fulfill({ json: { results: [network.address] } }),
	);
	await page.route('**/v1/*/static/stops_index.json', (route) =>
		route.fulfill({ json: network.stopsIndex }),
	);
	await page.route(`**/v1/*/static/stops/${network.stop.id}.json`, (route) =>
		route.fulfill({ json: network.stopFile }),
	);
	await page.route('**/v1/*/live/stop_departures.json', (route) =>
		route.fulfill({ json: network.departures }),
	);
	await page.route('**/v1/*/live/trips.json', (route) => route.fulfill({ json: network.trips }));
	await page.route('**/v1/*/live/vehicles.json', (route) =>
		route.fulfill({ json: network.vehicles }),
	);
	await page.route('**/v1/*/live/alerts.json', (route) => route.fulfill({ json: network.alerts }));
}

async function openNearMe(page: Page, name: string): Promise<void> {
	const toggle = page.getByRole('button', { name, exact: true });
	await expect(async () => {
		if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
		await expect(toggle).toHaveAttribute('aria-expanded', 'true', { timeout: 1_000 });
	}).toPass();
}

const clocks = {
	en: { first: '8:05 a.m.', second: '8:10 a.m.' },
	fr: { first: '8 h 05', second: '8 h 10' },
} as const;

const busNames = {
	en: 'Select vehicle V1, Line 80, 8:05 a.m., On-time, Delay: 0 min',
	fr: 'Sélectionner le véhicule V1, Ligne 80, 8 h 05, À l’heure, Retard: 0 min',
} as const;

for (const provider of ['stm', 'octranspo'] as const) {
	for (const locale of PUBLISHED_LOCALES) {
		test(`${provider} ${locale}: the reader clock shows the network time in departures and their vehicle name`, async ({
			page,
		}) => {
			await page.clock.install({ time: Date.parse(GENERATED) + 30_000 });
			await serveNetwork(page, provider);
			await page.goto(`${localizeHref(map, locale)}?provider=${provider}`);

			const network = networkFor(provider);
			const t = mapCopy[locale];
			await openNearMe(page, t.nearMe);
			await page
				.getByRole('searchbox', { name: t.nearMeSearchPlaceholder })
				.fill(network.address.label);
			const suggestion = page
				.getByRole('group', { name: t.nearMeSuggestions })
				.getByRole('button', { name: new RegExp(literal(network.address.label)) });
			await expect(suggestion).toBeVisible();
			// Real keyboard path: submit, then the suggestion, then the stop in the near list.
			await page.keyboard.press('Tab');
			await expect(page.getByRole('button', { name: t.nearMeSearchSubmit })).toBeFocused();
			await page.keyboard.press('Tab');
			await expect(suggestion).toBeFocused();
			await page.keyboard.press('Enter');
			await page
				.getByRole('button', { name: new RegExp(`^${literal(network.stop.name)}`) })
				.click();

			const detail = page
				.getByRole('complementary', { name: network.stop.name })
				.or(page.getByRole('dialog', { name: network.stop.name }));
			await expect(detail).toBeVisible();
			const clock = clocks[locale];
			await expect(detail.locator('.map-departures time')).toHaveText([clock.first, clock.second]);
			// The same instant in the row's accessible name, including its line and status.
			await expect(
				detail.getByRole('button', { name: busNames[locale], exact: true }),
			).toBeVisible();
		});
	}
}
