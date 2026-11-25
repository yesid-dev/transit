import { describe, expect, it } from 'vitest';
import type { StopIndexEntry } from '#lib/v1/schemas/stops_index.ts';
import { routeModeHint, routeModeKey, stopGroupKey } from './stopMode';

// Stop records from a third provider; ids and codes are unrelated to any current provider's.
function stop(
	id: string,
	name: string,
	mode?: string | null,
	code: string | null = `q-${id}`,
): StopIndexEntry {
	return { id, code, name, lat: 0, lon: 0, ...(mode === undefined ? {} : { mode }) };
}

describe('stop mode — the published mode only', () => {
	it('a station or gare name without published mode stays unclassified', () => {
		const records = [
			stop('zx-1', 'Station Crémazie'),
			stop('zx-2', '  station crémazie', null),
			stop('zx-3', 'Gare Centrale'),
			stop('zx-4', 'GARE Saint-Jérôme', null),
			stop('zx-5', 'Gare d’Île-Perrot', ''),
			stop('zx-6', 'Station Des Sources', 'monorail'),
			stop('zx-18', 'Station Des Sources', 'constructor'),
		];
		expect(records.map(stopGroupKey)).toEqual(records.map(({ code }) => 'code:' + code));
	});

	it('an explicit bus mode wins over a station name', () => {
		const record = stop('zx-7', 'Station Des Sources', 'bus', '7301');
		expect(stopGroupKey(record)).toBe('code:7301');
	});

	it('unknown-mode stops keep separate code identities', () => {
		const platforms = [
			stop('zx-8', 'Station Des Sources', undefined, '7301'),
			stop('zx-9', 'Station Des Sources', null, '7302'),
			stop('zx-10', 'Station Des Sources', 'monorail', '7303'),
			stop('zx-11', 'Gare Des Sources', undefined, null),
		];
		expect(platforms.map(stopGroupKey)).toEqual([
			'code:7301',
			'code:7302',
			'code:7303',
			'code:zx-11',
		]);
	});

	it('groups published metro and rail platforms by station name', () => {
		const metro = [stop('zx-12', 'Lumière', 'metro', '8101'), stop('zx-13', 'Lumière', 'metro')];
		const rail = [stop('zx-14', 'Quai Nord', 'rail', '8201'), stop('zx-15', 'Quai Nord', 'rail')];
		expect([...metro, ...rail].map(stopGroupKey)).toEqual([
			'name:lumiere',
			'name:lumiere',
			'name:quai nord',
			'name:quai nord',
		]);
	});
});

describe('routeModeHint — GTFS route_type → glyph + tag', () => {
	it('maps the known route types to the shared glyph + a mode tag', () => {
		expect(routeModeHint(0)).toEqual({ glyph: '╤', tag: 'Tram' });
		expect(routeModeHint(1)).toEqual({ glyph: '◉', tag: 'Métro' });
		expect(routeModeHint(2)).toEqual({ glyph: '╪', tag: 'Train' });
		expect(routeModeHint(3)).toEqual({ glyph: '═', tag: 'Bus' });
		expect(routeModeHint(4)).toEqual({ glyph: '≈', tag: 'Ferry' });
	});

	it('defaults an unmapped type to the bus glyph with no tag', () => {
		expect(routeModeHint(99)).toEqual({ glyph: '═', tag: null });
	});
});

describe('routeModeKey — canonical GTFS route_type mode key', () => {
	it('uses the shared mode vocabulary and stands down unknown types', () => {
		expect([0, 1, 2, 3, 4].map(routeModeKey)).toEqual(['tram', 'metro', 'rail', 'bus', 'ferry']);
		expect(routeModeKey(99)).toBeNull();
	});
});

describe('stopGroupKey', () => {
	it('groups ordinary stops by rider code, keeping distinct codes separate', () => {
		const a = stopGroupKey({
			id: '52819',
			code: '52618',
			name: 'Montgomery / Sherbrooke',
			mode: 'bus',
		});
		const b = stopGroupKey({ id: '57191', code: '57191', name: 'Van Horne / Rockland' });
		expect(a).toBe('code:52618');
		expect(b).toBe('code:57191');
		expect(a).not.toBe(b);
	});
});
