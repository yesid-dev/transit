import { z } from 'zod';

const coordinate = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

export const corridorMapAnswer = z.object({
	schedule: z
		.object({
			date: z.iso.date(),
			paths: z.array(
				z.tuple([
					z.string(),
					z.union([z.literal(0), z.literal(1)]),
					z.string(),
					z.string(),
					z.array(coordinate).min(2),
				]),
			),
		})
		.nullable(),
});

type CorridorMap = NonNullable<z.infer<typeof corridorMapAnswer>['schedule']>;
type CorridorPath = CorridorMap['paths'][number];
export type CorridorIndex = ReadonlyMap<string, readonly CorridorPath[]>;
const pairKey = (from: string, to: string) => JSON.stringify([from, to]);

export function indexCorridorPaths({ paths }: CorridorMap): CorridorIndex {
	const index = new Map<string, CorridorPath[]>();
	for (const path of paths) {
		const key = pairKey(path[2], path[3]);
		const candidates = index.get(key);
		if (candidates) candidates.push(path);
		else index.set(key, [path]);
	}
	return index;
}

export function corridorPath(
	index: CorridorIndex | null | undefined,
	from: string,
	to: string,
	lines: readonly string[] | undefined,
	direction: string,
) {
	return index
		?.get(pairKey(from, to))
		?.find(
			([line, dir]) =>
				(!lines?.length || lines.includes(line)) && (!direction || String(dir) === direction),
		)?.[4];
}
