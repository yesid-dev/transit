import { expect, it } from 'vitest';
import { mapRecordAnswer } from './recordMapAnswer';
import { recordLayerAnswer } from './recordLayerAnswer';
import { indexCorridorPaths } from './corridorMap';
import {
	highestWaitsByStop,
	overviewCorridors,
	overviewWaits,
	recordColours,
	recordCorridorWidths,
	recordCorridors,
	recordFeatures,
	recordLayerMarks,
	recordMapSampleText,
	recordRampStep,
	recordStopRadii,
	recordStops,
	type RecordMark,
} from './recordMap';

const stops = [
	{ id: 'A', name: 'Alpha', lat: 45.5, lon: -73.6 },
	{ id: 'B', name: 'Bravo', lat: 45.5, lon: -73.59 },
	{ id: 'C', name: 'Charlie', lat: 45.5, lon: -73.58 },
	{ id: 'D', name: 'Delta', lat: 45.5, lon: -73.57 },
];
const evidence = { days_not_measured: [] };

it('keeps separate waits for each line and direction and draws the longest wait per stop', () => {
	const raw = {
		measure: 'excess_wait_time',
		minimum_sample: 20,
		line: ['24', '24', '50', '50'],
		direction: [0, 1, 0, 1],
		stop: ['A', 'A', 'A', 'B'],
		value: [0, -3, 46, null],
		sample: [30, 30, 21, 0],
		state: ['measured', 'measured', 'measured', 'no_frequent_periods'],
		low_coverage: [false, false, true, false],
		evidence,
	};
	const marks = recordLayerMarks(stops, recordLayerAnswer.parse(raw));
	expect(marks.map(({ id, value }) => [id, value])).toEqual([
		['["24",0,"A"]', 0],
		['["24",1,"A"]', -3],
		['["50",0,"A"]', 46],
		['["50",1,"B"]', null],
	]);
	expect(highestWaitsByStop(marks).map(({ value }) => value)).toEqual([46, null]);
	expect(overviewWaits(highestWaitsByStop(marks)).map(({ value }) => value)).toEqual([46]);
	expect(marks[2]?.lowCoverage).toBe(true);
	expect(marks[3]?.readingState).toBe('no_frequent_periods');
	expect(recordLayerAnswer.safeParse({ ...raw, direction: [0] }).success).toBe(false);
	expect(recordLayerAnswer.safeParse({ ...raw, value: [0, -3, 46, 0] }).success).toBe(false);
});

it('ranks measured Waits locations before taking the 300 largest readings', () => {
	const marks = Array.from(
		{ length: 303 },
		(_, index): RecordMark => ({
			id: String(index),
			stop: String(index),
			name: 'Stop ' + index,
			value: index < 302 ? index - 3 : null,
			sample: index < 302 ? 30 : 3,
			state: index < 302 ? 3 : 1,
			geometry: { type: 'Point', coordinates: [-73.6, 45.5] },
		}),
	);
	const byStop = highestWaitsByStop([...marks, { ...marks[301]!, id: 'other-line', value: 60 }]);
	expect(overviewWaits(byStop).map(({ id }) => id)).toEqual(
		Array.from({ length: 300 }, (_, index) => String(301 - index)),
	);
	expect(byStop).toHaveLength(303);
});

it('keeps the clear-run reference and the median for each line on a shared stretch', () => {
	const answer = recordLayerAnswer.parse({
		measure: 'clear_run_time_lost',
		minimum_sample: 20,
		line: ['24', '50'],
		direction: [0, 0],
		from_stop: ['A', 'A'],
		to_stop: ['B', 'B'],
		value: [32, 48],
		sample: [80, 50],
		state: ['measured', 'measured'],
		low_coverage: [false, false],
		clear_run_seconds: [41, 36],
		median_run_seconds: [73, 84],
		evidence,
	});
	const coordinates: [number, number][] = [
		[-73.6, 45.5],
		[-73.595, 45.501],
		[-73.59, 45.5],
	];
	const paths = indexCorridorPaths({
		date: '2026-11-21',
		paths: [['24', 0, 'A', 'B', coordinates]],
	});
	const marks = recordLayerMarks(stops, answer, undefined, paths);
	expect(marks.map(({ id, value, reference, median }) => [id, value, reference, median])).toEqual([
		['["24",0,"A","B"]', 32, 41, 73],
		['["50",0,"A","B"]', 48, 36, 84],
	]);
	expect(marks[0]?.geometry.coordinates).toEqual(coordinates);
	expect(marks[1]?.approximate).toBe(true);
});

