import { getRequestEvent } from '$app/server';
import { env } from 'cloudflare:workers';
import type { CaptureScope } from '#lib/live/captureSnapshot.ts';
import { z } from 'zod';
import { CityCatalogSchema } from '#lib/v1/schemas/providers.ts';
import { timeQuestion } from './questionTiming.ts';
import {
	scheduleIndexSchema,
	scheduleMapSchema,
	searchIndexSchema,
} from '#lib/search/searchIndex.ts';
import {
	cityQuestion,
	citiesQuestion,
	dataHealthQuestion,
	finderQuestion,
	isHeavyQuestion,
	measureQuestion,
	methodQuestion,
	overviewRankingQuestion,
	periodQuestion,
	questionUrl,
	QUESTION_ORIGIN,
	scheduleQuestion,
	type EngineQuestion,
	type EnginePeriod,
	type FinderQuestionParameters,
	type RecordQuery,
} from './engineQuestion.ts';

export type { EnginePeriod, RecordQuery } from './engineQuestion.ts';

export const ENGINE_TIMEOUT_MS = 20_000;
const RECORD_TIMEOUT_MS = 45_000;

const bilingual = z.object({ en: z.string(), fr: z.string() });
const engineState = z.enum([
	'measured',
	'not_measured',
	'too_few_to_judge',
	'no_live_data',
	'not_tracked',
	'unknown',
]);
// A ranking leaves out an entity under its low-coverage limit; older engines never send it.
const exclusionReason = engineState.or(z.literal('low_coverage'));
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
const rateCoverage = z.object({
	share_observed: share.nullable().optional(),
	share_eligible: share.nullable().optional(),
	share_occupancy_readings: share.nullable().optional(),
	low_coverage: z.boolean().optional(),
	coverage_reason: z.literal('insufficient_coverage').optional(),
});
const rankingFloors = z.object({
	line: z.record(z.string(), count).optional(),
	stop: z.record(z.string(), count).optional(),
	departure: z.object({ observed_service_dates: count, classified: count }).optional(),
});
const measureAnswer = state.extend({
	measure: z.enum(['on_time', 'trips_run', 'punctuality']),
	value: z.record(z.string(), z.number().nullable()),
	coverage_note: bilingual.nullable(),
	info: z
		.array(z.object({ id: z.string().optional(), minimum_sample: count.optional() }))
		.optional(),
	evidence: evidence.extend({ ...rateCoverage.shape, counts, excluded: counts }),
});
const rankingEnvelope = state.partial().extend({
	class: z.string().nullable(),
	coverage_note: bilingual.nullable(),
	info: z
		.array(
			z.object({
				minimum_sample: count,
				ranking_minimum_sample: count.optional(),
				ranking_floors: rankingFloors.optional(),
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
			...rateCoverage.shape,
			counts: counts.optional(),
			id: z.string(),
			rank: count,
			value: share,
			sample: count,
			ranking_bound: share.nullable().optional(),
			range: z.object({ lower: share, upper: share, method: z.string() }),
		}),
	),
	excluded: z.array(
		z.object({
			...rateCoverage.shape,
			id: z.string().optional(),
			reason: exclusionReason,
			reason_text: bilingual,
			sample: count.nullable().optional(),
			counts: counts.optional(),
		}),
	),
});

export type MeasureAnswer = z.infer<typeof measureAnswer>;
export type RankingAnswer = z.infer<typeof rankingAnswer>;
const corridorReasons = [
	'network_corridors_unsupported',
	'segment_runs_version_required',
	'segment_runs_missing',
] as const;
type CorridorReason = (typeof corridorReasons)[number];

export type EngineResult<T> =
	| { kind: 'answer'; answer: T; lastGood?: true; cacheStale?: true }
	| { kind: 'unreachable'; status?: number; reason?: CorridorReason; retry?: () => void }
	| { kind: 'busy'; retryAfterMs?: number }
	| { kind: 'unconfigured' | 'timeout' };

