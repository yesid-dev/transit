import type { MapRecordAnswer, MapRecordState } from './recordMapAnswer';
import type { RouteDirection, StopIndexEntry } from '#lib/v1/schemas/index.ts';
import type { Locale } from '#lib/i18n/index.ts';
import { choose, lowCoverageLabel, tally } from '#lib/features/record/recordText.ts';
import { measureRamps } from '#lib/components/dataviz/measureRamps.ts';
import { corridorPath, type CorridorIndex } from './corridorMap';

export type RecordMapLayer = 'live' | 'stops' | 'corridors';
export const OTHER_STOPS_MIN_ZOOM = 13;
export const ALL_CORRIDORS_MIN_ZOOM = 13;
const NETWORK_CORRIDOR_LIMIT = 300;
type Coordinate = [number, number];
type Geometry =
	| { type: 'Point'; coordinates: Coordinate }
	| { type: 'LineString'; coordinates: Coordinate[] };
export interface RecordMark {
	id: string;
	name: string;
	fromName?: string;
	fromStop?: string;
	toName?: string;
	stop?: string;
	main?: boolean;
	direction?: number | null;
	lines?: readonly string[];
	value: number | null;
	sample: number | null;
	state: MapRecordState;
	approximate?: boolean;
	geometry: Geometry;
}

export type RecordFeatures = {
	type: 'FeatureCollection';
	features: {
		type: 'Feature';
		geometry: Geometry;
		properties: {
			id: string;
			state: MapRecordState;
			colour: string;
			step: number | null;
			offset: number;
			main: boolean;
			approximate?: boolean;
		};
	}[];
};

export const recordColours = {
	stops: measureRamps.lateShare,
	corridors: measureRamps.timeLost,
};

export const recordStopRadii = {
	network: [2.5, 3.25, 4, 5, 6],
	detail: [4.5, 5.5, 6.5, 7.75, 9],
} as const;

export const recordCorridorWidths = {
	network: [1, 1.5, 2.125, 3, 4.25],
	detail: [2, 3, 4, 5.5, 7],
} as const;

export const recordUnmeasuredLine = {
	width: 2,
	dashes: [
		[1, 1.8],
		[3, 1.5],
		[5, 3],
	],
} as const;

const stopLateShareCuts = [100, 150, 200, 250];
const corridorLossCuts = [30, 60, 120];

export function recordRampStep(state: MapRecordState, value: number | null, stops: boolean) {
	if (state !== 3 || value === null) return null;
	if (!stops && value <= 0) return 0;
	const cuts = stops ? stopLateShareCuts : corridorLossCuts;
	const slot = cuts.findIndex((cut) => value < cut);
	return (slot === -1 ? cuts.length : slot) + (stops ? 0 : 1);
}

export function recordStopIsVisible(mark: Pick<RecordMark, 'main'>, zoom: number): boolean {
	return mark.main === true || zoom >= OTHER_STOPS_MIN_ZOOM;
}

/** Keep the most time lost legible when neighbouring corridors overlap. */
export function overviewCorridors(marks: readonly RecordMark[]): readonly RecordMark[] {
	if (marks.length <= NETWORK_CORRIDOR_LIMIT) return marks;
	const measured = marks.filter((mark) => mark.state === 3 && mark.value !== null);
	if (!measured.length) return marks;
	return measured.sort((a, b) => b.value! - a.value!).slice(0, NETWORK_CORRIDOR_LIMIT);
}

export function scheduleTerminals(
	directions: Readonly<Record<string, readonly Pick<RouteDirection, 'stops'>[]>> | undefined,
): ReadonlySet<string> {
	const terminals = new Set<string>();
	for (const variants of Object.values(directions ?? {})) {
		for (const { stops } of variants) {
			if (!stops?.length) continue;
			terminals.add(stops[0]!.id);
			terminals.add(stops[stops.length - 1]!.id);
		}
	}
	return terminals;
}

export function recordMapSampleText(
	{ state, sample }: Pick<RecordMark, 'state' | 'sample'>,
	stops: boolean,
	locale: Locale,
) {
	if (sample === null) return null;
	if (state === 0 && sample === 0) {
		return stops
			? choose(locale, 'No classified stop events', 'Aucun passage classé')
			: choose(locale, 'No comparable runs observed', 'Aucun parcours comparable observé');
	}
	const count = tally(sample, locale);
	const unit = stops
		? choose(locale, 'classified stop events', 'passages classés')
		: choose(locale, 'observed runs', 'parcours observés');
	const reading = `${count} ${unit}`;
	return state === 0 ? `${lowCoverageLabel[locale]} · ${reading}` : reading;
}

const pairId = (dir: number | null, from: string, to: string) => JSON.stringify([dir, from, to]);
const location = (stop: StopIndexEntry): Coordinate => [stop.lon, stop.lat];

