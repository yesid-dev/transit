import { describe, it, expect } from 'vitest';
import { directionLabel } from '#lib/site/presenter.ts';
import { directionHeadsigns } from './directions';

describe('directionHeadsigns', () => {
	it('maps each direction_id to its FIRST non-empty headsign (the canonical short label)', () => {
		const map = directionHeadsigns([
			{ dir: 0, headsign: 'Est' },
			{ dir: 0, headsign: 'Est destination Station Snowdon' },
			{ dir: 1, headsign: 'Ouest' },
		]);
		expect(map).toEqual({ 0: 'Est', 1: 'Ouest' });
	});

	it('skips empty / whitespace headsigns + null dirs, and is honest-empty for no data', () => {
		expect(
			directionHeadsigns([
				{ dir: 0, headsign: '   ' },
				{ dir: 1, headsign: null },
			]),
		).toEqual({});
		expect(directionHeadsigns(undefined)).toEqual({});
		expect(directionHeadsigns(null)).toEqual({});
		expect(directionHeadsigns([])).toEqual({});
	});

	it('labels a direction without a headsign by its last scheduled stop in either language', () => {
		const signs = directionHeadsigns(
			[
				{
					dir: 1,
					headsign: '   ',
					stops: [
						{ id: 'terminal', seq: 30 },
						{ id: 'first', name: 'Rosemont', seq: 10 },
					],
				},
				{ dir: 0, stops: [{ id: 'missing', seq: 1 }] },
			],
			new Map([['terminal', 'Station Côte-Vertu']]),
		);
		expect(directionLabel(1, signs, 'en')).toBe('Toward Station Côte-Vertu');
		expect(directionLabel(1, signs, 'fr')).toBe('Vers Station Côte-Vertu');
		expect(directionLabel(0, signs, 'en')).toBe('Unknown direction');
	});

	it('prefers a published headsign over any terminal inferred for the same direction', () => {
		const signs = directionHeadsigns(
			[
				{ dir: 1, stops: [{ id: 'terminal', name: 'Rosemont', seq: 2 }] },
				{ dir: 1, headsign: '  Station Laurier  ' },
				{ dir: 0, stops: [{ id: 'first', name: 'PLACE D’ORLÉANS B', seq: 1 }] },
			],
			new Map(),
		);
		expect(signs).toEqual({ 0: 'Place d’Orléans B', 1: 'Station Laurier' });
	});
});
