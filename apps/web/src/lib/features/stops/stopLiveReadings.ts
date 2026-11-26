import type { Locale } from '#lib/i18n/index.ts';
import type { transitDisplay } from '#lib/site/transitDisplayContext.ts';
import type { CaptureTripReport } from '#lib/live/captureSnapshot.ts';
import { stopPrediction, uniqueDirectionHeadsigns } from '#lib/live/stopPrediction.ts';
import type { ScheduleEdition } from '#lib/search/searchIndex.ts';
import { compassPoint, type LinePattern } from '#lib/site/linePatterns.ts';
import { riderHeadsign } from '#lib/site/presenter.ts';

export type StopPrediction = {
	key: string;
	instance: string;
	trip: string;
	line: string | null;
	direction: number | null;
	start: string | null;
	toward: string | null;
	predictedAt: number;
	scheduledAt: number | null;
	delay: number | null;
};

export function stopLiveReadings(
	report: CaptureTripReport,
	id: string,
	now: number,
	directions?: ScheduleEdition['route_directions'],
) {
	const readings = new Map<string, StopPrediction>();
	const headsigns = new Map(
		Object.entries(directions ?? {}).map(([line, patterns]) => [
			line,
			uniqueDirectionHeadsigns(patterns),
		]),
	);
	for (const trip of report.trip_updates) {
		const line = trip.route_id || null;
		const instance = JSON.stringify([line, trip.trip_id, trip.start_date, trip.start_time]);
		for (const stop of trip.stops) {
			if (stop.stop_id !== id) continue;
			const reading = stopPrediction(trip, stop, now, line ? headsigns.get(line) : undefined);
			if (!reading) continue;
			const key = JSON.stringify([instance, stop.sequence]);
			if ((readings.get(key)?.predictedAt ?? Infinity) <= reading.predictedAt) continue;
			readings.set(key, {
				key,
				instance,
				trip: trip.trip_id,
				line,
				direction: trip.direction_id,
				start: trip.start_time,
				...reading,
			});
		}
	}
	const rows = [...readings.values()].sort((a, b) => a.predictedAt - b.predictedAt);
	const cutoff = now + 15 * 60_000;
	const count = new Set(rows.filter((row) => row.predictedAt <= cutoff).map((row) => row.instance))
		.size;
	return { rows, count };
}

/**
 * Where a predicted trip goes, in the rider's words: a compass headsign becomes the line's
 * terminus with the agency's word in brackets ("Station Laurier (Est)", "(est)" in French), as
 * on the line pages. The stop page passes its own lines' termini (`patterns`); without them the
 * page's line directory is asked. In a sentence any compass word reads as W8's direction ("the
 * north"); in a table cell a compass word with no known terminus reads in the reader's language
 * ("West", "Ouest"), and any other sign reads as published.
 */
export function riderToward(
	display: Pick<ReturnType<typeof transitDisplay>, 'directory' | 'directionName' | 'readName'>,
	row: Pick<StopPrediction, 'line' | 'toward'>,
	locale: Locale,
	place: 'cell' | 'sentence' = 'cell',
	patterns?: Readonly<Record<string, LinePattern>>,
): string | null {
	const toward = row.toward?.trim();
	if (!toward) return null;
	const pattern = row.line ? patterns?.[row.line] : undefined;
	const sign = pattern
		? riderHeadsign(toward, pattern)
		: display.directory.headsign(row.line, toward);
	if (place === 'sentence') return display.directionName(sign ?? toward, locale);
	if (sign && sign !== toward) return display.directionName(sign, locale);
	return compassPoint.test(toward) ? compassWord(toward, locale) : display.readName(toward, locale);
}

const compassWords: Record<string, [string, string]> = {
	est: ['East', 'Est'],
	ouest: ['West', 'Ouest'],
	nord: ['North', 'Nord'],
	sud: ['South', 'Sud'],
};

/** A bare compass headsign as a table cell names it, never the agency's word in the other language. */
function compassWord(sign: string, locale: Locale) {
	const key =
		{ east: 'est', west: 'ouest', north: 'nord', south: 'sud' }[sign.toLowerCase()] ??
		sign.toLowerCase();
	return compassWords[key][locale === 'fr' ? 1 : 0];
}
