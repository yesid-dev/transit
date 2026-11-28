import { expect, it, vi } from 'vitest';
import { setRecordPerspective } from './mapCamera';
import { recordExtrusions } from './recordExtrusions';
import { recordFeatures, type RecordMark } from './recordMap';

it('raises stretches in proportion to time lost and reuses the flat map colours', () => {
	const measured: RecordMark = {
		id: 'short',
		name: 'First stretch',
		value: 9,
		sample: 24,
		state: 3,
		geometry: {
			type: 'LineString',
			coordinates: [
				[-73.6, 45.5],
				[-73.6, 45.5],
				[-73.59, 45.51],
				[-73.58, 45.52],
			],
		},
	};
	const marks: RecordMark[] = [
		measured,
		{ ...measured, id: 'long', value: 36 },
		{ ...measured, id: 'no-loss', value: 0 },
		{ ...measured, id: 'not-measured', value: null, state: 0 },
	];
	const flat = recordFeatures(marks, ['#aaa', '#888', '#666', '#444', '#222'], false, '#555');
	const values = new Map(marks.map(({ id, value }) => [id, value]));
	const raised = recordExtrusions(flat, (id) => values.get(id)).features;
	expect(raised.map(({ properties }) => properties.id)).toEqual(['short', 'long']);
	expect(raised.map(({ properties }) => properties.height)).toEqual([36, 144]);
	expect(raised.map(({ properties }) => properties.colour)).toEqual(
		flat.features.slice(0, 2).map(({ properties }) => properties.colour),
	);
	expect(raised[0].geometry.coordinates).toHaveLength(2);
	for (const [ring] of raised[0].geometry.coordinates) {
		expect(ring).toHaveLength(5);
		expect(ring.at(-1)).toEqual(ring[0]);
	}
});

it('changes pitch without animating when reduced motion is on', () => {
	const map = { jumpTo: vi.fn(), easeTo: vi.fn() };
	setRecordPerspective(map, true, true);
	setRecordPerspective(map, false, true);
	expect(map.jumpTo.mock.calls.map(([options]) => options)).toEqual([{ pitch: 50 }, { pitch: 0 }]);
	expect(map.easeTo).not.toHaveBeenCalled();
});
