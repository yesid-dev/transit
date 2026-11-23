import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LIVE_STATUS_BANDS } from '#lib/v1/live/statusBands.ts';
import { STATUS_CODES } from '#lib/v1/schemas/types.ts';
import { mapLegend } from './mapLegend';

const NB = ' ';

function bandOf(delayS: number): string[] {
	return Object.entries(LIVE_STATUS_BANDS)
		.filter(
			([, { fromS, belowS }]) =>
				(fromS == null || delayS >= fromS) && (belowS == null || delayS < belowS),
		)
		.map(([code]) => code);
}

/**
 * The publisher's live status rule, read from its own source: the null branch, three ordered
 * strict `<` branches and the ELSE. Any other shape throws, so a changed rule cannot pass silently.
 */
function publisherStatusRule() {
	const source = readFileSync(
		new URL('../../../../../db/src/transit_ops/snapshots/builders/_helpers.py', import.meta.url),
		'utf8',
	);
	const block = /^STATUS_BAND_CASE_SQL = """([\s\S]*?)"""/m.exec(source)?.[1];
	if (block == null) throw new Error('STATUS_BAND_CASE_SQL not found in the publisher source');
	const sql = block.replace(/\s+/g, ' ').trim();
	const label = "'((?:[^']|'')*)'";
	const shape = new RegExp(
		`^CASE WHEN \\{col\\} IS NULL THEN ${label}` +
			` WHEN \\{col\\} < (-?\\d+) THEN ${label}`.repeat(3) +
			` ELSE ${label} END$`,
	);
	const m = shape.exec(sql);
	if (m == null) throw new Error(`STATUS_BAND_CASE_SQL changed shape: ${sql}`);
	// 'À l''heure / On time' is on_time: the English half, as a status code.
	const code = (text: string) => text.split(' / ').at(-1)!.toLowerCase().replace(/ /g, '_');
	return {
		nullCode: code(m[1]),
		branches: [2, 4, 6].map((i) => ({ belowS: Number(m[i]), code: code(m[i + 1]) })),
		elseCode: code(m[8]),
	};
}

describe('live status bands', () => {
	it('partition every delay into exactly one band, in status order, on whole minutes', () => {
		const codes = Object.keys(LIVE_STATUS_BANDS);
		expect(codes).toEqual(STATUS_CODES.filter((code) => code !== 'unknown'));
		const bands = Object.values(LIVE_STATUS_BANDS);
		expect(bands[0].fromS).toBeNull();
		expect(bands.at(-1)!.belowS).toBeNull();
		for (const [index, band] of bands.entries()) {
			if (band.fromS != null && band.belowS != null) expect(band.fromS).toBeLessThan(band.belowS);
			if (index > 0) expect(band.fromS).toBe(bands[index - 1].belowS);
			for (const bound of [band.fromS, band.belowS])
				if (bound != null) {
					expect(Number.isFinite(bound)).toBe(true);
					expect(Object.is(bound, -0)).toBe(false);
					expect(Number.isInteger(bound / 60)).toBe(true);
				}
		}
		for (let delayS = -900; delayS <= 900; delayS += 0.5) expect(bandOf(delayS)).toHaveLength(1);
	});

	it('are the publisher’s own rule, read from STATUS_BAND_CASE_SQL, bound for bound', () => {
		const publisher = publisherStatusRule();
		const web = Object.entries(LIVE_STATUS_BANDS);
		expect(publisher.nullCode).toBe('unknown');
		expect([...publisher.branches.map((b) => b.code), publisher.elseCode]).toEqual(
			web.map(([code]) => code),
		);
		// Ordered strict `<` branches are half-open intervals: each band ends where the next starts.
		expect(web.slice(0, -1).map(([, band]) => band.belowS)).toEqual(
			publisher.branches.map((b) => b.belowS),
		);
		expect(web.slice(1).map(([, band]) => band.fromS)).toEqual(
			publisher.branches.map((b) => b.belowS),
		);
		expect(web[0][1].fromS).toBeNull();
		expect(web.at(-1)![1].belowS).toBeNull();
	});

	it('match the publisher at each boundary: early < -60 s <= on time < 60 s <= late < 300 s <= severe', () => {
		expect([-61, -60, 59, 60, 299, 300].map((d) => bandOf(d)[0])).toEqual([
			'early',
			'on_time',
			'on_time',
			'late',
			'late',
			'severe',
		]);
	});
});

