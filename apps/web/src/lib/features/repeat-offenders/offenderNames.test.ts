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
