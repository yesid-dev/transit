import { describe, expect, it } from 'vitest';
import { STATUS_CODES } from '#lib/v1/schemas/types.ts';
import { mapLegend, railLegendName } from './mapLegend';

const NB = ' ';

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
			['On time', `1${NB}min early to 5${NB}min late, inclusive`],
			['Late', `More than 5${NB}min late`],
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
		expect(legend.note).toBeNull();
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
			['À l’heure', `D’une minute d’avance à 5${NB}minutes de retard, limites incluses`],
			['En retard', `Plus de 5${NB}minutes de retard`],
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

describe('rail legend name', () => {
	const provider = { lines_without_live_data: [{ route_ids: ['schedule-only'], route_types: [] }] };

	it.each([
		[0, 'light rail', 'train léger'],
		[1, 'métro', 'métro'],
		[2, 'train', 'train'],
	] as const)('labels GTFS route type %s in both languages', (type, english, french) => {
		const routes = [
			{ id: 'schedule-only', type },
			{ id: 'live', type: 1 },
		];
		expect(railLegendName('en', provider, routes)).toBe(english);
		expect(railLegendName('fr', provider, routes)).toBe(french);
	});

	it('leaves out the name when types are mixed, unknown or absent', () => {
		const mixed = { lines_without_live_data: [{ route_ids: [], route_types: [0, 1] }] };
		expect(
			railLegendName('en', mixed, [
				{ id: 'a', type: 0 },
				{ id: 'b', type: 1 },
			]),
		).toBeUndefined();
		expect(railLegendName('en', provider, [{ id: 'schedule-only', type: 99 }])).toBeUndefined();
		expect(railLegendName('en', provider, [{ id: 'schedule-only' }])).toBeUndefined();
		expect(railLegendName('en', provider, [{ id: 'live', type: 1 }])).toBeUndefined();
	});
});