describe('mapLegend', () => {
	it('states each status with the minutes the map draws, then position and map symbols (en)', () => {
		const legend = mapLegend('en', { colourBy: 'status', staleCutoffS: 150 });
		expect(legend.groups.map((group) => group.heading)).toEqual([
			'Colour shows vehicle status',
			'Position',
			'Map symbols',
		]);
		expect(legend.groups[0].rows.map((row) => [row.label, row.definition])).toEqual([
			['Early', `More than 1${NB}min early`],
			['On time', `1${NB}min early to under 1${NB}min late`],
			['Late', `1 to under 5${NB}min late`],
			['Severe', `5${NB}min late or more`],
			['Delay unknown', 'The live feed gives no delay'],
		]);
		expect(legend.groups[0].rows.map((row) => row.mark)).toEqual(
			STATUS_CODES.map((code) => ({ kind: 'status', code })),
		);
		expect(legend.groups[1].rows).toEqual([
			{
				id: 'not-reporting',
				mark: { kind: 'stale' },
				label: 'No recent position',
				definition: `None for 2${NB}min${NB}30${NB}s or more. It can appear with any status.`,
			},
		]);
		expect(legend.groups[2].rows.map((row) => [row.id, row.label, row.definition])).toEqual([
			['heading', 'Direction of travel', null],
			['stop', 'Stop', null],
		]);
		expect(legend.note).toBe(
			'◆ marks a severe delay at every zoom. Zoom in to see the other status badges.',
		);
	});

	it('says the same in French', () => {
		const legend = mapLegend('fr', { colourBy: 'status', staleCutoffS: 150 });
		expect(legend.groups.map((group) => group.heading)).toEqual([
			'La couleur montre la ponctualité',
			'Position',
			'Symboles de la carte',
		]);
		expect(legend.groups[0].rows.map((row) => [row.label, row.definition])).toEqual([
			['En avance', 'Plus d’une minute d’avance'],
			['À l’heure', 'D’une minute d’avance à moins d’une minute de retard'],
			['En retard', `D’une minute à moins de 5${NB}minutes de retard`],
			['Sévère', `5${NB}minutes de retard ou plus`],
			['Retard inconnu', 'Le flux en direct n’indique aucun retard'],
		]);
		expect(legend.groups[1].rows[0]).toMatchObject({
			label: 'Aucune position récente reçue',
			definition: `Aucune depuis 2${NB}min${NB}30${NB}s ou plus. Peut accompagner n’importe quel état.`,
		});
	});

	it('explains crowding colours instead of status when the map is coloured by crowding', () => {
		const en = mapLegend('en', { colourBy: 'occupancy', staleCutoffS: 150 });
		expect(en.groups.map((group) => group.id)).toEqual(['occupancy', 'position', 'symbols']);
		expect(en.groups[0].heading).toBe('Colour shows crowding');
		expect(en.groups[0].rows.map((row) => [row.mark, row.label, row.definition])).toEqual([
			[{ kind: 'occupancy', code: 'empty' }, 'Empty', null],
			[{ kind: 'occupancy', code: 'many_seats' }, 'Many seats available', null],
			[{ kind: 'occupancy', code: 'few_seats' }, 'Few seats available', null],
			[{ kind: 'occupancy', code: 'standing' }, 'Standing room only', null],
			[{ kind: 'occupancy', code: 'full' }, 'Full', null],
		]);
		expect(en.note).toBe('Zoom in to see each vehicle’s crowding badge.');
		const fr = mapLegend('fr', { colourBy: 'occupancy', staleCutoffS: 150 });
		expect(fr.groups[0].heading).toBe('La couleur montre l’occupation');
		expect(fr.groups[0].rows.map((row) => row.label)).toEqual([
			'Vide',
			'Plusieurs places assises libres',
			'Peu de places assises libres',
			'Places debout seulement',
			'Complet',
		]);
		expect(fr.note).toBe('Zoomez pour voir le symbole d’occupation.');
	});

	it('states the cutoff the map uses for a lagging feed, and none it cannot state', () => {
		const at = (staleCutoffS: number) =>
			mapLegend('en', { colourBy: 'status', staleCutoffS }).groups[1].rows[0].definition;
		expect(at(180)).toBe(`None for 3${NB}min or more. It can appear with any status.`);
		expect(at(45)).toBe(`None for 45${NB}s or more. It can appear with any status.`);
		for (const broken of [Number.NaN, Number.POSITIVE_INFINITY, 0, -30])
			expect(at(broken)).toBeNull();
	});
});
