import { z } from 'zod';

const count = z.number().int().nonnegative();
const seconds = z.number();
const idColumn = z.array(z.string().min(1));
const state = z.enum([
	'measured',
	'not_measured',
	'unknown',
	'too_few_to_judge',
	'no_live_data',
	'no_frequent_periods',
]);
const columns = {
	minimum_sample: count,
	line: idColumn,
	direction: z.array(z.union([z.literal(0), z.literal(1), z.null()])),
	value: z.array(seconds.nullable()),
	sample: z.array(count),
	state: z.array(state),
	low_coverage: z.array(z.boolean()),
	evidence: z.object({
		days_not_measured: z.array(z.iso.date()),
		source_date: z.iso.date().optional(),
	}),
};

export const recordLayerAnswer = z
	.discriminatedUnion('measure', [
		z.object({
			...columns,
			measure: z.literal('clear_run_time_lost'),
			from_stop: idColumn,
			to_stop: idColumn,
			clear_run_seconds: z.array(seconds.nullable()),
			median_run_seconds: z.array(seconds.nullable()),
		}),
		z.object({
			...columns,
			measure: z.literal('excess_wait_time'),
			stop: idColumn,
		}),
	])
	.refine((answer) => {
		const { direction, line, low_coverage, sample, state, value } = answer;
		const extra =
			answer.measure === 'clear_run_time_lost'
				? [answer.from_stop, answer.to_stop, answer.clear_run_seconds, answer.median_run_seconds]
				: [answer.stop];
		return (
			[direction, line, low_coverage, sample, value, ...extra].every(
				(column) => column.length === state.length,
			) && state.every((reading, index) => (reading === 'measured') === (value[index] !== null))
		);
	});

export type RecordLayerAnswer = z.infer<typeof recordLayerAnswer>;
export type RecordLayerState = z.infer<typeof state>;
