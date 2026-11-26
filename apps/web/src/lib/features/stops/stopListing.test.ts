import { expect, it } from 'vitest';
import type { ScheduleEdition } from '#lib/search/searchIndex.ts';
import { listStops, stopLineCodes, stopReading } from './stopListing.ts';

const schedule: ScheduleEdition = {
	date: '2026-11-10',
	routes: [{ id: 'L51', short: '51', long: 'Édouard-Montpetit', type: 3 }],
	stops: Array.from({ length: 25 }, (_, index) => ({
		id: `stop-${index + 1}`,
		name: `Laurier ${index + 1}`,
		code: String(52847 + index),
		lat: 45.5,
		lon: -73.6,
		routes: ['L51'],
	})),
	route_directions: {
		L51: [
			{
				dir: 0,
				stops: [
					{ id: 'retired', seq: 1 },
					{ id: 'stop-23', seq: 2 },
				],
			},
		],
	},
};

it.each(['en', 'fr'] as const)('orders unique line plates like numbers in %s', (locale) => {
	expect(stopLineCodes(['105', '51A', '51', '51'], locale)).toEqual(['51', '51A', '105']);
});

it.each(['en', 'fr'] as const)(
	'pages the current timetable and filters by name, code or line in %s',
	(locale) => {
		const first = listStops(schedule, new URLSearchParams(), locale);
		expect(first.total).toBe(25);
		expect(first.rows).toHaveLength(20);
		expect(first.rows[0]?.id).toBe('stop-1');
		expect(listStops(schedule, new URLSearchParams('shown=25'), locale).rows.at(-1)?.id).toBe(
			'stop-25',
		);
		expect(
			listStops(schedule, new URLSearchParams('q=52847'), locale).rows.map(({ id }) => id),
		).toEqual(['stop-1']);
		expect(listStops(schedule, new URLSearchParams('q=Edouard'), locale).total).toBe(25);
		const line = listStops(schedule, new URLSearchParams('route=L51'), locale);
		expect(line.total).toBe(25);
		expect(line.rows[0]?.id).toBe('stop-23');
		expect(listStops(schedule, new URLSearchParams('q=retired'), locale).total).toBe(0);
	},
);

it('shows a reported count and its minimum without an on-time share for a small sample', () => {
	expect(
		stopReading(
			{
				state: 'too_few_to_judge',
				key: { stop: '1' },
				value: { on_time: 0 },
				evidence: { counts: { classified: 3, on_time: 0 } },
				state_text: { en: '', fr: '' },
			},
			{ info: [{ id: 'on_time', minimum_sample: 30 }] },
		),
	).toEqual({ state: 'too_few_to_judge', share: null, events: 3, onTime: null, minimum: 30 });
});

it.each([
	['unknown', null],
	['measured', 0],
] as const)('gives a zero count only when it was measured (%s)', (state, events) => {
	expect(
		stopReading({
			state,
			key: { stop: '1' },
			value: { on_time: null },
			evidence: { counts: { classified: 0, on_time: 0 } },
			state_text: { en: '', fr: '' },
		}).events,
	).toBe(events);
});
