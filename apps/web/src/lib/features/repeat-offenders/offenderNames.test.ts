import { createLineDirectory } from '#lib/site/lineDirectory.ts';
import { selectOffenderLadder } from './selectors/offenderLadder';
import { buildOffenderEvidenceRows } from './selectors/offenderEvidence';
import { expect, it } from 'vitest';
import { createOffenderNames } from './offenderNames';
import { copy } from './repeatOffenders.copy';
import type { LineDirectory } from '#lib/site/lineDirectory.ts';

it.each(['en', 'fr'] as const)(
	'names a departure with its published clock and destination in %s',
	(locale) => {
		const names = createOffenderNames(
			() => ({}) as LineDirectory,
			() => copy[locale],
		);
		expect(
			names.unnamed({
				type: 'trip',
				id: 'internal',
				route: 'route-id',
				route_short_name: '36',
				departure_time: '07:42:00',
				headsign: 'Monk',
			}),
		).toBe(locale === 'en' ? 'Line 36, 07:42 toward Monk' : 'Ligne 36, 07:42 vers Monk');
	},
);

it.each(['en', 'fr'] as const)(
	'keeps published historical names in every row with a current directory in %s',
	(locale) => {
		const directory = createLineDirectory(
			[{ id: 'route-id', short: '99', long: 'Today', type: 3 }],
			{ line: (id) => `${locale === 'en' ? 'Line' : 'Ligne'} ${id}` },
		);
		const names = createOffenderNames(
			() => directory,
			() => copy[locale],
		);
		const entry = {
			rank: 1,
			type: 'trip',
			id: 'T',
			route: 'route-id',
			route_name: 'Monk',
			route_short_name: '36',
			departure_time: '07:42:00',
			headsign: 'Monk',
			observation_count: 90,
			severe_count: 60,
			severe_pct: 66.7,
			recurrence_days: 2,
			observed_days: 3,
		};
		const labels = {
			directory,
			unnamed: names.unnamed,
			title: 'Recurring delays',
			rowLabel: 'Trip',
			xLabel: 'Late',
			unit: '%',
			ciLabel: 'CI',
			note: () => '',
			href: () => null,
			ariaLabel: (text: string) => text,
			typeId: () => 'T',
			severeRate: () => null,
			confidenceInterval: () => null,
			recurrence: () => '',
			averageDelay: () => null,
			readings: () => null,
		};
		const chart = selectOffenderLadder([entry], 5, locale, labels);
		if (chart.spec.kind !== 'magnitude-bars') throw new Error('Expected ranked row');
		const table = buildOffenderEvidenceRows([entry], 5, labels)[0];
		const expected = locale === 'en' ? 'Line 36, 07:42 toward Monk' : 'Ligne 36, 07:42 vers Monk';
		expect([
			names.unnamed(entry),
			names.spoken(entry),
			chart.spec.rows[0].label,
			chart.spec.rows[0].spoken,
			table.title,
			table.ariaLabel,
		]).toEqual(Array(6).fill(expected));
	},
);

it.each(['en', 'fr'] as const)(
	'formats service-clock components without wrapping the service day in %s',
	(locale) => {
		const names = createOffenderNames(
			() => ({}) as LineDirectory,
			() => copy[locale],
		);
		for (const [clock, formatted] of [
			['7:42:00', '7:42'],
			['07:42:00', '07:42'],
			['24:05:00', '24:05'],
			['25:30:00', '25:30'],
			['100:05:00', '100:05'],
			[null, null],
			['bad', null],
			['07:60:00', null],
			['07:42:60', null],
		]) {
			const label = names.unnamed({
				type: 'trip',
				id: 'T',
				route: 'R',
				route_short_name: '36',
				departure_time: clock,
				headsign: 'Monk',
			});
			const expected =
				locale === 'en'
					? `Line 36${formatted ? `, ${formatted}` : ''} toward Monk`
					: `Ligne 36${formatted ? `, ${formatted}` : ''} vers Monk`;
			expect(label).toBe(expected);
		}
	},
);
