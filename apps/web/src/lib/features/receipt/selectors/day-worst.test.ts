import { createLineDirectory } from '#lib/site/lineDirectory.ts';
import { describe, it, expect } from 'vitest';
import { selectWorstOfDay } from './day-worst';

const labels = {
	directory: createLineDirectory(null, { line: (id) => `Line ${id}` }),
	stopName: (id: string, name: string | null | undefined) => name ?? `Stop ${id}`,
	routeLabel: 'Worst line',
	stopLabel: 'Worst stop',
	routeDeltaLabel: 'On-time vs network',
	stopDelayLabel: 'Average delay',
	fmtDelta: (v: number | null | undefined) =>
		v == null ? 'no data' : `${v > 0 ? '+' : ''}${v} pts`,
	fmtMin: (v: number | null | undefined) => (v == null ? 'no data' : `${v} min`),
};

describe('selectWorstOfDay', () => {
	it('builds both worst rows with resolved title/subtitle/meta', () => {
		const vm = selectWorstOfDay(
			{
				worstRoute: { id: '161', name: 'Van Horne', onTimeDeltaPts: -8 },
				worstStop: { id: '57191', name: 'Rockland', meanDelayMin: 6.1 },
			},
			labels,
		);
		expect(vm.hasWorst).toBe(true);
		expect(vm.route?.title).toBe('Van Horne');
		expect(vm.route?.subtitle).toBe('Worst line');
		expect(vm.route?.meta).toBe('On-time vs network -8 pts');
		expect(vm.stop?.meta).toBe('Average delay 6.1 min');
	});

	it('stands the panel down when neither worst entity carries an id', () => {
		const vm = selectWorstOfDay({ worstRoute: null, worstStop: null }, labels);
		expect(vm.hasWorst).toBe(false);
		expect(vm.route).toBeNull();
		expect(vm.stop).toBeNull();
	});

	it('drops a worst entity that has no id (never a linkless row)', () => {
		const vm = selectWorstOfDay(
			{
				worstRoute: { id: '', name: 'x', onTimeDeltaPts: -1 },
				worstStop: { id: '40001', name: null, meanDelayMin: 7.8 },
			},
			labels,
		);
		expect(vm.route).toBeNull();
		expect(vm.stop?.title).toBe('Stop 40001');
		expect(vm.hasWorst).toBe(true);
	});
});
it('ladder rows lead with the line number', () => {
	const directory = createLineDirectory(
		[{ id: '1-373', short: '1', long: 'Confederation', type: 1 }],
		{ line: (id) => `Line ${id}` },
	);
	const result = selectWorstOfDay(
		{
			worstRoute: { id: '1-373', name: 'Confederation', onTimeDeltaPts: null },
			worstStop: null,
		},
		{ ...labels, directory },
	);
	expect(result.route?.title).toBe('1 · Confederation');
	expect(result.route?.subtitle).toBe('Worst line');
});