it('keeps the 300 measured corridors with the most time lost in a dense overview', () => {
	const marks = Array.from(
		{ length: 1000 },
		(_, value): RecordMark => ({
			id: String(value),
			name: String(value),
			value,
			sample: 30,
			state: 3,
			geometry: {
				type: 'LineString',
				coordinates: [
					[-73.6, 45.5],
					[-73.59, 45.5],
				],
			},
		}),
	);
	expect(overviewCorridors(marks).map(({ value }) => value)).toEqual(
		Array.from({ length: 300 }, (_, index) => 999 - index),
	);
	expect(marks[0]?.value).toBe(0);
	const sparse = marks.slice(0, 4);
	expect(overviewCorridors(sparse)).toBe(sparse);
});

it.each([
	['en', false, 'Low coverage · 110 observed runs', 'No comparable runs observed'],
	['fr', false, 'Faible couverture · 110 parcours observés', 'Aucun parcours comparable observé'],
	['en', true, 'Low coverage · 110 classified stop events', 'No classified stop events'],
	['fr', true, 'Faible couverture · 110 passages classés', 'Aucun passage classé'],
] as const)(
	'explains unmeasured selections in %s with stops=%s',
	(locale, stops, positive, zero) => {
		expect(recordMapSampleText({ state: 0, sample: 110 }, stops, locale)).toBe(positive);
		expect(recordMapSampleText({ state: 0, sample: 0 }, stops, locale)).toBe(zero);
		expect(recordMapSampleText({ state: 0, sample: null }, stops, locale)).toBeNull();
	},
);

it('joins stop readings to the schedule and preserves measured zero and missing values', () => {
	const answer = mapRecordAnswer.parse({
		measure: 'late',
		stop: ['A', 'B'],
		state: [3, 1],
		value: [0, null],
		sample: [40, 10],
		evidence,
	});
	const marks = recordStops(stops, answer, (stop) => stop.id === 'D');
	expect(marks.map(({ name, state, value, sample }) => [name, state, value, sample])).toEqual([
		['Alpha', 3, 0, 40],
		['Bravo', 1, null, 10],
		['Charlie', 0, null, null],
		['Delta', 2, null, null],
	]);
	expect(mapRecordAnswer.safeParse({ ...answer, value: [0, 0] }).success).toBe(false);
	expect(mapRecordAnswer.safeParse({ ...answer, sample: [40] }).success).toBe(false);
});

it('uses a shape between adjacent stops, and a straight segment when a shape is absent', () => {
	const answer = mapRecordAnswer.parse({
		measure: 'mean_time_lost',
		direction: [0, 1],
		from_stop: ['A', 'B'],
		to_stop: ['B', 'A'],
		state: [3, 1],
		value: [-8, null],
		sample: [25, 2],
		evidence,
	});
	const directions = [
		{
			dir: 0,
			stops: [
				{ id: 'A', seq: 0 },
				{ id: 'B', seq: 1 },
				{ id: 'C', seq: 2 },
			],
			shape: {
				type: 'LineString',
				coordinates: [
					[-73.6, 45.5],
					[-73.595, 45.501],
					[-73.59, 45.5],
				],
			},
		},
	];
	const marks = recordCorridors(stops, directions, answer, '', false);
	expect(marks.find((mark) => mark.state === 3)?.geometry.coordinates).toContainEqual([
		-73.595, 45.501,
	]);
	expect(marks.find((mark) => mark.state === 1)?.geometry.coordinates).toEqual([
		[-73.59, 45.5],
		[-73.6, 45.5],
	]);
	expect(marks.find((mark) => mark.state === 0)?.name).toBe('Bravo → Charlie');
	expect(recordCorridors(stops, directions, null, '1', true)).toEqual([]);
});

