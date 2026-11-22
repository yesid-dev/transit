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
const rankingAnswer = state.partial().extend({
	measure: z.literal('on_time'),
	kind: z.enum(['line', 'stop']),
	class: z.string().nullable(),
	rows: z.array(
		z.object({
			id: z.string(),
			rank: count,
			value: share,
			sample: count,
			range: z.object({ lower: share, upper: share, method: z.string() }),
		}),
	),
	excluded: z.array(z.object({ reason: engineState, reason_text: bilingual })),
	coverage_note: bilingual.nullable(),
	info: z.array(z.object({ minimum_sample: count })).nonempty(),
	evidence,
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
	{ city, from, to, visitorIp }: EnginePeriod,
	parameters: Record<string, string>,
	signal: AbortSignal,
) {
	const proxy = env.QUESTION_PROXY;
	const fixture = env.QUESTION_FIXTURE_ORIGIN;
	if (!proxy && !fixture) return null;
	const url = new URL(`/v2/${encodeURIComponent(city)}${path}`, proxy ? QUESTION_ORIGIN : fixture);
	url.search = new URLSearchParams({ from, to, ...parameters }).toString();
	const headers = proxy && visitorIp ? { 'x-transit-visitor-ip': visitorIp } : undefined;
	const request = new Request(url, { headers, signal, redirect: 'manual' });
	return proxy ? proxy.fetch(request) : fetch(request);
}

async function query<T>(
	path: string,
	period: EnginePeriod,
	parameters: Record<string, string>,
	schema: z.ZodType<T>,
): Promise<EngineResult<T>> {
	const signal = AbortSignal.timeout(ENGINE_TIMEOUT_MS);
	try {
		const response = await engineFetch(path, period, parameters, signal);
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

export function getMeasure(measure: MeasureAnswer['measure'], period: EnginePeriod) {
	return query('/measure', period, { measure }, measureAnswer);
}

export function getRanking(kind: RankingAnswer['kind'], period: EnginePeriod) {
	return query('/ranking', period, { kind, measure: 'on_time', limit: '3' }, rankingAnswer);
}

const recordCounts = z.record(z.string(), z.number().nullable().catch(null));
const recordCell = state.extend({
	value: z.record(z.string(), z.number().nullable()),
	evidence: z.object({
		counts: recordCounts,
		days_included: z.array(z.iso.date()),
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
});
const recordSeries = recordEnvelope.extend({
	...state.partial().shape,
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
export type RecordAnswer = RecordMeasure | RecordSeries | DepartureRanking;
export type RecordQuery = {
	path: '/measure' | '/ranking';
	parameters: Record<string, string>;
};

export function getRecordAnswer({ path, parameters }: RecordQuery, period: EnginePeriod) {
	const schema: z.ZodType<RecordAnswer> =
		path === '/ranking' ? departureRanking : parameters.group ? recordSeries : recordMeasure;
	return query(path, period, parameters, schema);
}

export async function getRecordCsv(
	{ path, parameters }: RecordQuery,
	period: EnginePeriod,
	lang: 'en' | 'fr',
) {
	return engineFetch(
		path,
		period,
		{ ...parameters, format: 'csv', lang },
		AbortSignal.timeout(ENGINE_TIMEOUT_MS),
	);
}
