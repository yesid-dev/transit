import type { ScheduleEdition } from '#lib/search/searchIndex.ts';
import type { RouteStop } from '#lib/v1/schemas/route.ts';

export const compassPoint = /^(est|ouest|nord|sud|east|west|north|south)$/iu;
/** A compass headsign, alone or with the street it runs on ("Est", "Est via Jarry"). */
export const compassSign = /^(est|ouest|nord|sud|east|west|north|south)(\s+via\s+\S.*)?$/iu;
/** One spelling for a headsign: agencies sometimes publish a double space ("Sud via  Perras"). */
export const signKey = (sign: string) => sign.trim().replace(/\s+/gu, ' ').toLowerCase();

export type LinePattern = {
	ends?: [string, string];
	termini: Record<string, string>;
};

function stopsAtEnds(stops?: RouteStop[]) {
	const ordered = [...(stops ?? [])].sort((a, b) => a.seq - b.seq);
	return [ordered[0], ordered.at(-1)];
}

/** `only` limits the result to some lines; 'all' or nothing gives every line. */
export function linePatterns(
	schedule: ScheduleEdition,
	only?: string | ReadonlySet<string> | 'all',
) {
	const wanted =
		only == null || only === 'all' ? null : typeof only === 'string' ? new Set([only]) : only;
	const stops = new Map(schedule.stops.map(({ id, name }) => [id, name]));
	const patterns: Record<string, LinePattern> = Object.create(null);
	for (const [line, directions] of Object.entries(schedule.route_directions ?? {})) {
		if (wanted && !wanted.has(line)) continue;
		const branches = directions.map(({ dir, headsign, stops: pattern }) => ({
			dir,
			headsign: headsign?.trim(),
			length: pattern?.length ?? 0,
			ends: stopsAtEnds(pattern).map((stop) => stop && (stops.get(stop.id) ?? stop.name)?.trim()),
		}));
		// The index publishes one representative pattern per headsign, without trip counts.
		// Use the longest pattern in the timetable's first direction that has named ends.
		const main = branches
			.filter(({ ends }) => ends[0] && ends[1])
			.sort((a, b) => a.dir - b.dir || b.length - a.length)[0];
		const termini = new Map<string, string | null>();
		for (const {
			headsign,
			ends: [, end],
		} of branches) {
			const sign = headsign && signKey(headsign);
			if (!sign || !compassSign.test(sign) || !end) continue;
			termini.set(sign, termini.has(sign) && termini.get(sign) !== end ? null : end);
		}
		const [first, last] = main?.ends ?? [];
		// Named destination headsigns often omit platform names and already read well.
		const origin = branches.find(({ dir }) => dir === 1)?.headsign;
		const destination = branches.find(({ dir }) => dir === 0)?.headsign;
		const ends: LinePattern['ends'] =
			branches.length === 2 &&
			origin &&
			destination &&
			!compassPoint.test(origin) &&
			!compassPoint.test(destination)
				? [origin, destination]
				: first && last
					? [first, last]
					: undefined;
		patterns[line] = {
			ends,
			termini: Object.fromEntries(
				[...termini].filter((entry): entry is [string, string] => entry[1] != null),
			),
		};
	}
	return patterns;
}
