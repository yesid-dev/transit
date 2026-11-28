import { liveReader } from '#lib/v1/adapter/index.ts';
import { captureAlertOf, liveNoticeCount } from '../alerts/alertCards.ts';
import { providerOf } from '#lib/v1/adapter/r2.core.ts';
import { DEFAULT_LIVE_TTL_S } from '#lib/v1/freshness.ts';
import { livePollDelayMs } from '#lib/v1/live/polling.ts';
import type { LiveReadContext, LiveReader } from '#lib/v1/live/store.svelte.ts';
import { liveSummarySchema, type LateLine, type LiveSummary } from './liveSummary.ts';
import { lateLines } from './overviewRecord.ts';

// One summary per poll: the store asks each family with the same abort signal.
const byPoll = new WeakMap<AbortSignal, Promise<LiveSummary>>();

async function fetchSummary(context: LiveReadContext): Promise<LiveSummary> {
	const city = providerOf({ manifest: context.manifest });
	const response = await fetch(`/api/live-summary?${new URLSearchParams({ city })}`, {
		signal: context.signal,
		cache: context.requestCache,
	});
	if (!response.ok) throw new Error('Live summary unavailable');
	const ttlMs = Math.max(1, context.manifest.files.live.ttl_s ?? DEFAULT_LIVE_TTL_S) * 1000;
	context.onPollDelayMs?.(livePollDelayMs(response.headers, ttlMs));
	const summary = liveSummarySchema.parse(await response.json());
	if (summary.city !== city) throw new Error('Live summary belongs to another city');
	return summary;
}

function summaryOf(context: LiveReadContext) {
	const signal = context.signal;
	if (!signal) return fetchSummary(context);
	let pending = byPoll.get(signal);
	if (!pending) {
		pending = fetchSummary(context);
		byPoll.set(signal, pending);
	}
	return pending;
}

/** The late lines the summary carries, or none while it has not arrived. */
export function summaryLateLines(network: unknown): LateLine[] {
	const lines = (network as { late_lines?: LateLine[] } | null | undefined)?.late_lines;
	return Array.isArray(lines) ? lines : [];
}

/** The count of alerts the summary carries, or the length of a full alerts list. */
export function summaryAlertCount(alerts: { alerts: readonly unknown[] } | null | undefined) {
	if (!alerts) return undefined;
	const count = (alerts as { alert_count?: number }).alert_count;
	return typeof count === 'number' ? count : alerts.alerts.length;
}

/**
 * The Overview's Live now card reads the light summary. When the summary is missing (an older
 * worker, a failed read), it reads the full capture and works out the same figures from it.
 */
export const liveSummaryReader: LiveReader = {
	...liveReader,
	async network(context) {
		try {
			return (await summaryOf(context)).network;
		} catch {
			const [network, vehicles] = await Promise.all([
				liveReader.network(context),
				liveReader.vehicles(context),
			]);
			return { ...network, late_lines: lateLines(vehicles.vehicles) };
		}
	},
	async alerts(context) {
		let summary: LiveSummary | undefined;
		try {
			summary = await summaryOf(context);
		} catch {
			const alerts = await liveReader.alerts(context);
			return {
				...alerts,
				alert_count: liveNoticeCount(alerts.alerts.map(captureAlertOf), Date.now()),
			};
		}
		// The capture holds no alerts feed: the same outcome as reading it in full.
		if (!summary.alerts) throw new Error('Alerts unavailable');
		return summary.alerts;
	},
};
