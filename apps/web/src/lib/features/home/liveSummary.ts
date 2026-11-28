import { z } from 'zod';
import { captureAlerts, captureNetwork, captureVehicles } from '#lib/live/captureProjection.ts';
import { captureFeedSchema, type CaptureSnapshot } from '#lib/live/captureSnapshot.ts';
import { AlertsFileSchema } from '#lib/v1/schemas/alerts.ts';
import { LiveNetworkFileSchema } from '#lib/v1/schemas/network.ts';
import { liveNoticeCount } from '../alerts/alertCards.ts';
import { lateLines } from './overviewRecord.ts';

const evidence = {
	captureFeed: captureFeedSchema.optional(),
	capturePublishedAt: z.string().nullable().optional(),
	captureRevision: z.string().optional(),
};

const lateLine = z.object({
	id: z.string(),
	late: z.int().nonnegative(),
	total: z.int().positive(),
});

/**
 * What the Overview's Live now card reads from a live capture: the network reading with its
 * three late lines, and the count of notices in effect now. The vehicle positions and the alert texts stay on
 * the server. The browser checks the same shapes the full capture's readings have.
 */
export const liveSummarySchema = z.object({
	version: z.literal(1),
	city: z.string(),
	network: LiveNetworkFileSchema.extend({ ...evidence, late_lines: z.array(lateLine) }),
	alerts: AlertsFileSchema.extend({
		...evidence,
		alerts: z.array(z.never()),
		alert_count: z.int().nonnegative(),
	}).nullable(),
});

export type LiveSummary = z.infer<typeof liveSummarySchema>;
export type LateLine = z.infer<typeof lateLine>;

/** The summary, worked out with the same projections the full capture goes through. */
export function liveSummary(snapshot: CaptureSnapshot, now: number): LiveSummary {
	const network = captureNetwork(snapshot, now);
	const vehicles = captureVehicles(snapshot, now).vehicles;
	let alerts: LiveSummary['alerts'] = null;
	try {
		const file = captureAlerts(snapshot, now);
		// The notices in effect now, as Service alerts counts them live, not every published copy.
		alerts = { ...file, alerts: [], alert_count: liveNoticeCount(snapshot.alerts ?? [], now) };
	} catch {
		// No live alerts feed in this capture: the card reads it as unavailable, as before.
	}
	return {
		version: 1,
		city: snapshot.city,
		network: { ...network, late_lines: lateLines(vehicles) },
		alerts,
	};
}
