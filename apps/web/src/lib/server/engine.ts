import { env } from 'cloudflare:workers';
import { z } from 'zod';
import type { DateWindow } from '#lib/v1/history/window.ts';

export const ENGINE_TIMEOUT_MS = 20_000;

const bilingual = z.object({ en: z.string(), fr: z.string() });
const engineState = z.enum([
	'measured',
	'not_measured',
	'too_few_to_judge',
	'no_live_data',
	'not_tracked',
	'unknown',
]);
const share = z.number().min(0).max(1);
const count = z.int().nonnegative();
const counts = z.record(z.string(), count.nullable());
const evidence = z.object({
	start_date: z.iso.date(),
	end_date: z.iso.date(),
	days_included: z.array(z.iso.date()),
	days_measured: z.array(z.iso.date()),
	days_not_measured: z.array(z.iso.date()),
	days_not_measured_reasons: z.record(z.iso.date(), z.string()).optional(),
	days_not_tracked: z.array(z.iso.date()).optional(),
	method_version: z.string(),
	cleaning_versions: z.array(count),
	query_ms: z.number(),
});
const state = z.object({ state: engineState, state_text: bilingual });
const measureAnswer = state.extend({
	measure: z.enum(['on_time', 'trips_run']),
	value: z.record(z.string(), share.nullable()),
	coverage_note: bilingual.nullable(),
	evidence: evidence.extend({ counts, excluded: counts }),
});
const rankingEnvelope = state.partial().extend({
	class: z.string().nullable(),
	coverage_note: bilingual.nullable(),
	info: z
		.array(
			z.object({
				minimum_sample: count,
				ranking_floors: z
					.object({
						departure: z.object({ observed_service_dates: count, classified: count }).optional(),
					})
					.optional(),
			}),
		)
		.nonempty(),
	evidence,
});
const rankingAnswer = rankingEnvelope.extend({
	measure: z.literal('on_time'),
	kind: z.enum(['line', 'stop']),
	rows: z.array(
		z.object({
			id: z.string(),
			rank: count,
			value: share,
			sample: count,
			ranking_bound: share.nullable().optional(),
			range: z.object({ lower: share, upper: share, method: z.string() }),
		}),
	),
	excluded: z.array(z.object({ reason: engineState, reason_text: bilingual })),
});

export type MeasureAnswer = z.infer<typeof measureAnswer>;
export type RankingAnswer = z.infer<typeof rankingAnswer>;
export type EngineResult<T> =
	| { kind: 'answer'; answer: T; lastGood?: true }
	| { kind: 'unconfigured' | 'unreachable' | 'timeout' | 'busy' };

export type EnginePeriod = DateWindow & { city: string; visitorIp?: string | null };
const QUESTION_ORIGIN = 'https://data.yesid.dev';

function engineFetch(
	path: string,
	parameters: Record<string, string>,
	signal: AbortSignal,
	visitorIp?: string | null,
) {
	const proxy = env.QUESTION_PROXY;
	const fixture = env.QUESTION_FIXTURE_ORIGIN;
	if (!proxy && !fixture) return null;
	const url = new URL(`/v2${path}`, proxy ? QUESTION_ORIGIN : fixture);
	url.search = new URLSearchParams(parameters).toString();
	const headers = proxy && visitorIp ? { 'x-transit-visitor-ip': visitorIp } : undefined;
	const request = new Request(url, { headers, signal, redirect: 'manual' });
	return proxy ? proxy.fetch(request) : fetch(request);
}

async function query<T>(
	path: string,
	parameters: Record<string, string>,
	schema: z.ZodType<T>,
	visitorIp?: string | null,
): Promise<EngineResult<T>> {
	const signal = AbortSignal.timeout(ENGINE_TIMEOUT_MS);
	try {
		const response = await engineFetch(path, parameters, signal, visitorIp);
		if (!response) return { kind: 'unconfigured' };
		if (response.status === 503 && response.headers.has('retry-after')) return { kind: 'busy' };
		if (!response.ok) return { kind: 'unreachable' };
		const { success, data } = schema.safeParse(await response.json());
		if (!success) return { kind: 'unreachable' };
		return response.headers.get('x-transit-answer') === 'last-good'
			? { kind: 'answer', answer: data, lastGood: true }
			: { kind: 'answer', answer: data };
	} catch {
		return { kind: signal.aborted ? 'timeout' : 'unreachable' };
	}
}

