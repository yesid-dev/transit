import { afterEach, expect, it, vi } from 'vitest';
import { captureAlerts, captureNetwork, captureVehicles } from '#lib/live/captureProjection.ts';
import { captureSnapshotSchema } from '#lib/live/captureSnapshot.ts';
import { ManifestSchema } from '#lib/v1/schemas/manifest.ts';
import { liveSummary, liveSummarySchema } from './liveSummary';
import { liveSummaryReader, summaryAlertCount, summaryLateLines } from './liveSummaryReader';
import { lateLines } from './overviewRecord';

const now = Date.now();
const stamp = new Date(now).toISOString();
const feed = (family: string) => ({
	family,
	captured_at: stamp,
	source_at: stamp,
	fresh_for_seconds: 60,
	source_lag_seconds: 0,
	read_failed: false,
});

// Delays in seconds: four lines, ties on the late count, one vehicle without a line.
const delays: [string | null, number | null][] = [
	['51', 420],
	['51', 600],
	['51', 0],
	['24', 900],
	['24', 380],
	['24', -30],
	['90', 1200],
	['90', 60],
	['105', 700],
	['105', 30],
	['7', null],
	[null, 800],
];

function capture(city: string, withAlerts = true) {
	return {
		version: 2,
		city,
		published_at: stamp,
		stable_vehicle_ids: true,
		feeds: {
			vehicles: feed('vehicle_positions'),
			trips: feed('trip_updates'),
			...(withAlerts ? { alerts: feed('alerts') } : {}),
		},
		vehicle_positions: delays.map(([route, delay], index) => ({
			id: `report-${index}`,
			vehicle_id: `4000${index}`,
			trip_id: `trip-${index}`,
			start_date: null,
			start_time: null,
			route_id: route,
			direction_id: 0,
			latitude: 45.5,
			longitude: -73.6,
			bearing: null,
			speed_mps: null,
			stop_id: null,
			stop_sequence: null,
			status: 2,
			occupancy: index % 3,
			occupancy_percentage: null,
			observed_at: stamp,
			delay,
		})),
		alerts: withAlerts
			? ['detour', 'elevator', 'snow'].map((id) => ({
					id,
					header: { fr: `Avis ${id}`, en: `Notice ${id}` },
					description: { fr: 'Texte long', en: 'Long text' },
					url: {},
					cause: null,
					effect: null,
					severity: null,
					routes: ['51'],
					stops: [],
					periods: [[stamp, null]],
				}))
			: null,
		scheduled_now: 14,
		non_responding: 2,
		cancelled_now: 1,
	};
}

const manifest = ManifestSchema.parse({
	provider: 'stm',
	display_name: 'STM',
	bbox: [],
	attribution: '',
	dataset_version: 'demo',
	labels: {},
	surfaces: [],
	files: { live: { generated_utc: stamp, ttl_s: 30 } },
});

afterEach(() => vi.unstubAllGlobals());

it('carries the same figures the full capture gives the card', () => {
	const snapshot = captureSnapshotSchema.parse(capture('stm'));
	const summary = liveSummary(snapshot, now);
	const vehicles = captureVehicles(snapshot, now).vehicles;
	const alerts = captureAlerts(snapshot, now);

	expect(summary.network).toEqual({
		...captureNetwork(snapshot, now),
		late_lines: lateLines(vehicles),
	});
	// Worked by hand: 51 and 24 have two late vehicles each, 90 and 105 one each; ties by id.
	expect(summary.network.late_lines).toEqual([
		{ id: '24', late: 2, total: 3 },
		{ id: '51', late: 2, total: 3 },
		{ id: '105', late: 1, total: 2 },
	]);
	expect(summary.network.vehicles_in_service).toBe(delays.length);
	expect(summary.alerts?.alert_count).toBe(3);
	expect(summaryAlertCount(summary.alerts)).toBe(alerts.alerts.length);
	expect(summary.alerts).toEqual({ ...alerts, alerts: [], alert_count: 3 });
	// What crosses the wire reads back unchanged in the browser.
	expect(liveSummarySchema.parse(JSON.parse(JSON.stringify(summary)))).toEqual(summary);
});

