import { describe, expect, it } from 'vitest';
import { lineLabel, stopDisplayName, hasOccupancy, formatTransitName } from './transitDisplay';
import type { NameSeparators } from '#lib/v1/schemas/providers.ts';

const separators: NameSeparators = { ends: '<>', languages: '~', language_order: ['en', 'fr'] };

describe('declared names', () => {
	it.each([
		['Waller <> Elmvale', 'Waller / Elmvale', 'Waller / Elmvale'],
		['Hospital ~ Hôpital', 'Hospital', 'Hôpital'],
		['Blair <> Parliament ~ Parlement', 'Blair / Parliament', 'Blair / Parlement'],
		[
			'Hospital ~ Hôpital <> Hurdman & N Rideau',
			'Hospital / Hurdman & N Rideau',
			'Hôpital / Hurdman & N Rideau',
		],
		[
			'Shuttle-Express Downtown ~ Navette-Express Centre-Ville <> Shuttle-Express Blair ~ Navette-Express Blair',
			'Shuttle-Express Downtown / Shuttle-Express Blair',
			'Navette-Express Centre-Ville / Navette-Express Blair',
		],
		[
			'South Keys / Hunt Club Loop ~ South Keys / Boucle Hunt Club',
			'South Keys / Hunt Club Loop',
			'South Keys / Boucle Hunt Club',
		],
		[
			"Tunney's Pasture <> Innovation / Carling Campus ~ Innovation /  Complexe Carling",
			"Tunney's Pasture / Innovation / Carling Campus",
			"Tunney's Pasture / Innovation /  Complexe Carling",
		],
		['St-Laurent', 'St-Laurent', 'St-Laurent'],
		['A - Antares', 'A - Antares', 'A - Antares'],
		[
			'Cumberland / Sarsfield / Navan',
			'Cumberland / Sarsfield / Navan',
			'Cumberland / Sarsfield / Navan',
		],
	])('formats %s in both languages', (raw, en, fr) => {
		expect(formatTransitName(raw, 'en', separators)).toBe(en);
		expect(formatTransitName(raw, 'fr', separators)).toBe(fr);
		expect(formatTransitName(raw, 'fr')).toBe(raw);
	});

	it.each([
		' ~ Hôpital',
		'Hospital ~ ',
		'Hospital ~ Hôpital ~ Other',
		'Place~Name',
		'Place~Name ~ Nom',
		'Waller<>Elmvale',
		'Waller <> Elmvale <> Main',
		'Waller <> ',
		'Fallowfield <> Limebank & CFIA ~ ACIA',
	])('preserves ambiguous %s', (raw) => {
		expect(formatTransitName(raw, 'en', separators)).toBe(raw);
		expect(formatTransitName(raw, 'fr', separators)).toBe(raw);
	});

	it('uses the declared language order', () => {
		expect(
			formatTransitName('Hôpital ~ Hospital', 'en', {
				...separators,
				language_order: ['fr', 'en'],
			}),
		).toBe('Hospital');
	});
});

// Names read from the published OC static/stops_index.json snapshot.
describe('OC stop display names', () => {
	it.each([
		['RIDEAU / CUMBERLAND', 'Rideau / Cumberland'],
		["TUNNEY'S PASTURE A", "Tunney's Pasture A"],
		['ST-LAURENT A', 'St-Laurent A'],
		['SUSSEX / AD. 100', 'Sussex / AD. 100'],
		['RENAUD / DE LA MÉLODIE', 'Renaud / de la Mélodie'],
		['OLD ST PATRICK / DE LA SALLE H.S.', 'Old St Patrick / de la Salle H.S.'],
		['LA SALLE / BANK', 'La Salle / Bank'],
		['8TH LINE / BYRON', '8th Line / Byron'],
		['8TH Line / Byron', '8th Line / Byron'],
		['Highway 31 / 3RD Avenue NB', 'Highway 31 / 3rd Avenue NB'],
		['UOTTAWA A', 'UOTTAWA A'],
		['RIDEAU A', 'Rideau A'],
		['LANSDOWNE TD PLACE', 'Lansdowne TD Place'],
		['BILLINGS BRIDGE 4B', 'Billings Bridge 4B'],
		['OC TRANSPO / ST-LAURENT', 'OC Transpo / St-Laurent'],
		['RIDEAU NB / O-TRAIN 1', 'Rideau NB / O-TRAIN 1'],
		['Station Berri-UQAM', 'Station Berri-UQAM'],
		// Mc and O' keep the capital after them; French elisions read as particles.
		["SLATER/O'CONNOR", "Slater/O'Connor"],
		['MCARTHUR / ST-LAURENT', 'McArthur / St-Laurent'],
		['MACDONALD-CARTIER', 'Macdonald-Cartier'],
		["RUE DE L'ÉGLISE", "Rue de l'Église"],
		["D'IBERVILLE / NOTRE-DAME", "D'Iberville / Notre-Dame"],
		['MAPLE LANE / SPRINGFIELD', 'Maple Lane / Springfield'],
		['POB CENTRAL', 'POB Central'],
	])('%s → %s', (raw, display) => expect(stopDisplayName(raw)).toBe(display));
});

it('does not rewrite an id that is missing from the index', () => {
	expect(lineLabel('1-373', [{ id: '1-373', short: '1' }])).toBe('1');
	expect(lineLabel('1-373', [])).toBe('1-373');
	expect(lineLabel('fictional-city:opaque', [])).toBe('fictional-city:opaque');
});

it('derives occupancy availability from provider vehicles and preserves STM', () => {
	expect(hasOccupancy(undefined, [])).toBe(false);
	expect(hasOccupancy(undefined, [{ occupancy: null }])).toBe(false);
	expect(hasOccupancy(undefined, [{ occupancy: 'standing' }])).toBe(true);
	expect(hasOccupancy(true, [])).toBe(true);
});
