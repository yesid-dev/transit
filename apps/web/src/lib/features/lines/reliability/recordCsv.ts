import type { Locale } from '#lib/i18n/config.ts';
import { applyEditionParams } from './recordEdition';
import type { RecordPublication } from './selectors/lineRecord';
import { csvDataHref } from '#lib/utils/csvDownload.ts';

export interface CsvContext {
	readonly providerId: string;
	readonly providerName?: string | null;
	readonly lineId: string;
	readonly lineName?: string | null;
	readonly locale: Locale;
	readonly origin: string;
	/** Supplied credit only. An operator name is not attribution. */
	readonly attribution?: string | null;
}

export interface CsvScope {
	readonly kind: string;
	readonly from?: string | null;
	readonly to?: string | null;
}

export interface CsvSource {
	readonly source: string;
	readonly publication: RecordPublication;
	readonly scope: CsvScope;
}

export type CsvCell = string | number | null | undefined;
export interface CsvRow {
	readonly cells: readonly CsvCell[];
	readonly measure?: string;
	readonly unit?: string;
	readonly readings?: number | null;
	readonly readingsBasis?: string;
	readonly exclusions?: string | null;
	readonly state?: string;
}

export interface CsvDownload {
	readonly csv: string;
	readonly href: string;
	readonly filename: string;
}

/** Text is always quoted and spreadsheet-safe; finite numbers remain numeric. */
export function csvCell(value: CsvCell): string {
	if (typeof value === 'number') return Number.isFinite(value) ? String(value + 0) : '';
	if (value == null) return '';
	const safe = /^[\s\p{Cc}\p{Cf}]*[=+\-@]/u.test(value) ? "'" + value : value;
	return '"' + safe.replaceAll('"', '""') + '"';
}

export const csvNumber = (v: number | null | undefined): number | null =>
	typeof v === 'number' && Number.isFinite(v) ? v + 0 : null;
export const csvCount = (v: number | null | undefined): number | null =>
	typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v + 0 : null;
export const csvPercent = (v: number | null | undefined): number | null =>
	typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v + 0 : null;

const METADATA = [
	'source',
	'provider',
	'provider_name',
	'line_id',
	'line_name',
	'locale',
	'scope',
	'window_from',
	'window_to',
	'measure',
	'unit',
	'readings',
	'readings_basis',
	'exclusions',
	'state',
	'publication_generated_utc',
	'publication_generation_id',
	'publication_methodology_version',
	'record_url',
	'attribution',
] as const;

function recordUrl(context: CsvContext, source: CsvSource): string {
	try {
		const origin = new URL(context.origin);
		if (!['https:', 'http:'].includes(origin.protocol)) return '';
		const prefix = context.locale === 'fr' ? '/fr' : '';
		const target = new URL(`${prefix}/lines/${encodeURIComponent(context.lineId)}`, origin.origin);
		target.searchParams.set('provider', context.providerId);
		if (source.scope.from && source.scope.to) {
			target.searchParams.set('from', source.scope.from);
			target.searchParams.set('to', source.scope.to);
		}
		const mixGrain = /^undated_(day|week|month)_mix$/u.exec(source.scope.kind)?.[1];
		if (mixGrain) target.searchParams.set('grain', mixGrain);
		applyEditionParams(target.searchParams, source.publication);
		return target.href;
	} catch (error) {
		if (!(error instanceof TypeError)) throw error;
		return '';
	}
}

/** One flat file from one rendered snapshot. It performs no I/O, lookups or transport math. */
export function downloadCsv(
	context: CsvContext | undefined,
	source: CsvSource | undefined,
	block: string,
	columns: readonly string[],
	rows: readonly CsvRow[],
): CsvDownload | null {
	if (
		!context ||
		!source ||
		source.scope.kind === 'none' ||
		rows.length === 0 ||
		rows.every((row) => row.state === 'not_published')
	)
		return null;
	const { scope, publication } = source;
	const url = recordUrl(context, source);
	const records = rows.map((row) => [
		source.source,
		context.providerId,
		context.providerName ?? '',
		context.lineId,
		context.lineName ?? '',
		context.locale,
		scope.kind,
		scope.from ?? '',
		scope.to ?? '',
		row.measure ?? '',
		row.unit ?? '',
		csvCount(row.readings),
		row.readingsBasis ?? '',
		row.exclusions ?? '',
		row.state ?? 'published',
		publication.generatedUtc ?? '',
		publication.generationId ?? '',
		publication.methodVersion ?? '',
		url,
		context.attribution ?? '',
		...row.cells,
	]);
	const csv = [[...METADATA, ...columns], ...records]
		.map((row) => row.map(csvCell).join(','))
		.join('\r\n');
	const period = scope.from && scope.to ? `${scope.from}-${scope.to}` : scope.kind;
	return {
		csv,
		href: csvDataHref(csv),
		filename: `line-${encodeURIComponent(context.lineId)}-${encodeURIComponent(block)}-${encodeURIComponent(period)}-displayed-rows.csv`,
	};
}
