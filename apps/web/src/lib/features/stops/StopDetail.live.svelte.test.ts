import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { createSubscriber } from 'svelte/reactivity';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureV1Runtime } from '#lib/v1/runtime.ts';
import { createLineDirectory } from '#lib/site/lineDirectory.ts';
import StopDetail from './StopDetail.svelte';

const fixture = vi.hoisted(() => ({
	now: Date.parse('2026-06-15T12:00:00Z'),
	epoch: 0,
	page: { url: new URL('http://localhost/stop/probe'), state: {} },
	visible: 'visible' as DocumentVisibilityState,
	online: true,
	stopDepartures: vi.fn(),
	alerts: vi.fn(),
	network: vi.fn(),
	vehicles: vi.fn(),
	trips: vi.fn(),
	stop: vi.fn(),
	reliability: vi.fn(),
	historyIndex: vi.fn(),
	historyRange: vi.fn(),
}));
vi.mock('$app/env', () => ({ browser: true }));
vi.mock('$app/state', () => ({ page: fixture.page }));
vi.mock('$app/navigation', () => ({
	afterNavigate: () => {},
	replaceState: (url: string | URL) => {
		fixture.page.url = new URL(url, 'http://localhost');
	},
}));
vi.mock('#lib/v1/boot.ts', () => ({
	getV1Context: () => ({
		manifest: {
			provider: 'stm',
			short_name: 'STM',
			display_name: 'STM',
			files: { live: { ttl_s: 30 } },
		},
	}),
}));
vi.mock('#lib/v1/live/store.svelte.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/v1/live/store.svelte.ts')>();
	const { createMemoryLiveReader } = await import('#lib/v1/live/__fixtures__/reader.ts');
	const reader = createMemoryLiveReader();
	Object.assign(fixture, reader);
	return {
		...actual,
		createLiveStore: (
			manifest: Parameters<typeof actual.createLiveStore>[0],
			_reader: Parameters<typeof actual.createLiveStore>[1],
			options: Parameters<typeof actual.createLiveStore>[2],
		) => actual.createLiveStore(manifest, reader, options),
	};
});
vi.mock('#lib/v1/repositories/static.ts', () => ({ getStop: fixture.stop }));
vi.mock('#lib/v1/repositories/historic.ts', () => ({
	getStopReliability: fixture.reliability,
	getPublishedReliabilityIndex: async () => null,
	getStopHistoryIndex: fixture.historyIndex,
	loadStopHistoryRange: fixture.historyRange,
}));
vi.mock('@yesid/ui/state', async (importOriginal) => ({
	...(await importOriginal<typeof import('@yesid/ui/state')>()),
	clock: {
		subscribe: () => () => {},
		get serverNow() {
			return fixture.now;
		},
	},
}));

