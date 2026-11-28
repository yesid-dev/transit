import { expect, it } from 'vitest';
import { corridorMapAnswer, indexCorridorPaths } from './corridorMap';
import { recordCorridors } from './recordMap';

it('uses a serving line and direction’s cut path and marks missing paths', () => {
	const shaped = [
		[-73.6, 45.5],
		[-73.6, 45.51],
		[-73.59, 45.51],
	];
	const paths = indexCorridorPaths(
		corridorMapAnswer.parse({
			schedule: {
				date: '2026-11-26',
				paths: [
					[
						'other',
						1,
						'a',
						'b',
						[
							[-73.6, 45.5],
							[-73.59, 45.51],
						],
					],
					['24', 1, 'a', 'b', shaped],
				],
			},
		}).schedule!,
	);
	const stops = [
		{ id: 'a', name: 'First', lon: -73.6, lat: 45.5 },
		{ id: 'b', name: 'Second', lon: -73.59, lat: 45.51 },
		{ id: 'c', name: 'Third', lon: -73.58, lat: 45.51 },
	];
	const answer = {
		measure: 'mean_time_lost' as const,
		from_stop: ['a', 'b'],
		to_stop: ['b', 'c'],
		lines: [['24'], ['24']],
		state: [3, 3] as const,
		value: [30, 15],
		sample: [20, 20],
		evidence: { days_not_measured: [] },
	};
	const marks = recordCorridors(
		stops,
		[],
		{ ...answer, state: [...answer.state] },
		'1',
		false,
		paths,
	);
	expect(marks[0]!.geometry.coordinates).toEqual(shaped);
	expect(marks[0]!.approximate).toBeUndefined();
	expect(marks[0]!.value).toBe(30);
	expect(marks[1]!.approximate).toBe(true);
	expect(marks[1]!.geometry.coordinates).toEqual([shaped[2], [-73.58, 45.51]]);
	expect(
		recordCorridors(stops, [], { ...answer, state: [...answer.state] }, '0', false, paths)[0]!
			.approximate,
	).toBe(true);
});
