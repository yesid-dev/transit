import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hotspotGauge } from './hotspotGauge';
import { RANKED_CAP, TRAY_CAP, readHotspotRanking } from './selectors/hotspotRanking';
import { worstNCap, DEFAULT_WORST_N } from '#lib/reliability/ladderCap.ts';

/** A publisher constant, read from its own source, so a changed cap cannot pass silently. */
function publisherConstant(name: string): number {
	const source = readFileSync(
		new URL(
			'../../../../../db/src/transit_ops/snapshots/builders/historic/ranking_kernel.py',
			import.meta.url,
		),
		'utf8',
	);
	const value = new RegExp(`^${name} = (\\d+)$`, 'm').exec(source)?.[1];
	if (value == null) throw new Error(`${name} not found in the publisher source`);
	return Number(value);
}

describe('publisher caps', () => {
	it('match the hotspots publisher', () => {
		expect(RANKED_CAP).toBe(publisherConstant('HOTSPOTS_BY_GRAIN_CAP'));
		expect(TRAY_CAP).toBe(publisherConstant('HOTSPOTS_TRAY_CAP'));
	});
});

describe('hotspotGauge', () => {
	for (const grain of hotspotGauge.by_grain!)
		for (const kind of ['route', 'stop'] as const)
			it(`${grain.grain} ${kind}s reserve the fullest first page the publisher can send`, () => {
				const ranking = readHotspotRanking(grain, kind);
				if (ranking.state !== 'ranked') throw new Error(`gauge ${ranking.state}`);
				// One row more than the first page shows, so its "show all" button is laid out too.
				expect(ranking.rows).toHaveLength(worstNCap(DEFAULT_WORST_N) + 1);
				// One kind alone can fill the whole tray, and the page lists all of it.
				expect(ranking.belowFloor.examples).toHaveLength(TRAY_CAP);
				expect(ranking.belowFloor.count).toBe(TRAY_CAP);
			});
});