function shapeSection(path: unknown, from: Coordinate, to: Coordinate): Coordinate[] | undefined {
	if (!Array.isArray(path)) return undefined;
	const points = path.filter(
		(point): point is Coordinate =>
			Array.isArray(point) && point.length === 2 && point.every(Number.isFinite),
	);
	if (points.length < 2) return undefined;
	function nearest(point: Coordinate) {
		let result = { index: 0, offset: 0, point, distance: Infinity };
		for (let i = 0; i < points.length - 1; i++) {
			const a = points[i]!;
			const b = points[i + 1]!;
			const dx = b[0] - a[0];
			const dy = b[1] - a[1];
			const scale = Math.cos((point[1] * Math.PI) / 180) ** 2;
			const length = dx * dx * scale + dy * dy;
			const offset = length
				? Math.max(
						0,
						Math.min(1, ((point[0] - a[0]) * dx * scale + (point[1] - a[1]) * dy) / length),
					)
				: 0;
			const projected: Coordinate = [a[0] + dx * offset, a[1] + dy * offset];
			const distance = (point[0] - projected[0]) ** 2 * scale + (point[1] - projected[1]) ** 2;
			if (distance < result.distance) result = { index: i, offset, point: projected, distance };
		}
		return result;
	}
	const first = nearest(from);
	const last = nearest(to);
	// GTFS shapes travel in trip order. A mismatched or looped shape can fall back to a chord.
	if (first.index + first.offset >= last.index + last.offset) return undefined;
	return [from, first.point, ...points.slice(first.index + 1, last.index + 1), last.point, to];
}

type Reading = Pick<RecordMark, 'state' | 'sample' | 'value' | 'lines'>;
const absent: Reading = { state: 0, sample: null, value: null };

function readings(answer: MapRecordAnswer | null): Map<string, Reading> {
	const rows = new Map<string, Reading>();
	if (!answer) return rows;
	answer.state.forEach((state, i) => {
		const id =
			answer.measure === 'late'
				? answer.stop[i]!
				: pairId(answer.direction?.[i] ?? null, answer.from_stop[i]!, answer.to_stop[i]!);
		rows.set(id, {
			state,
			sample: answer.sample[i]!,
			value: answer.value[i]!,
			...(answer.measure === 'mean_time_lost' && answer.lines ? { lines: answer.lines[i] } : {}),
		});
	});
	return rows;
}

export function recordStops(
	stops: readonly StopIndexEntry[],
	answer: MapRecordAnswer | null,
	scheduleOnly: (stop: StopIndexEntry) => boolean,
	terminals?: ReadonlySet<string>,
): RecordMark[] {
	const rows = readings(answer);
	return stops.map((stop) => ({
		id: stop.id,
		stop: stop.id,
		main:
			(stop.routes?.length ?? 0) > 1 ||
			stop.mode === 'metro' ||
			stop.mode === 'rail' ||
			terminals?.has(stop.id) === true,
		name: stop.name,
		geometry: { type: 'Point', coordinates: location(stop) },
		...(rows.get(stop.id) ?? { ...absent, state: scheduleOnly(stop) ? 2 : 0 }),
	}));
}

export function recordCorridors(
	stops: readonly StopIndexEntry[],
	directions: readonly RouteDirection[],
	answer: MapRecordAnswer | null,
	direction: string,
	scheduleOnly: boolean,
	paths?: CorridorIndex | null,
): RecordMark[] {
	const rows = readings(answer);
	const byId = new Map(stops.map((stop) => [stop.id, stop]));
	const pairs = new Map<string, RecordMark>();
	// Network readings already apply the direction cut before pooling the stop pairs.
	const shapeDirection = answer?.measure === 'mean_time_lost' && !answer.direction ? '' : direction;
	function add(dir: number | null, fromId: string, toId: string, variant?: RouteDirection) {
		if (shapeDirection && String(dir) !== shapeDirection) return;
		const id = pairId(dir, fromId, toId);
		const from = byId.get(fromId);
		const to = byId.get(toId);
		if (!from || !to || fromId === toId || pairs.has(id)) return;
		const reading = rows.get(id);
		const section =
			dir === null
				? corridorPath(paths, fromId, toId, reading?.lines, direction)
				: shapeSection(variant?.shape?.coordinates, location(from), location(to));
		pairs.set(id, {
			id,
			name: `${from.name} → ${to.name}`,
			fromName: from.name,
			fromStop: from.id,
			toName: to.name,
			direction: dir,
			...(!section ? { approximate: true } : {}),
			geometry: {
				type: 'LineString',
				coordinates: section ?? [location(from), location(to)],
			},
			...(reading ?? { ...absent, state: scheduleOnly ? 2 : 0 }),
		});
	}
	for (const variant of [...directions].sort(
		(a, b) => Number(Boolean(b.shape)) - Number(Boolean(a.shape)),
	)) {
		const ordered = variant.stops ?? [];
		for (let i = 1; i < ordered.length; i++)
			add(variant.dir, ordered[i - 1]!.id, ordered[i]!.id, variant);
	}
	if (answer?.measure === 'mean_time_lost') {
		answer.from_stop.forEach((from, i) =>
			add(answer.direction?.[i] ?? null, from, answer.to_stop[i]!),
		);
	}
	return [...pairs.values()].sort((a, b) => a.state - b.state);
}

export function recordFeatures(
	marks: readonly RecordMark[],
	colours: readonly string[],
	stops: boolean,
	mutedInk: string,
): RecordFeatures {
	return {
		type: 'FeatureCollection',
		features: marks.map(({ id, geometry, state, value, direction, main, approximate }) => {
			const step = recordRampStep(state, value, stops);
			return {
				type: 'Feature',
				geometry,
				properties: {
					id,
					state,
					main: main === true,
					...(approximate ? { approximate: true } : {}),
					step,
					colour: step === null ? mutedInk : colours[step]!,
					offset: direction == null ? 0 : 3,
				},
			};
		}),
	};
}
