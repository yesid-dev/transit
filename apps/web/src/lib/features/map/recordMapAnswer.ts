import { z } from 'zod';

const count = z.number().int().nonnegative();
const columns = {
	sample: z.array(count),
	state: z.array(z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])),
	evidence: z.object({
		days_not_measured: z.array(z.iso.date()),
		source_date: z.iso.date().optional(),
		method_version: z.string().optional(),
		cleaning_versions: z.array(count).optional(),
	}),
};

export const mapRecordAnswer = z
	.discriminatedUnion('measure', [
		z.object({
			...columns,
			measure: z.literal('late'),
			stop: z.array(z.string()),
			value: z.array(count.max(1000).nullable()),
		}),
		z.object({
			...columns,
			measure: z.literal('mean_time_lost'),
			direction: z.array(z.number().int().nullable()).optional(),
			lines: z.array(z.array(z.string())).optional(),
			from_stop: z.array(z.string()),
			to_stop: z.array(z.string()),
			value: z.array(z.number().nullable()),
		}),
	])
	.refine((answer) => {
		const n = answer.state.length;
		const keys =
			answer.measure === 'late'
				? [answer.stop]
				: [
						answer.from_stop,
						answer.to_stop,
						...(answer.direction ? [answer.direction] : []),
						...(answer.lines ? [answer.lines] : []),
					];
		return (
			[answer.value, answer.sample, ...keys].every((column) => column.length === n) &&
			answer.state.every((state, i) => (state === 3) === (answer.value[i] !== null))
		);
	});

export type MapRecordAnswer = z.infer<typeof mapRecordAnswer>;
export type MapRecordState = MapRecordAnswer['state'][number];
