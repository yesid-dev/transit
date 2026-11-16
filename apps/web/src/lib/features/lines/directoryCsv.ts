import type { Locale } from '#lib/i18n/index.ts';
import type { RouteIndexEntry } from '#lib/v1/index.ts';
import { hasDirectoryFigure, type DirectoryEvidence } from './directoryState';

/**
 * One row as the directory renders it: the published line, whether the comparison ranked it, and
 * the evidence the row shows. The export reads this same view model, so a file can never tell a
 * different story from the list.
 */
export interface DirectoryCsvRow {
	readonly line: RouteIndexEntry;
	readonly ranked: boolean;
	readonly evidence: DirectoryEvidence;
}

export interface DirectoryCsvInput {
	readonly rows: readonly DirectoryCsvRow[];
	readonly providerId: string;
	readonly providerName: string;
	readonly locale: Locale;
	/** The actual application origin, so downloaded links remain usable away from the page. */
	readonly origin: string;
	/** Source-supplied attribution only; the operator's display name is not attribution. */
	readonly attribution?: string | null;
	readonly modeTag: (line: RouteIndexEntry) => string | null;
	/** The row's own Record link, with the evidence's dates and the reader's provider. */
	readonly recordHref: (row: DirectoryCsvRow) => string;
}

export const DISPLAYED_CSV_FILENAME = 'lines-displayed-records.csv';

/** Fixed columns, in this order, for both exports: displayed rows and the selected record. */
const COLUMNS = [
	'provider',
	'provider_name',
	'line_id',
	'line_number',
	'line_name',
	'mode',
	'measure',
	'unit',
	'value_pct',
	'readings',
	'window_from',
	'window_to',
	'window_days',
	'evidence_state',
	'exclusion',
	'publication_generated_utc',
	'publication_generation_id',
	'publication_methodology_version',
	'source',
	'attribution',
	'record_url',
] as const;

// Spreadsheet readers can ignore whitespace/control prefixes before a formula marker.
function textCell(value: string | null | undefined): string {
	const text = typeof value === 'string' ? value : '';
	const safe = /^[\s\p{Cc}\p{Cf}]*[=+\-@]/u.test(text) ? "'" + text : text;
	return '"' + safe.replaceAll('"', '""') + '"';
}

/**
 * A numeric cell stays numeric: a real zero is 0 (never -0), an unknown is empty, and a value the
 * format cannot carry (NaN, ±Infinity) is unavailable rather than invented.
 */
function numericCell(value: number | null | undefined): string {
	if (value == null || !Number.isFinite(value)) return '';
	return String(value === 0 ? 0 : value);
}

function countCell(value: number | null | undefined): string {
	return value != null && Number.isSafeInteger(value) && value >= 0 ? numericCell(value) : '';
}

function absoluteRecordHref(row: DirectoryCsvRow, input: DirectoryCsvInput): string {
	const href = input.recordHref(row);
	try {
		const origin = new URL(input.origin);
		const target = new URL(href, origin);
		return ['https:', 'http:'].includes(target.protocol) &&
			target.origin === origin.origin &&
			target.searchParams.get('provider') === input.providerId
			? target.href
			: '';
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
		return '';
	}
}

function rowCells(row: DirectoryCsvRow, input: DirectoryCsvInput): string {
	const { evidence, line } = row;
	// Eligibility is not provenance: an excluded comparison entry still comes from the index.
	const canHaveReadings = ['figure', 'uncertain', 'low-sample'].includes(evidence.state);
	return [
		textCell(input.providerId),
		textCell(input.providerName),
		textCell(line.id),
		textCell(line.short),
		textCell(line.long ?? ''),
		textCell(input.modeTag(line) ?? ''),
		textCell('share_of_readings_on_time'),
		textCell('%'),
		numericCell(hasDirectoryFigure(evidence) ? evidence.percent : null),
		countCell(canHaveReadings ? evidence.readings : null),
		textCell(evidence.from),
		textCell(evidence.to),
		countCell(evidence.days != null && evidence.days > 0 ? evidence.days : null),
		textCell(evidence.state),
		textCell(evidence.excluded),
		textCell(evidence.publication.generatedUtc),
		textCell(evidence.publication.generationId),
		textCell(evidence.publication.methodVersion),
		textCell(evidence.source),
		textCell(input.attribution),
		textCell(absoluteRecordHref(row, input)),
	].join(',');
}

/** Every row the directory currently shows, in the order it shows them. */
export function directoryCsv(input: DirectoryCsvInput): string {
	return [COLUMNS.map(textCell).join(','), ...input.rows.map((row) => rowCells(row, input))].join(
		'\r\n',
	);
}

/**
 * The selected record alone, or null when the selection has no figure or no complete days to
 * export: an unavailable row exports nothing rather than a file full of blanks.
 */
export function selectedRecordCsv(input: DirectoryCsvInput): string | null {
	const [row] = input.rows;
	if (!row) return null;
	const { evidence } = row;
	if (!hasDirectoryFigure(evidence)) return null;
	return [COLUMNS.map(textCell).join(','), rowCells(row, input)].join('\r\n');
}

/** A stable file name for the selected record, naming the line and the days it covers. */
export function selectedRecordFilename(row: DirectoryCsvRow | null): string | null {
	const evidence = row?.evidence;
	if (!row || !evidence || !hasDirectoryFigure(evidence)) return null;
	const id = encodeURIComponent(row.line.id);
	return `line-${id}-${evidence.from}-${evidence.to}-selected-record.csv`;
}

/** The browser download link for a CSV body, matching the site's other exports. */
export function csvHref(csv: string): string {
	return 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
}