function retryDelay(header: string) {
	const delay = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
	return Math.min(60_000, Math.max(0, Number.isNaN(delay) ? 60_000 : delay));
}

export async function getEngineHealth() {
	const unavailable = { proxy: 'unavailable', engine: 'unknown' } as const;
	const signal = AbortSignal.timeout(3_000);
	try {
		const response = await engineFetch({ path: '/health', parameters: {} }, signal);
		if (!response) return { proxy: 'unconfigured', engine: 'unknown' } as const;
		if (response.status !== 200 && response.status !== 503) return unavailable;
		const result = z
			.object({ engine: z.enum(['ok', 'unavailable', 'unconfigured']) })
			.safeParse(await response.json());
		if (!result.success || (result.data.engine === 'ok') !== response.ok) return unavailable;
		return { proxy: 'ok', engine: result.data.engine } as const;
	} catch {
		return unavailable;
	}
}

function engineFetch(
	question: EngineQuestion,
	signal: AbortSignal,
	visitorIp?: string | null,
	recordDeadline?: number,
) {
	// Vite has no deployed Questions service, even when its local Worker exposes the binding.
	const local = import.meta.env.MODE === 'development';
	const proxy = local ? undefined : env.QUESTION_PROXY;
	const fixture = env.QUESTION_FIXTURE_ORIGIN;
	const direct = fixture ?? (local ? QUESTION_ORIGIN : undefined);
	if (!proxy && !direct) return null;
	const url = questionUrl(question, proxy ? QUESTION_ORIGIN : direct);
	const headers = new Headers();
	if (proxy && visitorIp) headers.set('x-transit-visitor-ip', visitorIp);
	if (proxy && recordDeadline) headers.set('x-transit-record-deadline', String(recordDeadline));
	const request = new Request(url, { headers, signal, redirect: 'manual' });
	return proxy ? proxy.fetch(request) : fetch(request);
}

export async function getCaptureResponse(
	city: string,
	requestSignal: AbortSignal,
	visitorIp?: string | null,
	scope?: CaptureScope,
) {
	const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(ENGINE_TIMEOUT_MS)]);
	const question = cityQuestion(city, scope ? '/live-trips' : '/live');
	if (scope) question.parameters[scope.kind] = scope.id;
	return engineFetch(question, signal, visitorIp);
}

export async function query<T>(
	question: EngineQuestion,
	schema: z.ZodType<T>,
	visitorIp?: string | null,
	record = false,
	requestSignal?: AbortSignal,
): Promise<EngineResult<T>> {
	const timeout = record ? RECORD_TIMEOUT_MS : ENGINE_TIMEOUT_MS;
	const deadline = AbortSignal.timeout(timeout);
	const signal = requestSignal ? AbortSignal.any([deadline, requestSignal]) : deadline;
	const recordDeadline = record ? Date.now() + timeout - 250 : undefined;
	const settle = timeQuestion(question.parameters.measure ?? question.path.slice(1));
	let headers: Headers | null = null;
	try {
		const response = await engineFetch(question, signal, visitorIp, recordDeadline);
		if (!response) return { kind: 'unconfigured' };
		headers = response.headers;
		if (
			question.parameters.view === 'map' &&
			question.parameters.group === 'segment' &&
			!question.parameters.line &&
			response.status === 409
		) {
			const { reason } = z.object({ reason: z.enum(corridorReasons) }).parse(await response.json());
			return { kind: 'unreachable', status: 409, reason };
		}
		const retryAfter = response.headers.get('retry-after');
		if (!response.ok) await response.body?.cancel().catch(() => {});
		if (response.status === 503 && retryAfter !== null)
			return { kind: 'busy', retryAfterMs: retryDelay(retryAfter) };
		if (
			response.status === 400 &&
			(question.parameters.include_overall || question.parameters.view === 'map')
		)
			return { kind: 'unreachable', status: 400 };
		if (!response.ok) return { kind: 'unreachable' };
		const { success, data } = schema.safeParse(await response.json());
		if (!success) return { kind: 'unreachable' };
		return {
			kind: 'answer',
			answer: data,
			...(response.headers.get('x-transit-answer') === 'last-good' && { lastGood: true }),
			...(response.headers.get('x-transit-cache') === 'stale' && { cacheStale: true }),
		};
	} catch {
		return { kind: signal.aborted ? 'timeout' : 'unreachable' };
	} finally {
		settle(headers);
	}
}

