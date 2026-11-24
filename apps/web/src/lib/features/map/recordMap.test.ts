import { expect, it } from 'vitest';
import { mapRecordAnswer } from './recordMapAnswer';
import { recordColourIndex, recordColours, recordCorridors, recordStops } from './recordMap';

const stops = [
	{ id: 'A', name: 'Alpha', lat: 45.5, lon: -73.6 },
	{ id: 'B', name: 'Bravo', lat: 45.5, lon: -73.59 },
	{ id: 'C', name: 'Charlie', lat: 45.5, lon: -73.58 },
	{ id: 'D', name: 'Delta', lat: 45.5, lon: -73.57 },
];
const evidence = { days_not_measured: [] };

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

it('assigns separate legend marks to every non-value state and readable theme colours', () => {
	expect([
		recordColourIndex(0, null, true),
		recordColourIndex(1, null, true),
		recordColourIndex(2, null, true),
	]).toEqual([4, 5, 6]);
	expect([0, 100, 250, 500].map((value) => recordColourIndex(3, value, true))).toEqual([
		0, 1, 2, 3,
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
		for (const colour of palette) {
			const light = Math.max(luminance(colour), luminance(background));
			const dark = Math.min(luminance(colour), luminance(background));
			expect((light + 0.05) / (dark + 0.05)).toBeGreaterThanOrEqual(3);
		}
	}
});