function periodQuery<T>(
	path: string,
	{ city, from, to, visitorIp }: EnginePeriod,
	parameters: Record<string, string>,
	schema: z.ZodType<T>,
) {
	return query(
		`/${encodeURIComponent(city)}${path}`,
		{ from, to, ...parameters },
		schema,
		visitorIp,
	);
}

export function getMeasure(measure: MeasureAnswer['measure'], period: EnginePeriod) {
	return periodQuery('/measure', period, { measure }, measureAnswer);
}

export function getRanking(kind: RankingAnswer['kind'], period: EnginePeriod) {
	return periodQuery('/ranking', period, { kind, measure: 'on_time', limit: '3' }, rankingAnswer);
}

const recordCounts = z.record(z.string(), z.number().nullable().catch(null));
const translatedMessage = z.object({ en: z.string().nullable(), fr: z.string().nullable() });
const recordCell = state.extend({
	value: z.record(z.string(), z.number().nullable()),
	evidence: z.object({
		counts: recordCounts,
		days_included: z.array(z.iso.date()),
		observed_delay_seconds: z.number().nullable().optional(),
		trip_ids: z.array(z.string()).optional(),
		alert_messages: z
			.array(
				z.object({
					source: z.string(),
					id: z.string(),
					version: z.string(),
					routes: z.array(z.string()),
					stops: z.array(z.string()),
					header: translatedMessage,
					description: translatedMessage,
					periods: z
						.array(
							z.object({
								start: z.iso.datetime({ offset: true }),
								end: z.iso.datetime({ offset: true }),
							}),
						)
						.optional(),
				}),
			)
			.nullable()
			.optional(),
		periods: z
			.array(
				z.object({
					period_text: bilingual,
					start_hour: count,
					end_hour: count,
					day_type: z.string(),
					days: count,
					scheduled_trips: count,
					scheduled_clock_hours: count,
					scheduled_frequency: z.number().nonnegative(),
				}),
			)
			.optional(),
		boundary_departures: z
			.array(
				z.object({
					measure: z.enum(['first_trip', 'last_trip']),
					service_date: z.iso.date(),
					scheduled_departure: z.string(),
					scheduled: count,
				}),
			)
			.nullable()
			.optional(),
		percentage_levels: z
			.array(
				z.object({
					percentage: count,
					vehicle_seconds: z.number(),
					share: share.nullable(),
				}),
			)
			.optional(),
	}),
});
const recordEnvelope = z.object({
	evidence,
	coverage_note: bilingual.nullable(),
});
const recordMeasure = recordEnvelope.extend({
	...recordCell.shape,
	evidence: evidence.extend(recordCell.shape.evidence.shape),
	info: z
		.array(
			z.object({
				text: z
					.object({
						en: z.object({ counts: z.string(), limits: z.string() }),
						fr: z.object({ counts: z.string(), limits: z.string() }),
					})
					.optional(),
			}),
		)
		.optional(),
});
const recordSeries = recordEnvelope.extend({
	...state.partial().shape,
	info: z
		.array(
			z.object({
				minimum_sample: count,
				minimum_coverage: share.optional(),
				low_coverage_below: share.optional(),
			}),
		)
		.optional(),
	cells: z.array(
		recordCell.extend({
			key: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
		}),
	),
});
const departureRanking = rankingAnswer.extend({
	kind: z.literal('departure'),
	measure: z.literal('late'),
	rows: z.array(
		rankingAnswer.shape.rows.element.extend({
			departure: z.string(),
			direction: z.number().nullable(),
			counts: recordCounts,
		}),
	),
});

export type RecordEvidence = z.infer<typeof evidence>;
export type RecordMeasure = z.infer<typeof recordMeasure>;
export type RecordCell = z.infer<typeof recordCell>;
export type RecordSeries = z.infer<typeof recordSeries>;
export type DepartureRanking = z.infer<typeof departureRanking>;
export type RecordAnswer = RecordMeasure | RecordSeries | DepartureRanking | RankingAnswer;
export type RecordQuery = {
	path: '/measure' | '/ranking';
	parameters: Record<string, string>;
};

