import { expect, type Page } from '@playwright/test';
import { localizeHref } from '../src/lib/i18n/routing';
import silentTripLines from './health-silent-trip-lines.json' with { type: 'json' };

import type {
	CaptureFamily,
	CaptureSnapshot,
	CaptureTripReport,
} from '../src/lib/live/captureSnapshot';

export const captureUrl = /\/api\/live\?city=[a-z0-9_-]+$/;
export const liveTripsUrl = /\/api\/live-trips\?city=[a-z0-9_-]+&/;

export async function refreshAlertsCapture(page: Page) {
	await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
	await page.locator('#alerts-window, [data-record-state="no_live_data"]').first().waitFor();
	const response = page.waitForResponse((reply) => captureUrl.test(reply.url()));
	await page.clock.fastForward(21_000);
	return response;
}
type Vehicle = NonNullable<CaptureSnapshot['vehicle_positions']>[number];
type TripUpdate = CaptureTripReport['trip_updates'][number];
type Prediction = {
	stop: string;
	eta_utc: string;
	delay_min?: number | null;
	scheduled_utc?: string | null;
};

export function captureVehicle(at: number, overrides: Partial<Vehicle> = {}): Vehicle {
	return {
		id: 'report-40061',
		vehicle_id: '40061',
		route_id: '24',
		trip_id: 'T1',
		start_date: null,
		start_time: null,
		direction_id: 1,
		status: 1,
		delay: 240,
		stop_id: 'S1',
		stop_sequence: 1,
		occupancy: 2,
		occupancy_percentage: null,
		latitude: 45.5,
		longitude: -73.6,
		bearing: null,
		speed_mps: null,
		observed_at: new Date(at).toISOString(),
		...overrides,
	};
}

export function captureTrip(
	id: string,
	route: string | null,
	stops: readonly Prediction[],
	delay: number | null = null,
): TripUpdate {
	return {
		trip_id: id,
		route_id: route,
		direction_id: null,
		start_date: null,
		start_time: null,
		relationship: 0,
		delay,
		stops: stops.map(({ stop, eta_utc, delay_min, scheduled_utc }, i) => ({
			stop_id: stop,
			sequence: i + 1,
			arrival: null,
			departure: Math.floor(Date.parse(eta_utc) / 1_000),
			...(scheduled_utc !== undefined && {
				scheduled_departure:
					scheduled_utc === null ? null : Math.floor(Date.parse(scheduled_utc) / 1_000),
			}),
			arrival_delay: null,
			departure_delay: delay_min == null ? null : delay_min * 60,
			relationship: 0,
		})),
	};
}

export function captureTripReport(
	city: string,
	timestamp: string,
	trip_updates: TripUpdate[],
): CaptureTripReport {
	return {
		version: 2,
		city,
		feed: {
			family: 'trip_updates',
			fresh_for_seconds: 90,
			captured_at: timestamp,
			source_at: timestamp,
			source_lag_seconds: 0,
			read_failed: false,
		},
		trip_updates,
	};
}

export async function installStopCapture(page: Page, city: string, stop: string, at: number) {
	await page.clock.install({ time: at });
	await page.route(captureUrl, async (route) => {
		const current = await page.evaluate(() => Date.now());
		await route.fulfill({ json: captureFixture(current, { city }) });
	});
	await page.route(`**/api/live-trips?city=${city}&stop=${stop}`, async (route) => {
		const current = await page.evaluate(() => Date.now());
		const calls = [5, 9, 17, 19, 20, 21].map((minutes, index) => ({
			...captureTrip(`stop-trip-${index}`, index % 2 ? '80' : '24', [
				{
					stop,
					eta_utc: new Date(current + minutes * 60_000).toISOString(),
					delay_min: [0, 6, 4, -2, 5, null][index],
					scheduled_utc:
						index === 0 ? new Date(at + 180_000).toISOString() : index === 1 ? null : undefined,
				},
			]),
			...(index === 0
				? { trip_headsign: 'Gare Montréal-Ouest', direction_id: 0, start_time: '08:00:00' }
				: index === 1
					? { trip_headsign: null }
					: {}),
		}));
		await route.fulfill({ json: captureTripReport(city, new Date(current).toISOString(), calls) });
	});
	return async () => {
		await expect(page.locator('html')).toHaveAttribute('data-hydrated', '');
		const capture = page.waitForResponse((response) => captureUrl.test(response.url()));
		await page.clock.fastForward(21_000);
		await capture;
	};
}

export function captureFleet(at: number, city: string, delays: readonly (number | null)[]) {
	return captureFixture(at, {
		city,
		vehicle_positions: delays.map((delay, i) =>
			captureVehicle(at, { id: `report-${i}`, vehicle_id: `fixture-${i}`, delay }),
		),
	});
}