const base = Date.parse('2026-06-15T12:00:00Z');
const stamp = (offset = 0) => new Date(base + offset * 1000).toISOString();
const staticStop = {
	generated_utc: stamp(-86400),
	id: 'probe',
	name: 'Test stop',
	lat: 45.5,
	lon: -73.6,
	routes_served: ['24'],
	scheduled: [],
};
const departures = (offset = 0) => ({
	generated_utc: stamp(offset),
	stops: {
		probe: [
			{ route: '24', trip: 't1', eta_utc: stamp(300), delay_min: 0 },
			{ route: '24', trip: 't2', eta_utc: stamp(600), delay_min: null },
		],
	},
});
const alerts = (offset = 0) => ({
	generated_utc: stamp(offset),
	alerts: [
		{
			id: 'direct',
			severity: 'watch',
			header_key: 'Stop warning',
			header_text: 'Stop warning',
			header_text_en: 'Stop warning',
			stops: ['probe'],
		},
	],
});
let tick = () => {};
let refresh = () => {};
const subscribeClock = createSubscriber((update) => {
	tick = update;
});
const subscribeRefresh = createSubscriber((update) => {
	refresh = update;
});
let restoreRuntime: () => void;
async function settle() {
	for (let i = 0; i < 12; i += 1) await Promise.resolve();
	flushSync();
}
async function advance(seconds: number) {
	fixture.now += seconds * 1000;
	tick();
	await vi.advanceTimersByTimeAsync(seconds * 1000);
	await settle();
}
async function manualRefresh() {
	fixture.epoch += 1;
	refresh();
	flushSync();
	await settle();
}
// Line 1 is a metro line (GTFS type 1), which STM declares without live data.
const directory = createLineDirectory(
	[
		{ id: '1', short: '1', type: 1 },
		{ id: '24', short: '24', type: 3 },
	],
	{ line: (id) => `Line ${id}` },
);
function mount(locale: 'en' | 'fr' = 'en') {
	return render(StopDetail, {
		props: { id: 'probe', seed: { id: 'probe', name: 'Test stop' } },
		context: new Map<symbol, unknown>([
			[Symbol.for('@yesid/ui/locale'), () => locale],
			[Symbol.for('transit.line-directory'), () => directory],
		]),
	});
}
const liveState = () => screen.queryByTestId('stop-live-state');
const reportStamp = (family: string) =>
	document.querySelector(`.stop-report[data-source="${family}"] [data-slot="freshness-stamp"]`);

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(base - 300000);
	fixture.now = base;
	fixture.epoch = 0;
	fixture.page.url = new URL('http://localhost/stop/probe?tab=detail');
	fixture.visible = 'visible';
	fixture.online = true;
	Object.defineProperty(document, 'visibilityState', {
		configurable: true,
		get: () => fixture.visible,
	});
	Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => fixture.online });
	for (const method of [
		fixture.stopDepartures,
		fixture.alerts,
		fixture.network,
		fixture.vehicles,
		fixture.trips,
		fixture.stop,
		fixture.reliability,
		fixture.historyIndex,
		fixture.historyRange,
	])
		method.mockReset();
	fixture.stopDepartures.mockResolvedValue(departures());
	fixture.alerts.mockResolvedValue(alerts());
	fixture.stop.mockResolvedValue(staticStop);
	fixture.reliability.mockResolvedValue(null);
	fixture.historyIndex.mockResolvedValue(null);
	restoreRuntime = configureV1Runtime({
		clock: {
			get serverNow() {
				subscribeClock();
				return fixture.now;
			},
			noteServerEpochMs: () => {},
			subscribe: () => () => {},
		},
		refresh: {
			get epoch() {
				subscribeRefresh();
				return fixture.epoch;
			},
		},
	});
});
afterEach(() => {
	cleanup();
	restoreRuntime();
	vi.useRealTimers();
});