const rankingIdentity = z.object({
	id: z.string(),
	classes: z.array(z.string()),
	line: z.string().optional(),
	direction: z.number().nullable().optional(),
	departure: z.string().optional(),
	sample: z.number().nonnegative().nullable(),
	counts: recordCounts,
});
const rankingsRecord = rankingEnvelope.extend({
	kind: z.enum(['line', 'stop', 'departure', 'vehicle']),
	measure: z.string(),
	available_classes: z.array(z.string()),
	ranked_count: count,
	rows: z.array(
		rankingIdentity.extend({
			rank: count,
			sample: z.number().nonnegative(),
			value: z.number(),
			range: z.object({
				lower: z.number().nullable(),
				upper: z.number().nullable(),
				method: z.string(),
			}),
		}),
	),
	excluded: z.array(rankingIdentity.extend({ reason: engineState, reason_text: bilingual })),
	range_notes: z.record(z.string(), bilingual),
	info: z
		.array(
			z.object({
				minimum_sample: count,
				ranking_minimum_sample: z.number().nonnegative().optional(),
				text: z.object({
					en: z.object({ definition: z.string() }),
					fr: z.object({ definition: z.string() }),
				}),
			}),
		)
		.nonempty(),
});

export type RankingsRecord = z.infer<typeof rankingsRecord>;

export function getRankingsRecord(parameters: Record<string, string>, period: EnginePeriod) {
	return periodQuery('/ranking', period, parameters, rankingsRecord);
}

export function getRecordAnswer({ path, parameters }: RecordQuery, period: EnginePeriod) {
	const schema: z.ZodType<RecordAnswer> =
		path === '/ranking'
			? parameters.kind === 'departure'
				? departureRanking
				: rankingAnswer
			: parameters.group
				? recordSeries
				: recordMeasure;
	return periodQuery(path, period, parameters, schema);
}

const finderSeries = recordEnvelope.extend({
	cells: z.array(
		recordSeries.shape.cells.element.extend({
			evidence: recordCell.shape.evidence.pick({ counts: true }),
		}),
	),
});

export type FinderSeries = z.infer<typeof finderSeries>;
export type FinderCell = FinderSeries['cells'][number];

export function getFinderSeries(
	measure: 'on_time' | 'trips_run',
	group: 'line' | 'stop_id',
	period: EnginePeriod,
) {
	return periodQuery('/measure', period, { measure, group }, finderSeries);
}

export async function getRecordCsv(
	{ path, parameters }: RecordQuery,
	{ city, from, to, visitorIp }: EnginePeriod,
	lang: 'en' | 'fr',
) {
	return engineFetch(
		`/${encodeURIComponent(city)}${path}`,
		{ from, to, ...parameters, format: 'csv', lang },
		AbortSignal.timeout(ENGINE_TIMEOUT_MS),
		visitorIp,
	);
}

const methodText = z.object({
	definition: z.string(),
	unit: z.string(),
	counts: z.string(),
	exclusions: z.string(),
	limits: z.string(),
	histogram: z.string().optional(),
});
const catalogKey = z.string().regex(/^[a-z][a-z0-9_]*$/);
const methodCatalog = z.array(
	z.object({
		id: catalogKey,
		family: catalogKey,
		family_text: bilingual.optional(),
		method_version: z.string(),
		since: z.iso.date(),
		minimum_sample: count,
		ranking_minimum_sample: count.optional(),
		csv_columns: z.object({ en: z.array(z.string()), fr: z.array(z.string()) }),
		text: z.object({ en: methodText, fr: methodText }),
	}),
);
const tableHealth = z.object({
	status: z.enum(['present', 'missing', 'incomplete', 'not_measured', 'not_tracked']),
	reason: z.string().optional(),
});
const dataHealth = z.object({
	city: z.string(),
	from: z.iso.date(),
	to: z.iso.date(),
	cleaning_version: z.string(),
	days: z.array(
		tableHealth.extend({
			service_date: z.iso.date(),
			cleaning_version: z.string(),
			tables: z.record(z.string(), tableHealth),
		}),
	),
});

export type MethodEntry = z.infer<typeof methodCatalog>[number];
export type DataHealthAnswer = z.infer<typeof dataHealth>;
export type TableHealth = z.infer<typeof tableHealth>;

export function getMethodCatalog(visitorIp?: string | null) {
	return query('/how-we-measure', {}, methodCatalog, visitorIp);
}

export function getRecordDataHealth(period: EnginePeriod) {
	return periodQuery('/data-health', period, {}, dataHealth);
}