/** The page request a record question belongs to, when it is asked while a page is served. */
function servedPage() {
	try {
		return getRequestEvent();
	} catch {
		return null;
	}
}

/**
 * How long a heavy question gives the page's quick questions to reach the engine ahead of it. It
 * only orders arrival: no card ever waits for another card's answer.
 */
const QUICK_HEAD_START_MS = 300;
/**
 * How long the page's other quick questions give its lead questions (the reading at the top of the
 * screen) to reach the engine first. Like the heavy head start, it only orders arrival.
 */
const LEAD_HEAD_START_MS = 150;
type PageReadings = { lead: Promise<unknown>[]; quick: Promise<unknown>[] };
const pageReadings = new WeakMap<object, PageReadings>();

/** Whether a record question carries the reading at the top of its screen. */
export type RecordOrder = { lead?: boolean };

/** Resolves when the readings settle or the head start ends, whichever comes first. */
async function headStart(readings: Promise<unknown>[], ms: number) {
	let hold: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		Promise.allSettled(readings),
		new Promise((resolve) => (hold = setTimeout(resolve, ms))),
	]);
	clearTimeout(hold);
}

/**
 * Asks a record question once, with the record limit, for the page that is being served. A rider
 * who leaves the page cancels it, so the engine stops working for nobody. The engine answers two
 * questions at a time in the order they arrive, so the page sends them in three steps: its lead
 * questions at once, its other quick questions once the lead ones it has already asked settle (or
 * after their short head start), and a heavy question once the quick ones settle (or after theirs).
 */
async function recordQuery<T>(
	question: EngineQuestion,
	schema: z.ZodType<T>,
	visitorIp: string | null | undefined,
	signal?: AbortSignal,
	order: RecordOrder = {},
): Promise<EngineResult<T>> {
	const page = servedPage();
	const requestSignal = signal ?? page?.request.signal;
	if (!page) return query(question, schema, visitorIp, true, requestSignal);
	let readings = pageReadings.get(page);
	if (!readings) pageReadings.set(page, (readings = { lead: [], quick: [] }));
	const ask = () => query(question, schema, visitorIp, true, requestSignal);
	if (order.lead) {
		const reading = ask();
		readings.lead.push(reading);
		readings.quick.push(reading);
		return reading;
	}
	if (!isHeavyQuestion(question.parameters)) {
		const lead = [...readings.lead];
		const reading = lead.length
			? headStart(lead, LEAD_HEAD_START_MS).then(() =>
					requestSignal?.aborted ? ({ kind: 'timeout' } as const) : ask(),
				)
			: ask();
		readings.quick.push(reading);
		return reading;
	}
	// The page asks its other questions in the same turn; let them all be counted first.
	await new Promise((resolve) => setTimeout(resolve, 0));
	await headStart(readings.quick, QUICK_HEAD_START_MS);
	if (requestSignal?.aborted) return { kind: 'timeout' };
	return ask();
}

function periodQuery<T>(
	path: string,
	period: EnginePeriod,
	parameters: Record<string, string>,
	schema: z.ZodType<T>,
	signal?: AbortSignal,
	order?: RecordOrder,
) {
	return recordQuery(
		periodQuestion(period, path, parameters),
		schema,
		period.visitorIp,
		signal,
		order,
	);
}

