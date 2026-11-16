import type { Trip, TripsFile } from '#lib/v1/index.ts';

/** Preserve the reported number; zero is valid and nonfinite values are unavailable. */
export function reportedOffset(value: number | null | undefined): number | null {
	return value != null && Number.isFinite(value) ? (value === 0 ? 0 : value) : null;
}

const COLUMNS = [
	'provider',
	'trip_id',
	'line_id',
	'schema_version',
	'methodology_version',
	'publish_generation_id',
	'report_generated_utc',
	'feed_captured_utc',
	'time_zone',
	'stop_id',
	'stop_name',
	'predicted_utc',
	'reported_offset_min',
] as const;

// Spreadsheet readers can ignore whitespace/control prefixes before a formula marker.
function textCell(value: string | null | undefined): string {
	const text = typeof value === 'string' ? value : '';
	const safe = /^[\s\p{Cc}\p{Cf}]*[=+\-@]/u.test(text) ? "'" + text : text;
	return '"' + safe.replaceAll('"', '""') + '"';
}

type ReportEnvelope = Pick<
	TripsFile,
	| 'schema_version'
	| 'methodology_version'
	| 'publish_generation_id'
	| 'generated_utc'
	| 'feed_captured_utc'
>;

export function tripReportCsv(input: {
	provider: string;
	tripId: string;
	trip: Trip;
	report: ReportEnvelope | null;
	timeZone: string | null;
	stopNames: Readonly<Record<string, string>>;
}): string {
	const { provider, tripId, trip, report, timeZone, stopNames } = input;
	const schema = report?.schema_version;
	const schemaCell =
		schema != null && Number.isInteger(schema) ? String(schema === 0 ? 0 : schema) : '';
	return [
		COLUMNS.map(textCell).join(','),
		...(trip.stops ?? []).map((prediction) =>
			[
				...[provider, tripId, trip.route].map(textCell),
				schemaCell,
				...[
					report?.methodology_version,
					report?.publish_generation_id,
					report?.generated_utc,
					report?.feed_captured_utc,
					timeZone,
					prediction.stop,
					Object.hasOwn(stopNames, prediction.stop) ? stopNames[prediction.stop] : null,
					prediction.eta_utc,
				].map(textCell),
				// This column is numeric. A valid negative value is not spreadsheet formula text.
				reportedOffset(prediction.delay_min)?.toString() ?? '',
			].join(','),
		),
	].join('\r\n');
}