export async function installHealthCapture(page: Page, { namedTrips = false } = {}) {
	await page.clock.install();
	await page.route(captureUrl, async (route) => {
		const at = await page.evaluate(() => Date.now());
		const delays = Array.from({ length: 364 }, (_, index) =>
			index < 20 ? -120 : index < 297 ? 0 : index < 351 ? 480 : null,
		);
		const snapshot = captureFleet(at, 'stm', delays);
		Object.assign(snapshot.feeds.vehicle_positions!, { expected_every_seconds: 30, bytes: 412000 });
		Object.assign(snapshot.feeds.trip_updates!, { expected_every_seconds: 30, bytes: 1900000 });
		const alerts = snapshot.feeds.i3_alerts!;
		alerts.captured_at = alerts.source_at = new Date(at - 120_000).toISOString();
		alerts.fresh_for_seconds = 60;
		Object.assign(alerts, { expected_every_seconds: 60, bytes: 12000 });
		const scheduleAt = new Date(at - 3 * 86_400_000).toISOString();
		await route.fulfill({
			json: {
				...snapshot,
				scheduled_now: 1306,
				non_responding: 44,
				cancelled_now: 8,
				schedule: {
					captured_at: scheduleAt,
					effective_date: scheduleAt.slice(0, 10),
					bytes: 64000000,
				},
				silent_trips: Array.from({ length: 12 }, (_, index) => {
					const example = namedTrips ? silentTripLines[index] : undefined;
					return {
						trip_id: `silent-${index}`,
						route_id:
							example?.line ?? (index === 0 ? '24' : index === 1 ? '99999' : String(24 + index)),
						direction_id: example?.direction ?? (index === 1 ? null : 0),
						departure: { service_seconds: 27000 + index * 60, local_time: `07:${30 + index}` },
						silent_since: null,
						silent_for_seconds: 2400 - index * 60 + 12,
					};
				}),
			},
		});
	});
	return async () => {
		await expect(page.locator('html[data-hydrated]')).toBeAttached();
		await expect(
			page.locator('[data-slot="screen-answer"] [data-slot="answer-lead"]'),
		).toBeVisible();
		const refreshed = page.waitForResponse((response) => captureUrl.test(response.url()));
		await page.clock.fastForward(21_000);
		await refreshed;
	};
}

export async function openNetworkCapture(
	page: Page,
	locale: 'en' | 'fr',
	delays: readonly (number | null)[],
) {
	const at = Date.parse('2026-11-22T12:00:00Z');
	let fleet = delays;
	await page.clock.install({ time: at });
	await page.route(captureUrl, async (route) => {
		const capturedAt = await page.evaluate(() => Date.now());
		await route.fulfill({ json: captureFleet(capturedAt, 'stm', fleet) });
	});
	await page.goto(localizeHref('/network?frameMode=live', locale, 'stm'));
	await expect(page.locator('html[data-hydrated]')).toBeAttached();
	const answer = page.locator('[data-slot="screen-answer"] [data-slot="answer-lead"]');
	await expect(answer).toBeVisible();
	const refresh = async (nextFleet: readonly (number | null)[]) => {
		fleet = nextFleet;
		const refreshed = page.waitForResponse((response) => captureUrl.test(response.url()));
		await page.clock.fastForward(21_000);
		await refreshed;
		await expect(answer.locator('.answer-value')).toHaveText(String(fleet.length));
	};
	await refresh(delays);
	return refresh;
}

export function layoutCapture(city: string, overrides: Partial<Vehicle> = {}) {
	const at = Date.parse('2026-06-15T12:00:00Z');
	return captureFixture(at, {
		city,
		vehicle_positions: [
			captureVehicle(at, {
				vehicle_id: 'layout-bus',
				latitude: city === 'stm' ? 45.51 : 45.41,
				longitude: city === 'stm' ? -73.59 : -75.69,
				delay: 0,
				bearing: 90,
				speed_mps: 40 / 3.6,
				occupancy: 1,
				...overrides,
			}),
		],
	});
}

export function captureFixture(
	at: number,
	options: Partial<
		Pick<CaptureSnapshot, 'city' | 'vehicle_positions' | 'alerts' | 'non_responding_by_route'>
	> = {},
): CaptureSnapshot {
	const timestamp = new Date(at).toISOString();
	const feed = (family: CaptureFamily, fresh_for_seconds: number) => ({
		family,
		fresh_for_seconds,
		captured_at: timestamp,
		source_at: timestamp,
		source_lag_seconds: 0,
		read_failed: false,
	});
	return {
		version: 2,
		city: 'stm',
		published_at: timestamp,
		stable_vehicle_ids: true,
		feeds: {
			vehicle_positions: feed('vehicle_positions', 60),
			trip_updates: feed('trip_updates', 90),
			i3_alerts: feed('alerts', 900),
		},
		vehicle_positions: [],
		alerts: [],
		...options,
	};
}
