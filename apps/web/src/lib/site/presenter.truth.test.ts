import { expect, it } from 'vitest';
import {
	citationSource,
	citationSourceText,
	missDirection,
	pageCitation,
	reportingGapLength,
	reportingGapsReading,
	unconfirmedTripsRange,
} from './presenter.ts';

// Figures from the published STM and OC Transpo answers of 19 to 25 November 2026, as recomputed
// by the truth pass from the public day files.
const plain = (text: string | null) => text?.replace(/[\u00a0\u202f]/gu, ' ') ?? null;

it.each([
	// OC Transpo line 659: 560 early, 170 on time, 48 late of 778.
	[
		{ classified: 778, early: 560, on_time: 170, late: 48 },
		'early 72.0%, late 6.2%',
		'en avance 72,0 %, en retard 6,2 %',
	],
	// STM stop 52997: 84 early, 24 on time, 3 late of 111.
	[
		{ classified: 111, early: 84, on_time: 24, late: 3 },
		'early 75.7%, late 2.7%',
		'en avance 75,7 %, en retard 2,7 %',
	],
] as const)('says which way %o misses its on-time window', (counts, en, fr) => {
	expect(missDirection(counts, 'en')).toBe(en);
	expect(plain(missDirection(counts, 'fr'))).toBe(fr);
	// The French percent keeps its non-breaking space.
	expect(missDirection(counts, 'fr')).toMatch(/72,0\u00a0%|75,7\u00a0%/u);
});

it('says nothing about the way when a count is missing or nothing was observed', () => {
	expect(missDirection({ classified: 100, on_time: 48 }, 'en')).toBeNull();
	expect(missDirection({ classified: 0, early: 0, late: 0 }, 'en')).toBeNull();
	expect(missDirection(undefined, 'fr')).toBeNull();
});

it('gives both ends of the trips that ran when some trips could not be confirmed', () => {
	// STM: 105,782 ran of 106,631 with a known status; 5,343 never settled.
	expect(unconfirmedTripsRange(105_782, 106_631, 5343, 'en')).toBe(
		'5,343 more trips could not be confirmed, run or not: between 94.5% and 99.2% ran.',
	);
	expect(plain(unconfirmedTripsRange(105_782, 106_631, 5343, 'fr'))).toBe(
		'5 343 autres trajets n’ont pas pu être confirmés, effectués ou non : entre 94,5 % et 99,2 % des trajets ont été effectués.',
	);
	expect(unconfirmedTripsRange(9, 10, 1, 'en')).toBe(
		'1 more trip could not be confirmed, run or not: between 81.8% and 90.9% ran.',
	);
	expect(plain(unconfirmedTripsRange(9, 10, 1, 'fr'))).toBe(
		'1 autre trajet n’a pas pu être confirmé, effectué ou non : entre 81,8 % et 90,9 % des trajets ont été effectués.',
	);
	expect(unconfirmedTripsRange(9, 10, 0, 'en')).toBeNull();
});

it('says how long an interruption of reporting lasts on average', () => {
	// STM: 108,326 interruptions in 2,227.38 silent hours, about 74 s each.
	expect(plain(reportingGapLength(108_326, 2227.3847740891665, 'en'))).toBe(
		'lasting 74 s on average',
	);
	expect(plain(reportingGapLength(108_326, 2227.3847740891665, 'fr'))).toBe(
		'd’une durée moyenne de 74 s',
	);
	// One STM vehicle: 83 interruptions in 1.45 silent hours.
	expect(plain(reportingGapsReading(473.53490222412114, 83, 'en', 1.450030923611111))).toBe(
		'times it stopped reporting, about 4.7 an hour, lasting 63 s on average',
	);
	expect(plain(reportingGapsReading(473.53490222412114, 83, 'fr', 1.450030923611111))).toBe(
		'interruptions des signalements, environ 4,7 par heure, d’une durée moyenne de 63 s',
	);
	// Long silences read in minutes.
	expect(plain(reportingGapLength(2, 0.25, 'en'))).toBe('lasting 7.5 min on average');
	expect(plain(reportingGapLength(1, 0.01, 'en'))).toBe('lasting 36 s');
	expect(reportingGapLength(0, 0, 'en')).toBeNull();
	expect(reportingGapsReading(473.5, 83, 'en')).toBe(
		'times it stopped reporting, about 4.7 an hour',
	);
	expect(plain(reportingGapsReading(1.6764, 1, 'en', 0.20002))).toBe(
		'time it stopped reporting, lasting 12 min',
	);
	expect(plain(reportingGapsReading(1.6764, 1, 'fr', 0.20002))).toBe(
		'interruption des signalements, d’une durée de 12 min',
	);
});

const stm = {
	download_licence: {
		name: {
			en: 'Creative Commons Attribution 4.0 (CC BY 4.0)',
			fr: 'Creative Commons Attribution 4.0 (CC BY 4.0)',
		},
		source: { fr: 'de la STM' },
	},
};
const ottawa = {
	download_licence: {
		name: {
			en: 'Open Government Licence, City of Ottawa, v2.0',
			fr: 'Licence du gouvernement ouvert, Ville d’Ottawa, version 2.0',
		},
		source: { fr: 'd’OC Transpo' },
	},
};

it.each([
	[
		'en',
		stm,
		'STM',
		'Transit · Montréal. 19 to 25 Nov 2026. Source: STM open data, Creative Commons Attribution 4.0 (CC BY 4.0), computed by Transit. Accessed 27 Nov 2026. https://t.test/?provider=stm&frameMode=record&recordFrom=2026-11-19&recordTo=2026-11-25',
	],
	[
		'fr',
		stm,
		'STM',
		'Transit · Montréal. Du 19 au 25 nov. 2026. Source : données ouvertes de la STM, Creative Commons Attribution 4.0 (CC BY 4.0), calculs de Transit. Consulté le 27 nov. 2026. https://t.test/?provider=stm&frameMode=record&recordFrom=2026-11-19&recordTo=2026-11-25',
	],
	[
		'fr',
		ottawa,
		'OC Transpo',
		'Transit · Montréal. Du 19 au 25 nov. 2026. Source : données ouvertes d’OC Transpo, Licence du gouvernement ouvert, Ville d’Ottawa, version 2.0, calculs de Transit. Consulté le 27 nov. 2026. https://t.test/?provider=stm&frameMode=record&recordFrom=2026-11-19&recordTo=2026-11-25',
	],
] as const)(
	'cites the figures with their source, licence, access date and pinned address in %s',
	(locale, provider, operator, text) => {
		const period = { from: '2026-11-19', to: '2026-11-25' };
		const href =
			'https://t.test/?provider=stm&frameMode=record&recordFrom=2026-11-19&recordTo=2026-11-25';
		const source = citationSource(operator, provider, locale);
		expect(plain(pageCitation('Montréal', period, href, locale, source, '2026-11-27'))).toBe(text);
	},
);

it('names the source without a licence when the city declares none', () => {
	expect(citationSourceText(citationSource('STM', null, 'en'), 'en')).toBe(
		'STM open data, computed by Transit',
	);
	expect(citationSourceText(citationSource('STM', stm, 'fr'), 'fr')).toBe(
		'Données ouvertes de la STM, Creative Commons Attribution 4.0 (CC BY 4.0), calculs de Transit',
	);
});
