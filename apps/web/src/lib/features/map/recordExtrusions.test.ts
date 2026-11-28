import { expect, it, vi } from 'vitest';
import { setRecordPerspective } from './mapCamera';
import { recordExtrusions, recordHeightScale } from './recordExtrusions';
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
		{ ...measured, id: 'outlier', value: 360 },
		{ ...measured, id: 'no-loss', value: 0 },
		{ ...measured, id: 'not-measured', value: null, state: 0 },
	];
	const flat = recordFeatures(marks, ['#aaa', '#888', '#666', '#444', '#222'], false, '#555');
	const values = new Map(marks.map(({ id, value }) => [id, value]));
	const raised = recordExtrusions(flat, (id) => values.get(id), {
		seconds: 36,
		metres: 144,
	}).features;
	expect(raised.map(({ properties }) => properties.id)).toEqual(['short', 'long', 'outlier']);
	expect(raised.map(({ properties }) => properties.height)).toEqual([36, 144, 144]);
	expect(raised.map(({ properties }) => properties.capped)).toEqual([false, false, true]);
	expect(raised[2]!.properties.bodyHeight).toBeLessThan(144);
	expect(raised.map(({ properties }) => properties.colour)).toEqual(
		flat.features.slice(0, 3).map(({ properties }) => properties.colour),
	);
	expect(raised[0].geometry.coordinates).toHaveLength(2);
	for (const [ring] of raised[0].geometry.coordinates) {
		expect(ring).toHaveLength(5);
		expect(ring.at(-1)).toEqual(ring[0]);
	}
});

it('uses the 95th percentile of measured positives and adjusts the height for zoom', () => {
	const camera = { center: [-73.6, 45.5] as const, zoom: 10, height: 600 };
	const marks = [
		...Array.from({ length: 19 }, () => ({ value: 15, state: 3 as const })),
		{ value: 500, state: 3 as const },
		{ value: 0, state: 3 as const },
		{ value: null, state: 1 as const },
	];
	const scale = recordHeightScale(marks, camera)!;
	expect(scale.seconds).toBe(15);
	expect(scale.metres).toBeGreaterThan(0);
	expect(recordHeightScale(marks, { ...camera, zoom: 11 })?.metres).toBeCloseTo(scale.metres / 2);
	expect(recordHeightScale(marks.slice(-2), camera)).toBeNull();
});

it('changes pitch without animating when reduced motion is on', () => {
	const map = { jumpTo: vi.fn(), easeTo: vi.fn() };
	setRecordPerspective(map, true, true);
	setRecordPerspective(map, false, true);
	expect(map.jumpTo.mock.calls.map(([options]) => options)).toEqual([{ pitch: 50 }, { pitch: 0 }]);
	expect(map.easeTo).not.toHaveBeenCalled();
});
