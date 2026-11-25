import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { StopReliability, NetworkTrend } from '#lib/v1/index.ts';
import { isoUtc } from '#lib/v1/schemas/types.ts';
import type { ReliabilityWindow } from '#lib/v1/verdict.ts';
import StopReliabilitySurface from '../stops/reliability/sections/StopReliabilitySurface.svelte';

const harness = vi.hoisted(() => {
	const page = { url: new URL('http://localhost/lines/24'), state: {} };
	return {
		page,
		stop: null as StopReliability | null,
		network: null as NetworkTrend | null,
		mirrorSearchParams: vi.fn((values: Record<string, string | null>) => {
			const next = new URL(page.url);
			for (const [key, value] of Object.entries(values)) {
				if (value == null) next.searchParams.delete(key);
				else next.searchParams.set(key, value);
			}
			page.url = next;
		}),
	};
});
vi.mock('$app/state', () => ({ page: harness.page }));
vi.mock('#lib/site/urlMirror.ts', () => ({
	currentMirrorUrl: () => new URL(harness.page.url),
	mirrorSearchParams: harness.mirrorSearchParams,
	mirrorSearchParam: vi.fn(),
}));
vi.mock('#lib/v1/repositories/historic.ts', () => ({
	getStopReliability: async () => harness.stop,
	getHistoricAvailability: async () => ({
		families: [{ family: 'network', last_available_date: harness.network?.series?.at(-1)?.date }],
	}),
	getNetworkHistoryIndex: async () => null,
	loadNetworkHistoryRange: vi.fn(),
}));
vi.mock('#lib/v1/repositories/static.ts', () => ({
	getRoutesIndex: async () => ({
		generated_utc: '2026-11-02T00:00:00Z',
		routes: [{ id: '24', short: '24', type: 3 }],
	}),
	getRoute: async () => ({ id: '24', generated_utc: '2026-11-02T00:00:00Z', directions: [] }),
}));
vi.mock('#lib/v1/repositories/provenance.ts', () => ({
	getProvenance: async () => ({ conformance: null }),
}));
vi.mock('#lib/v1/boot.ts', () => ({
	getV1Context: () => ({
		manifest: {
			provider: 'stm',
			tz: 'America/Toronto',
			short_name: 'Test',
			display_name: 'Test',
			files: { live: { ttl_s: 30 } },
		},
		provider: {
			labels: { en: { operator: 'Test' }, fr: { operator: 'Test' } },
			inputs: { i3_alerts: true, service_alerts: true },
		},
		lang: 'en',
		labels: {},
	}),
}));
vi.mock('#lib/v1/live/store.svelte.ts', () => ({
	LIVE_FAMILIES: ['vehicles', 'trips', 'departures', 'alerts', 'network'],
	createLiveStore: () => ({
		vehicles: null,
		trips: null,
		alerts: null,
		network: null,
		departures: null,
		index: {
			vehiclesById: new Map(),
			vehiclesByRoute: new Map(),
			vehiclesByTrip: new Map(),
			stopsById: new Map(),
			tripsById: new Map(),
			alertsById: new Map(),
		},
		familyStates: Object.fromEntries(
			['vehicles', 'trips', 'departures', 'alerts', 'network'].map((family) => [
				family,
				{
					phase: 'idle',
					active: false,
					retainedGeneration: null,
					health: {
						state: 'never-loaded',
						ageSeconds: null,
						isStale: false,
						retained: false,
						notice: null,
					},
				},
			]),
		),
		loading: false,
		error: null,
		start: vi.fn(),
		stop: vi.fn(),
		setTripScope: vi.fn(),
		refresh: vi.fn(),
	}),
}));

beforeEach(() => vi.stubGlobal('IntersectionObserver', undefined));
afterEach(() => {
	vi.unstubAllGlobals();
	cleanup();
	harness.page.url = new URL('http://localhost/lines/24');
});

function publishedPoint(window: ReliabilityWindow) {
	return {
		date: window.date,
		otp_pct: window.otp_pct,
		observation_count: window.observation_count,
		wilson_lo: window.wilson_lo,
		wilson_hi: window.wilson_hi,
	};
}

function verdictOf(container: HTMLElement) {
	const verdict = container.querySelector('[data-slot="verdict"]');
	return {
		status: verdict?.getAttribute('data-status') ?? null,
		ban: container.querySelector('.verdict__ban')?.textContent ?? '',
		text: verdict?.textContent ?? '',
	};
}

it('Stop keeps explicit windows through grain changes and URL reloads', async () => {
	const generated_utc = isoUtc().parse('2026-11-02T00:00:00Z');
	const day = { date: '2026-11-02', grain: 'day', otp_pct: 20, observation_count: 12 };
	const week = {
		date: '2026-10-27',
		grain: 'week',
		otp_pct: 85,
		observation_count: 4000,
		on_time: 3400,
		wilson_lo: 84,
		wilson_hi: 86,
	};
	const month = { date: '2026-10-04', grain: 'month', otp_pct: 40, observation_count: 12 };
	harness.stop = {
		id: '24',
		generated_utc,
		periods: [day, week, month].map((window: ReliabilityWindow) => ({
			grain: window.grain,
			otp_pct: window.otp_pct,
			observation_count: window.observation_count,
			wilson_lo: window.wilson_lo,
			wilson_hi: window.wilson_hi,
		})),
	} as StopReliability;
	harness.network = {
		generated_utc,
		series: [day],
		weekly: [publishedPoint(week)],
		monthly: [month],
	} as NetworkTrend;
	harness.page.url = new URL('http://localhost/lines/24?grain=week');
	let view = render(StopReliabilitySurface, { props: { data: harness.stop!, locale: 'en' } });
	await waitFor(() => expect(verdictOf(view.container).status).toBe('reliable'));
	await fireEvent.click(view.getAllByRole('radio', { name: /month|30 days/i })[0]);
	await waitFor(() => expect(verdictOf(view.container).status).toBe('tentative'));
	expect(harness.page.url.searchParams.get('grain')).toBe('month');
	cleanup();
	view = render(StopReliabilitySurface, { props: { data: harness.stop!, locale: 'en' } });
	await waitFor(() => expect(verdictOf(view.container).status).toBe('tentative'));
	await fireEvent.click(
		view.getAllByRole('radio', {
			name: /^day|daily/i,
		})[0],
	);
	await waitFor(() => expect(verdictOf(view.container).status).toBe('tentative'));
	expect(verdictOf(view.container).text).toContain('12');
	expect(harness.page.url.searchParams.get('grain')).toBe('day');
	cleanup();
	view = render(StopReliabilitySurface, { props: { data: harness.stop!, locale: 'en' } });
	await waitFor(() => expect(verdictOf(view.container).status).toBe('tentative'));
	expect(verdictOf(view.container).text).toContain('12');
});