describe('StopDetail independent report owners', () => {
	it('keeps fresh departures independent of stale alerts and omits static time from the Detail header', async () => {
		fixture.alerts.mockResolvedValue(alerts(-600));
		mount();
		await settle();
		expect(reportStamp('departures')).toHaveAttribute('data-stale', 'false');
		expect(reportStamp('departures')).toHaveAttribute('data-age-seconds', '0');
		expect(reportStamp('alerts')).toHaveAttribute('data-stale', 'true');
		expect(reportStamp('alerts')).toHaveAttribute('data-age-seconds', '600');
		expect(document.querySelector('[data-slot="article-header"] time')).toBeNull();
		expect(fixture.network).not.toHaveBeenCalled();
		expect(fixture.vehicles).not.toHaveBeenCalled();
		expect(fixture.trips).not.toHaveBeenCalled();
	});

	it('shows cold departure error/retry without borrowing the successful alert timestamp', async () => {
		fixture.stopDepartures.mockRejectedValue(new Error('departures unavailable'));
		mount();
		await settle();
		expect(reportStamp('departures')).toBeNull();
		expect(reportStamp('alerts')).toHaveAttribute('data-stale', 'false');
		const board = screen
			.getByRole('heading', { name: /Predictions at this stop/ })
			.closest('[data-slot="card"]')!;
		// The way out survives a failed first report.
		expect(
			within(board as HTMLElement).getByRole('link', { name: 'See the record' }),
		).toHaveAttribute('href', '/stop/probe');
		expect(
			within(board as HTMLElement).getByRole('link', { name: 'See the schedule' }),
		).toHaveAttribute('href', '/stop/probe?tab=schedule');
		fixture.stopDepartures.mockResolvedValue(departures());
		await fireEvent.click(within(board as HTMLElement).getByRole('button', { name: /retry/i }));
		await settle();
		expect(reportStamp('departures')).toHaveAttribute('data-stale', 'false');
		expect(within(board as HTMLElement).getByRole('table', { name: /24/ })).toBeInTheDocument();
	});

	it('retains a failed departure report, ages it at3×TTL, and accepts a new generation', async () => {
		fixture.alerts.mockImplementation(async () => alerts((fixture.now - base) / 1000));
		mount();
		await settle();
		fixture.stopDepartures.mockRejectedValue(new Error('controlled departure failure'));
		await advance(30);
		expect(reportStamp('departures')).toHaveAttribute('data-degraded', 'true');
		expect(reportStamp('departures')).toHaveAttribute('data-stale', 'false');
		expect(screen.getByTestId('stop-departures-notice')).toHaveTextContent('Refresh unavailable');
		await advance(60);
		expect(reportStamp('departures')).toHaveAttribute('data-stale', 'true');
		expect(reportStamp('alerts')).toHaveAttribute('data-stale', 'false');
		fixture.stopDepartures.mockResolvedValue(departures(90));
		await manualRefresh();
		expect(reportStamp('departures')).not.toHaveAttribute('data-degraded');
		expect(reportStamp('departures')).toHaveAttribute('data-stale', 'false');
		expect(screen.queryByTestId('stop-departures-notice')).toBeNull();
	});

	it('keeps direct alerts visible when static information fails and retries alerts independently', async () => {
		fixture.stop.mockRejectedValue(new Error('static information unavailable'));
		mount();
		await settle();
		expect(screen.getByText('Stop warning')).toBeInTheDocument();
		expect(
			screen.getByText(/Only alerts targeting this stop ID directly are shown/),
		).toBeInTheDocument();
		fixture.alerts.mockRejectedValue(new Error('alerts unavailable'));
		await advance(30);
		expect(screen.getByTestId('stop-alerts-notice')).toHaveTextContent('Refresh unavailable');
		expect(screen.getByText('Stop warning')).toBeInTheDocument();
		expect(reportStamp('departures')).not.toHaveAttribute('data-degraded');
	});

	it.each(['en', 'fr'] as const)(
		'keeps loaded-empty schedule scope and retained failure visible in %s',
		async (locale) => {
			mount(locale);
			await settle();
			await fireEvent.click(
				screen.getByRole('tab', { name: locale === 'fr' ? 'Horaire' : 'Schedule' }),
			);
			await settle();
			expect(screen.getByTestId('stop-schedule-empty')).toHaveTextContent(
				locale === 'fr' ? 'Aucun exemple d’horaire publié' : 'No sample schedule published',
			);
			expect(
				screen.getByText(
					locale === 'fr'
						? /Heures sélectionnées dans un horaire représentatif/
						: /Selected times from a representative weekday/,
				),
			).toBeInTheDocument();
			fixture.stop.mockRejectedValue(new Error('static refresh failed'));
			await manualRefresh();
			expect(
				within(document.querySelector('.stop-schedule') as HTMLElement).getByText(
					locale === 'fr'
						? 'Informations de l’arrêt non actualisées'
						: 'Stop information could not refresh',
				),
			).toBeInTheDocument();
			expect(screen.getByTestId('stop-schedule-empty')).toBeInTheDocument();
		},
	);

	it.each(['en', 'fr'] as const)(
		'says an out-of-date empty report cannot tell whether predictions exist (%s)',
		async (locale) => {
			fixture.stopDepartures.mockResolvedValue({ generated_utc: stamp(-600), stops: {} });
			mount(locale);
			await settle();
			expect(reportStamp('departures')).toHaveAttribute('data-stale', 'true');
			expect(liveState()).toHaveTextContent(
				locale === 'en'
					? 'The last report received is out of date, so it cannot say whether predictions exist now.'
					: 'Le dernier rapport reçu n’est plus à jour : il ne peut pas dire s’il y a des prévisions maintenant.',
			);
		},
	);

	it('a fresh empty report says only that none were reported', async () => {
		fixture.stopDepartures.mockResolvedValue({ generated_utc: stamp(), stops: {} });
		mount();
		await settle();
		expect(liveState()).toHaveTextContent(
			'No predictions reported for this stop in the current report. This does not mean no vehicle is coming.',
		);
	});

	it('a stop served only by lines without live data states that, with no live stamp or refresh', async () => {
		fixture.stop.mockResolvedValue({ ...staticStop, routes_served: ['1'] });
		fixture.stopDepartures.mockResolvedValue({ generated_utc: stamp(), stops: {} });
		mount('fr');
		await settle();
		expect(liveState()).toHaveTextContent('Aucune donnée en direct pour les lignes de cet arrêt');
		expect(liveState()).toHaveTextContent(
			'Transit ne reçoit aucune prévision pour les lignes qui desservent cet arrêt.',
		);
		expect(reportStamp('departures')).toBeNull();
		expect(screen.queryByRole('button', { name: 'Actualiser' })).toBeNull();
		expect(screen.getByRole('link', { name: 'Voir l’horaire' })).toBeInTheDocument();
	});

	it('keeps a retained list on screen after a failed refresh, with its notice', async () => {
		mount();
		await settle();
		fixture.stopDepartures.mockRejectedValue(new Error('controlled departure failure'));
		await advance(30);
		expect(screen.getByTestId('stop-departures-notice')).toHaveTextContent('Refresh unavailable');
		expect(screen.getByRole('table', { name: /24/ })).toBeInTheDocument();
		expect(liveState()).toBeNull();
	});

	it('does not borrow live time for an unavailable historic report', async () => {
		fixture.page.url = new URL('http://localhost/stop/probe?tab=reliability');
		mount();
		await settle();
		expect(document.querySelector('[data-slot="article-header"] time')).toBeNull();
		expect(reportStamp('historic')).toBeNull();
	});

	it('polls only live reports across tabs, refreshes static/historic through the epoch, and stops both stores', async () => {
		const view = mount();
		await settle();
		await fireEvent.click(screen.getByRole('tab', { name: 'Schedule' }));
		await advance(60);
		expect(fixture.stopDepartures).toHaveBeenCalledTimes(3);
		expect(fixture.alerts).toHaveBeenCalledTimes(3);
		expect(fixture.stop).toHaveBeenCalledTimes(1);
		expect(fixture.reliability).toHaveBeenCalledTimes(1);
		await manualRefresh();
		expect(fixture.stop).toHaveBeenCalledTimes(2);
		expect(fixture.reliability).toHaveBeenCalledTimes(2);
		// The unchanged, minute-old report receives one bounded cache-bypassing retry.
		expect(fixture.stopDepartures).toHaveBeenCalledTimes(5);
		expect(fixture.alerts).toHaveBeenCalledTimes(5);
		fixture.visible = 'hidden';
		document.dispatchEvent(new Event('visibilitychange'));
		await advance(60);
		expect(fixture.stopDepartures).toHaveBeenCalledTimes(5);
		expect(fixture.alerts).toHaveBeenCalledTimes(5);
		fixture.visible = 'visible';
		document.dispatchEvent(new Event('visibilitychange'));
		await settle();
		expect(fixture.stopDepartures).toHaveBeenCalledTimes(6);
		expect(fixture.alerts).toHaveBeenCalledTimes(6);
		view.unmount();
		await advance(90);
		expect(fixture.stopDepartures).toHaveBeenCalledTimes(6);
		expect(fixture.alerts).toHaveBeenCalledTimes(6);
	});
});
