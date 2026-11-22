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
	| { kind: 'answer'; answer: T }
	| { kind: 'unconfigured' | 'unreachable' | 'timeout' };

type EnginePeriod = DateWindow & { city: string };

async function query<T>(
	path: string,
	{ city, from, to }: EnginePeriod,
	parameters: Record<string, string>,
	schema: z.ZodType<T>,
): Promise<EngineResult<T>> {
	const origin = env.ENGINE_ORIGIN?.trim();
	if (!origin) return { kind: 'unconfigured' };

	const signal = AbortSignal.timeout(ENGINE_TIMEOUT_MS);
	try {
		const url = new URL(path, origin);
		url.search = new URLSearchParams({ city, from, to, ...parameters }).toString();
		const response = await fetch(url, { signal, redirect: 'manual' });
		if (!response.ok) return { kind: 'unreachable' };
		const { success, data } = schema.safeParse(await response.json());
		return success ? { kind: 'answer', answer: data } : { kind: 'unreachable' };
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