export function getMeasure(measure: MeasureAnswer['measure'], period: EnginePeriod) {
	return recordQuery(measureQuestion(measure, period), measureAnswer, period.visitorIp);
}

export function getRanking(kind: RankingAnswer['kind'], period: EnginePeriod) {
	return recordQuery(overviewRankingQuestion(kind, period), rankingAnswer, period.visitorIp);
}

const recordCounts = z.record(z.string(), z.number().nullable().catch(null));
const translatedMessage = z.object({ en: z.string().nullable(), fr: z.string().nullable() });
const recordStateName = engineState.or(z.literal('not_published'));
const waitingStateName = recordStateName.or(z.literal('no_frequent_periods'));
const recordState = state.extend({ state: recordStateName });
const recordCell = recordState.extend({
	state: waitingStateName,
	value: z.record(z.string(), z.number().nullable()),
	evidence: z.object({
		...rateCoverage.shape,
		counts: recordCounts,
		measure_states: z.record(z.string(), waitingStateName).optional(),
		excluded: recordCounts.optional(),
		days_included: z.array(z.iso.date()),
		observed_delay_seconds: z.number().nullable().optional(),
		trip_ids: z.array(z.string()).optional(),
		/** Set by the Daily report before it keeps its first few notices. */
		notice_total: z.number().int().nonnegative().optional(),
		alert_messages: z
			.array(
				z.object({
					source: z.string(),
					id: z.string(),
					version: z.string(),
					reissue_ids: z.array(z.string()).optional(),
					routes: z.array(z.string()),
					stops: z.array(z.string()),
					effect: z.string().nullable().optional(),
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
const recordMethod = z.object({
	id: z.string().optional(),
	minimum_sample: count.optional(),
	minimum_coverage: share.optional(),
	ranking_floors: rankingFloors.optional(),
	text: z
		.object({
			en: z.object({ definition: z.string().optional(), counts: z.string(), limits: z.string() }),
			fr: z.object({ definition: z.string().optional(), counts: z.string(), limits: z.string() }),
		})
		.optional(),
});
const recordMeasure = recordEnvelope.extend({
	...recordCell.shape,
	evidence: evidence.extend(recordCell.shape.evidence.shape),
	info: z.array(recordMethod).optional(),
});
const recordSeries = recordEnvelope.extend({
	...state.partial().shape,
	info: z
		.array(
			recordMethod.extend({
				minimum_sample: count,
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
const delayDistribution = recordSeries.extend({
	...state.shape,
	measure: z.literal('delay_distribution'),
	group: z.literal('delay_minute'),
	evidence: evidence.extend(recordCell.shape.evidence.shape),
	cells: z.array(
		recordSeries.shape.cells.element.extend({
			state: z.literal('measured'),
			key: z.object({
				min_seconds: z.int().nullable(),
				max_seconds: z.int().nullable(),
				band: z.enum(['early', 'on_time', 'late']),
			}),
			value: z.object({ delay_distribution: share, stop_events: count }),
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
export type DelayDistribution = z.infer<typeof delayDistribution>;
export type DepartureRanking = z.infer<typeof departureRanking>;
export type RecordAnswer = RecordMeasure | RecordSeries | DepartureRanking | RankingAnswer;

const rankingIdentity = z.object({
	...rateCoverage.shape,
	excluded: recordCounts.optional(),
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
	reference: recordMeasure.optional(),
	available_classes: z.array(z.string()),
	ranked_count: count,
	rows: z.array(
		rankingIdentity.extend({
			rank: count,
			sample: z.number().nonnegative(),
			value: z.number(),
			ranking_bound: z.number().nullable().optional(),
			range: z.object({
				lower: z.number().nullable(),
				upper: z.number().nullable(),
				method: z.string(),
			}),
		}),
	),
	excluded: z.array(rankingIdentity.extend({ reason: exclusionReason, reason_text: bilingual })),
	range_notes: z.record(z.string(), bilingual),
	info: z
		.array(
			z.object({
				minimum_sample: count,
				ranking_minimum_sample: z.number().nonnegative().optional(),
				ranking_floors: rankingFloors.optional(),
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

export function getRecordAnswer(
	{ path, parameters }: RecordQuery,
	period: EnginePeriod,
	order?: RecordOrder,
) {
	const schema: z.ZodType<RecordAnswer> =
		path === '/ranking'
			? parameters.kind === 'departure'
				? departureRanking
				: rankingAnswer
			: parameters.measure === 'delay_distribution'
				? delayDistribution
				: parameters.group
					? recordSeries
					: recordMeasure;
	return periodQuery(path, period, parameters, schema, undefined, order);
}

/** One /measure answer without a group, with its counts by name. */
export function getRecordMeasure(parameters: Record<string, string>, period: EnginePeriod) {
	return periodQuery('/measure', period, parameters, recordMeasure);
}

/** One grouped /measure answer: a cell for each key. */
export function getRecordSeries(parameters: Record<string, string>, period: EnginePeriod) {
	return periodQuery('/measure', period, parameters, recordSeries);
}

type DelayDistributionCuts = Partial<
	Record<'line' | 'direction' | 'stop' | 'hour' | 'day_type' | 'departure', string>
>;

export function getDelayDistribution(period: EnginePeriod, cuts: DelayDistributionCuts = {}) {
	return periodQuery(
		'/measure',
		period,
		{ ...cuts, measure: 'delay_distribution' },
		delayDistribution,
	);
}

export function getVehicleDayAnswers(vehicle: string, period: EnginePeriod) {
	const parameters = { measure: 'vehicles', vehicle };
	const grouped = { ...parameters, group: 'day' };
	const bundle = periodQuery(
		'/measure',
		period,
		{ ...grouped, include_overall: '1' },
		recordSeries.extend({ overall: recordMeasure.optional() }),
	);
	const split = (daily: boolean): Promise<EngineResult<RecordAnswer>> =>
		bundle.then((result) => {
			if (result.kind === 'answer' && result.answer.overall) {
				const { overall, ...days } = result.answer;
				return { ...result, answer: daily ? days : overall };
			}
			if (result.kind === 'answer' || (result.kind === 'unreachable' && result.status === 400))
				return getRecordAnswer(
					{ path: '/measure', parameters: daily ? grouped : parameters },
					period,
				);
			return result;
		});
	return { service: split(false), days: split(true) };
}

// Each scorecard answer has one numeric value or readings by feed, field or horizon.
const scorecardReading = z.union([z.number(), z.literal('over_10_minutes'), z.null()]);
const scorecardValues = z.union([
	scorecardReading,
	z.record(z.string(), z.union([scorecardReading, z.record(z.string(), scorecardReading)])),
]);
const scorecardAnswer = recordEnvelope.extend({
	...recordState.shape,
	value: z.record(z.string(), scorecardValues),
	info: z.array(z.object({ id: z.string(), minimum_sample: count })),
	evidence: evidence.extend({
		counts: z.record(z.string(), z.record(z.string(), z.unknown())),
		dimension_states: z.record(z.string(), z.record(z.string(), recordStateName)),
		capture_gap_days: z.record(z.string(), z.array(z.iso.date())),
		days_not_measured_reasons: z.record(z.iso.date(), z.string()),
	}),
});

export type ScorecardAnswer = z.infer<typeof scorecardAnswer>;

export function getScorecardAnswer({ path, parameters }: RecordQuery, period: EnginePeriod) {
	return periodQuery(path, period, parameters, scorecardAnswer);
}

const finderSeries = recordEnvelope.extend({
	info: recordSeries.shape.info,
	cells: z.array(
		recordSeries.shape.cells.element.extend({
			evidence: rateCoverage.omit({ share_occupancy_readings: true }).extend({
				counts: recordCounts,
				excluded: z.object({ route_without_live_data: count.nullable().optional() }).optional(),
			}),
		}),
	),
});

export type FinderSeries = z.infer<typeof finderSeries>;
export type FinderCell = FinderSeries['cells'][number];

export function getFinderSeries(
	parameters: FinderQuestionParameters,
	period: EnginePeriod,
	signal?: AbortSignal,
) {
	return recordQuery(finderQuestion(parameters, period), finderSeries, period.visitorIp, signal);
}

export async function getRecordCsv(
	{ path, parameters }: RecordQuery,
	period: EnginePeriod,
	lang: 'en' | 'fr',
	requestSignal?: AbortSignal,
) {
	const timeout = AbortSignal.timeout(ENGINE_TIMEOUT_MS);
	return engineFetch(
		periodQuestion(period, path, { ...parameters, format: 'csv', lang }),
		requestSignal ? AbortSignal.any([timeout, requestSignal]) : timeout,
		period.visitorIp,
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
			source_date: z.iso.date().optional(),
			tables: z.record(z.string(), tableHealth),
		}),
	),
});

export type MethodEntry = z.infer<typeof methodCatalog>[number];
export type DataHealthAnswer = z.infer<typeof dataHealth>;
export type TableHealth = z.infer<typeof tableHealth>;

export function getMethodCatalog(visitorIp?: string | null) {
	return query(methodQuestion, methodCatalog, visitorIp);
}

export function getRecordDataHealth(period: EnginePeriod) {
	return recordQuery(dataHealthQuestion(period), dataHealth, period.visitorIp);
}

export function getSearchIndex(city: string, visitorIp?: string | null) {
	return query(cityQuestion(city, '/search-index'), searchIndexSchema, visitorIp);
}

const vehicleIndexSchema = searchIndexSchema.pick({ vehicles: true, vehicle_state: true });

export function getCachedVehicleIndex(
	city: string,
	visitorIp?: string | null,
	signal?: AbortSignal,
) {
	const question = cityQuestion(city, '/search-index');
	question.parameters.cache = 'only';
	return query(question, vehicleIndexSchema, visitorIp, false, signal);
}

export async function getCityCatalog(visitorIp?: string | null) {
	const result = await query(citiesQuestion, CityCatalogSchema, visitorIp);
	if (result.kind !== 'answer') throw new Error('Provider catalog unavailable');
	return result.answer;
}

export async function getScheduleEdition(
	city: string,
	visitorIp?: string | null,
	signal?: AbortSignal,
) {
	const result = await query(scheduleQuestion(city), scheduleIndexSchema, visitorIp, false, signal);
	return result.kind === 'answer' ? result.answer.schedule : null;
}

export async function getScheduleMap(
	city: string,
	lines: readonly string[],
	visitorIp?: string | null,
) {
	const question = cityQuestion(city, '/schedule-map');
	const signal = AbortSignal.timeout(ENGINE_TIMEOUT_MS);
	try {
		let response = await engineFetch(
			{ ...question, parameters: { lines: JSON.stringify(lines) } },
			signal,
			visitorIp,
		);
		// Older engines may reject or ignore the line cut during rollout.
		if (response?.status === 400) response = await engineFetch(question, signal, visitorIp);
		if (!response?.ok) return null;
		const { schedule } = (await response.json()) as {
			schedule?: { date: unknown; route_shapes: Record<string, unknown> };
		};
		if (!schedule?.route_shapes) return null;
		const route_shapes = Object.fromEntries(
			lines
				.filter((line) => Object.hasOwn(schedule.route_shapes, line))
				.map((line) => [line, schedule.route_shapes[line]]),
		);
		const result = scheduleMapSchema.safeParse({ schedule: { date: schedule.date, route_shapes } });
		return result.success ? result.data.schedule : null;
	} catch {
		return null;
	}
}
