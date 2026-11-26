import { expect, it } from 'vitest';
import { legacyRankingHref, rankingSelection } from './rankingSelection';

it.each([
	['/hotspots', '', 'en', '/rankings'],
	['/repeat-offenders', '', 'fr', '/fr/rankings?kind=departure'],
	[
		'/hotspots',
		'?provider=stm&kind=stops&measure=late&recordFrom=2026-11-01&recordTo=2026-11-02',
		'fr',
		'/fr/rankings?provider=stm&recordFrom=2026-11-01&recordTo=2026-11-02&kind=stop&measure=late',
	],
	['/repeat-offenders', '?kind=buses&measure=on_time', 'en', '/rankings?kind=vehicle'],
	['/repeat-offenders', '?kind=unknown&measure=unknown', 'en', '/rankings?kind=departure'],
	['/hotspots', '?kind=stop&class=all&measure=missing_trips', 'en', '/rankings?kind=stop'],
] as const)('preserves meaningful legacy choices from %s%s', (path, query, locale, expected) => {
	expect(legacyRankingHref(path, new URL(path + query, 'https://transit.test'), locale)).toBe(
		expected,
	);
});

it('keeps a vehicle query on stopped reporting even with a different measure in the URL', () => {
	expect(
		rankingSelection('/rankings', new URLSearchParams('kind=vehicle&measure=on_time')),
	).toEqual({
		kind: 'vehicle',
		measure: 'vehicle_reporting_gaps_per_100_hours',
		serviceClass: null,
	});
});
