import { describe, expect, it } from 'vitest';
import { createLineDirectory } from '#lib/site/lineDirectory.ts';
import type { RepeatOffenderEntry } from '#lib/v1/schemas/index.ts';
import { offenderIdentity } from './offenderNames';
import { copy } from './repeatOffenders.copy';

const directory = (
	locale: 'en' | 'fr',
	routes = [{ id: 'route-36', short: '99', long: 'Today' }],
) => createLineDirectory(routes, { line: (id) => `${locale === 'en' ? 'Line' : 'Ligne'} ${id}` });

const trip = (over: Partial<RepeatOffenderEntry> = {}): RepeatOffenderEntry => ({
	type: 'trip',
	id: '302181944',
	route: 'route-36',
	route_name: 'Monk',
	...over,
});

describe('offenderIdentity', () => {
	it.each(['en', 'fr'] as const)(
		'names a departure by its published line, clock and destination in %s',
		(locale) => {
			const identity = offenderIdentity(
				trip({ route_short_name: '36', departure_time: '07:42:00', headsign: 'Monk' }),
				directory(locale),
				copy[locale],
			);
			// The published historical number wins over today's directory.
			expect(identity.number).toBe('36');
			expect(identity.primary).toBe(locale === 'en' ? '07:42 toward Monk' : '07:42 vers Monk');
			expect(identity.lineName).toBe('Monk');
			expect(identity.label).toBe(
				locale === 'en' ? 'Line 36, 07:42 toward Monk' : 'Ligne 36, 07:42 vers Monk',
			);
		},
	);

	it.each(['en', 'fr'] as const)(
		'invents no departure for a file without departure labels in %s',
		(locale) => {
			const identity = offenderIdentity(trip(), directory(locale), copy[locale]);
			expect(identity.number).toBe('99');
			expect(identity.primary).toBe(locale === 'en' ? 'Trip 302181944' : 'Trajet 302181944');
			expect(identity.label).toBe(
				locale === 'en'
					? 'Trip 302181944 on line 99 (Monk)'
					: 'Trajet 302181944 sur la ligne 99 (Monk)',
			);
			expect(identity.label).not.toMatch(/\d:\d|toward|vers/);
		},
	);

	it.each(['en', 'fr'] as const)('names a bus with the line it was counted on in %s', (locale) => {
		const identity = offenderIdentity(
			{ type: 'vehicle', id: '4672', route: '158', route_name: 'Bayshore <> Haanel' },
			directory(locale, []),
			copy[locale],
		);
		expect(identity.number).toBe('158');
		expect(identity.primary).toBe('Bus 4672');
		expect(identity.label).toBe(
			locale === 'en'
				? 'Bus 4672 on line 158 (Bayshore <> Haanel)'
				: 'Bus 4672 sur la ligne 158 (Bayshore <> Haanel)',
		);
	});

	it('keeps a row without a published line to its own number', () => {
		const identity = offenderIdentity(
			{ type: 'vehicle', id: '4672', route: null },
			directory('en'),
			copy.en,
		);
		expect(identity).toMatchObject({ number: null, lineName: null, label: 'Bus 4672' });
	});

	it.each(['en', 'fr'] as const)(
		'formats service-clock components without wrapping the service day in %s',
		(locale) => {
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
				const { label } = offenderIdentity(
					trip({ route_short_name: '36', departure_time: clock, headsign: 'Monk' }),
					directory(locale),
					copy[locale],
				);
				const expected =
					locale === 'en'
						? `Line 36${formatted ? `, ${formatted}` : ''} toward Monk`
						: `Ligne 36${formatted ? `, ${formatted}` : ''} vers Monk`;
				expect(label).toBe(expected);
			}
		},
	);
});
