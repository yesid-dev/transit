import { expect, it } from 'vitest';
import { sortAlertLineCut } from './alertCards';

it('ranks line counts before natural published line numbers and keeps unavailable values last', () => {
	const numbers: Record<string, string> = {
		'route-10': '10',
		'route-2': '2',
		'route-1': '1',
		'route-80': '80',
		'route-24': '24',
	};
	const rows = [
		{ key: 'route-10', value: 11 },
		{ key: 'route-2', value: 11 },
		{ key: 'route-1', value: 10 },
		{ key: 'route-80', value: 12 },
		{ key: 'route-24', value: null },
	];
	expect(sortAlertLineCut(rows, 'fr', (id) => numbers[id]).map(({ key }) => key)).toEqual([
		'route-80',
		'route-2',
		'route-10',
		'route-1',
		'route-24',
	]);
});