it('keeps reversed network stop pairs and their serving lines distinct', () => {
	const answer = mapRecordAnswer.parse({
		measure: 'mean_time_lost',
		from_stop: ['A', 'B', 'B', 'C'],
		to_stop: ['B', 'A', 'C', 'D'],
		lines: [['1', '2'], ['2'], ['1'], ['3']],
		state: [3, 1, 0, 2],
		value: [8, null, null, null],
		sample: [40, 6, 0, 0],
		evidence,
	});
	const marks = recordCorridors(stops, [], answer, '', false);
	expect(recordCorridors(stops, [], answer, '0', false)).toEqual(marks);
	expect(
		marks.map(({ name, lines, state, value, sample }) => [name, lines, state, value, sample]),
	).toEqual([
		['Bravo → Charlie', ['1'], 0, null, 0],
		['Bravo → Alpha', ['2'], 1, null, 6],
		['Charlie → Delta', ['3'], 2, null, 0],
		['Alpha → Bravo', ['1', '2'], 3, 8, 40],
	]);
	expect(marks[1]?.geometry.coordinates).toEqual([
		[-73.59, 45.5],
		[-73.6, 45.5],
	]);
	expect(marks[3]?.geometry.coordinates).toEqual([
		[-73.6, 45.5],
		[-73.59, 45.5],
	]);
	expect(mapRecordAnswer.safeParse({ ...answer, lines: [['1']] }).success).toBe(false);
});

it('assigns ordered steps to measured values and keeps absence outside the ramp', () => {
	expect([
		recordRampStep(0, null, true),
		recordRampStep(1, null, true),
		recordRampStep(2, null, true),
	]).toEqual([null, null, null]);
	expect([0, 100, 150, 200, 250].map((value) => recordRampStep(3, value, true))).toEqual([
		0, 1, 2, 3, 4,
	]);
	expect([-1, 0, 0.5, 30, 60, 120].map((value) => recordRampStep(3, value, false))).toEqual([
		0, 0, 1, 2, 3, 4,
	]);
});

it('uses the same neutral ink for all unmeasured states and increasing sizes for measured values', () => {
	const answer = mapRecordAnswer.parse({
		measure: 'late',
		stop: ['A', 'B', 'C', 'D'],
		state: [0, 1, 2, 3],
		sample: [0, 2, 0, 200],
		value: [null, null, null, 200],
		evidence,
	});
	const marks = recordStops(stops, answer, () => false);
	expect(
		recordFeatures(marks, recordColours, true, '#949494').features.map(({ properties }) => [
			properties.step,
			properties.state,
			properties.colour,
		]),
	).toEqual([
		[null, 0, '#949494'],
		[null, 1, '#949494'],
		[null, 2, '#949494'],
		[3, 3, recordColours[3]],
	]);
	for (const sizes of [
		recordStopRadii.network,
		recordStopRadii.waitsNetwork,
		recordStopRadii.detail,
		recordCorridorWidths.network,
		recordCorridorWidths.detail,
	]) {
		expect(sizes.slice(1).every((size, index) => size > sizes[index]!)).toBe(true);
	}
});

it('uses Stops display names in both stop and corridor readings', () => {
	const locations = [
		{ ...stops[0]!, name: "PLACE D'ORLÉANS B" },
		{ ...stops[1]!, name: 'TRIM 1A' },
	];
	expect(recordStops(locations, null, () => false).map(({ name }) => name)).toEqual([
		'Place d’Orléans B',
		'Trim 1A',
	]);
	const answer = mapRecordAnswer.parse({
		measure: 'mean_time_lost',
		from_stop: ['A'],
		to_stop: ['B'],
		state: [3],
		sample: [40],
		value: [42],
		evidence,
	});
	expect(recordCorridors(locations, [], answer, '', false)[0]).toMatchObject({
		fromName: 'Place d’Orléans B',
		toName: 'Trim 1A',
		name: 'Place d’Orléans B → Trim 1A',
		value: 42,
	});
});
