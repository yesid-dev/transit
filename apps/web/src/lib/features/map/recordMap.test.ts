import { expect, it } from 'vitest';
import { mapRecordAnswer } from './recordMapAnswer';
import {
	recordColourIndex,
	recordColours,
	recordCorridors,
	recordMapSampleText,
	recordStopIsVisible,
	recordStops,
	scheduleTerminals,
} from './recordMap';

const stops = [
	{ id: 'A', name: 'Alpha', lat: 45.5, lon: -73.6 },
	{ id: 'B', name: 'Bravo', lat: 45.5, lon: -73.59 },
	{ id: 'C', name: 'Charlie', lat: 45.5, lon: -73.58 },
	{ id: 'D', name: 'Delta', lat: 45.5, lon: -73.57 },
];
const evidence = { days_not_measured: [] };

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

it('assigns separate legend marks to every non-value state and readable theme colours', () => {
	expect([
		recordColourIndex(0, null, true),
		recordColourIndex(1, null, true),
		recordColourIndex(2, null, true),
	]).toEqual([5, 6, 7]);
	expect([0, 100, 150, 200, 250].map((value) => recordColourIndex(3, value, true))).toEqual([
		0, 1, 2, 3, 4,
	]);
	expect([-1, 0, 0.5, 30, 60, 120].map((value) => recordColourIndex(3, value, false))).toEqual([
		0, 0, 1, 2, 3, 4,
	]);
	const luminance = (hex: string) =>
		[0.2126, 0.7152, 0.0722].reduce((sum, weight, channel) => {
			const srgb = Number.parseInt(hex.slice(1 + channel * 2, 3 + channel * 2), 16) / 255;
			return sum + weight * (srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4);
		}, 0);
	for (const [palette, background] of [
		[recordColours.light, '#ffffff'],
		[recordColours.dark, '#20232a'],
	] as const) {
		const ramp = palette.slice(0, 5).map(luminance);
		const ordered = [...ramp].sort((a, b) => (background === '#ffffff' ? b - a : a - b));
		expect(ramp).toEqual(ordered);
		for (const colour of palette) {
			const light = Math.max(luminance(colour), luminance(background));
			const dark = Math.min(luminance(colour), luminance(background));
			expect((light + 0.05) / (dark + 0.05)).toBeGreaterThanOrEqual(3);
		}
	}
});

it('keeps terminal, transfer and rail stops at network zoom and adds other stops on zoom in', () => {
	const terminalIds = scheduleTerminals({
		line: [
			{
				stops: [
					{ id: 'A', seq: 1 },
					{ id: 'B', seq: 2 },
					{ id: 'C', seq: 3 },
				],
			},
		],
	});
	const marks = recordStops(
		[
			...stops,
			{ id: 'E', name: 'Transfer', lat: 45.5, lon: -73.56, routes: ['1', '2'] },
			{ id: 'F', name: 'Rail', lat: 45.5, lon: -73.55, mode: 'rail' },
		],
		null,
		() => false,
		terminalIds,
	);
	expect(marks.filter((mark) => recordStopIsVisible(mark, 12.99)).map(({ id }) => id)).toEqual([
		'A',
		'C',
		'E',
		'F',
	]);
	expect(marks.filter((mark) => recordStopIsVisible(mark, 13))).toEqual(marks);
});
