import { describe, expect, it } from 'vitest';
import type { StopIndexEntry } from '#lib/v1/schemas/stops_index.ts';
import {
	modeKeyForTag,
	routeModeHint,
	routeModeKey,
	stopGroupKey,
	stopModeHint,
	stopModeKey,
	stopModeTag,
} from './stopMode';

// Stop records from a third provider; ids and codes are unrelated to any current provider's.
function stop(
	id: string,
	name: string,
	mode?: string | null,
	code: string | null = `q-${id}`,
): StopIndexEntry {
	return { id, code, name, lat: 0, lon: 0, ...(mode === undefined ? {} : { mode }) };
}

function classification(record: StopIndexEntry) {
	return { hint: stopModeHint(record), tag: stopModeTag(record), key: stopModeKey(record) };
}

const UNCLASSIFIED = { hint: { glyph: '■', label: null }, tag: null, key: null };

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
		expect(records.map(classification)).toEqual(records.map(() => UNCLASSIFIED));
	});

	it('an explicit bus mode wins over a station name', () => {
		const record = stop('zx-7', 'Station Des Sources', 'bus', '7301');
		expect(classification(record)).toEqual({
			hint: { glyph: '■', label: null },
			tag: 'Bus',
			key: 'bus',
		});
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

	it('published metro and rail retain tags and name grouping', () => {
		const metro = [stop('zx-12', 'Lumière', 'metro', '8101'), stop('zx-13', 'Lumière', 'metro')];
		const rail = [stop('zx-14', 'Quai Nord', 'rail', '8201'), stop('zx-15', 'Quai Nord', 'rail')];
		expect(metro.map(classification)).toEqual(
			metro.map(() => ({ hint: { glyph: '◉', label: 'Métro' }, tag: 'Métro', key: 'metro' })),
		);
		expect(rail.map(classification)).toEqual(
			rail.map(() => ({ hint: { glyph: '╪', label: 'Train' }, tag: 'Train', key: 'rail' })),
		);
		expect([...metro, ...rail].map(stopGroupKey)).toEqual([
			'name:lumiere',
			'name:lumiere',
			'name:quai nord',
			'name:quai nord',
		]);
	});

	it('renders tram and ferry as a plain stop with a visible tag', () => {
		expect(classification(stop('zx-16', 'Station Ouest', 'tram'))).toEqual({
			hint: { glyph: '■', label: null },
			tag: 'Tram',
			key: 'tram',
		});
		expect(classification(stop('zx-17', 'Gare Maritime', 'ferry'))).toEqual({
			hint: { glyph: '■', label: null },
			tag: 'Ferry',
			key: 'ferry',
		});
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

describe('modeKeyForTag — reverse of MODE_TAGS, single source of truth', () => {
	it('maps each visible tag back to its mode key', () => {
		expect(modeKeyForTag('Métro')).toBe('metro');
		expect(modeKeyForTag('Tram')).toBe('tram');
		expect(modeKeyForTag('Train')).toBe('rail');
		expect(modeKeyForTag('Bus')).toBe('bus');
		expect(modeKeyForTag('Ferry')).toBe('ferry');
	});

	it('round-trips with stopModeTag for every known mode (no drift)', () => {
		for (const mode of ['metro', 'tram', 'rail', 'bus', 'ferry'] as const) {
			const tag = stopModeTag({ mode });
			expect(modeKeyForTag(tag)).toBe(mode);
		}
	});

	it('returns null for null/undefined (no fabricated mode)', () => {
		expect(modeKeyForTag(null)).toBeNull();
		expect(modeKeyForTag(undefined)).toBeNull();
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