it('leaves the alerts out when the capture has no alerts feed', () => {
	const summary = liveSummary(captureSnapshotSchema.parse(capture('stm', false)), now);
	expect(summary.alerts).toBeNull();
	expect(summaryAlertCount(summary.alerts)).toBeUndefined();
	expect(summary.network.late_lines).toHaveLength(3);
});

it('asks the summary once per refresh for both families', async () => {
	const summary = liveSummary(captureSnapshotSchema.parse(capture('stm')), now);
	const request = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
		Response.json(summary),
	);
	vi.stubGlobal('fetch', request);
	const signal = new AbortController().signal;
	const onPollDelayMs = vi.fn();
	const context = { manifest, signal, onPollDelayMs, requestCache: 'no-cache' as const };

	const [network, alerts] = await Promise.all([
		liveSummaryReader.network(context),
		liveSummaryReader.alerts(context),
	]);

	expect(request).toHaveBeenCalledTimes(1);
	expect(request).toHaveBeenCalledWith('/api/live-summary?city=stm', {
		signal,
		cache: 'no-cache',
	});
	expect(onPollDelayMs).toHaveBeenCalledWith(30_000);
	expect(summaryLateLines(network)).toEqual(summary.network.late_lines);
	expect(network.status_dist).toEqual(summary.network.status_dist);
	expect(summaryAlertCount(alerts)).toBe(3);
});

it.each([
	['missing', () => Response.json({ state: 'unavailable' }, { status: 503 })],
	['from another city', () => Response.json({ version: 1, city: 'other' })],
])('works the same figures out of the full capture when the summary is %s', async (_, reply) => {
	const body = capture('stm');
	const request = vi.fn(async (url: RequestInfo | URL) =>
		String(url).startsWith('/api/live-summary?') ? reply() : Response.json(body),
	);
	vi.stubGlobal('fetch', request);
	const context = { manifest, signal: new AbortController().signal };

	const [network, alerts] = await Promise.all([
		liveSummaryReader.network(context),
		liveSummaryReader.alerts(context),
	]);

	const expected = liveSummary(captureSnapshotSchema.parse(body), now);
	expect(summaryLateLines(network)).toEqual(expected.network.late_lines);
	expect(network.vehicles_in_service).toBe(expected.network.vehicles_in_service);
	expect(summaryAlertCount(alerts)).toBe(3);
	// One full capture read serves both families, as the full reader does.
	expect(request.mock.calls.filter(([url]) => String(url).startsWith('/api/live?'))).toHaveLength(
		1,
	);
});

it('counts the notices in effect now once each, as Service alerts does live', async () => {
	const body = capture('stm');
	const later = new Date(now + 3_600_000).toISOString();
	const [detour] = body.alerts!;
	body.alerts!.push(
		// A reissue of the detour under another ID is the same notice.
		{ ...detour, id: 'detour-reissue' },
		// A notice that starts in an hour is not in effect now.
		{
			...detour,
			id: 'tomorrow',
			header: { fr: 'Plus tard', en: 'Later' },
			periods: [[later, null]],
		},
	);
	const summary = liveSummary(captureSnapshotSchema.parse(body), now);
	expect(summary.alerts?.alert_count).toBe(3);

	// The fallback reads the published alerts file and agrees.
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url: RequestInfo | URL) =>
			String(url).startsWith('/api/live-summary?')
				? Response.json({ state: 'unavailable' }, { status: 503 })
				: Response.json(body),
		),
	);
	const alerts = await liveSummaryReader.alerts({ manifest, signal: new AbortController().signal });
	expect(summaryAlertCount(alerts)).toBe(3);
});

it('reads the alerts as unavailable when the summary has none', async () => {
	const summary = liveSummary(captureSnapshotSchema.parse(capture('stm', false)), now);
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => Response.json(summary)),
	);
	await expect(
		liveSummaryReader.alerts({ manifest, signal: new AbortController().signal }),
	).rejects.toThrow('Alerts unavailable');
});
