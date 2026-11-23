import { describe, expect, it } from 'vitest';
import { NetworkFileSchema, type NetworkFile } from '#lib/v1/schemas/network.ts';
import { selectLivePulse, type LivePulse } from './homePulse';

/*
 * Owner ruling 6: every figure the home's Live now card shows is checked against its definition,
 * never against an earlier output. The publisher (apps/db snapshots/builders/live.py,
 * build_network) counts one row per vehicle in the live feed and sums the silent trips by line.
 * The card shows those two counts and no share: nothing live shares "on time" with the record.
 */

/** A live network file as the reader receives it: parsed by the published schema. */
function published(fields: Record<string, unknown>): NetworkFile {
	return NetworkFileSchema.parse({
		generated_utc: '2026-11-15T07:07:30Z',
		delay_p50_min: null,
		delay_p90_min: null,
		feed_freshness_s: 20,
		coverage_pct: null,
		status_dist: {},
		on_time_pct: null,
		non_responding: 0,
		...fields,
	});
}

/** Every rule the card's figures must keep, as the list of the ones a pulse breaks. */
function brokenRules(net: NetworkFile, pulse: LivePulse | null): string[] {
	if (!pulse) return ['a published file has a pulse'];
	const broken: string[] = [];
	const rule = (holds: boolean, name: string) => {
		if (!holds) broken.push(name);
	};
	rule(
		Object.keys(pulse).sort().join() === 'reporting,silent',
		'two counts and nothing else: no share',
	);
	for (const [count, source] of [
		[pulse.reporting, net.vehicles_in_service],
		[pulse.silent, net.non_responding],
	] as const) {
		const whole = source !== null && Number.isSafeInteger(source) && source >= 0;
		rule(
			whole ? count === source && !Object.is(count, -0) : count === null,
			'a whole published count is shown as is; anything else is absent, never zero',
		);
	}
	return broken;
}

describe('home Live now card: figures proven from their definitions', () => {
	it.each([
		{
			case: 'a night with nothing running',
			file: { vehicles_in_service: 0 },
			reporting: 0,
			silent: 0,
		},
		{
			case: 'a negative count from a broken file',
			file: { vehicles_in_service: -3, non_responding: 4 },
			reporting: null,
			silent: 4,
		},
		{
			case: 'a negative zero',
			file: { vehicles_in_service: -0, non_responding: -0 },
			reporting: 0,
			silent: 0,
		},
	])('$case', ({ file, reporting, silent }) => {
		const net = published(file);
		expect(selectLivePulse(net)).toEqual({ reporting, silent });
		expect(brokenRules(net, selectLivePulse(net))).toEqual([]);
	});

	it('reads the published files of 2026-11-15 07:07 UTC as their counts say', () => {
		// https://data.yesid.dev/v1/stm/live/network.json, generated 07:07:30Z.
		const stm = published({
			vehicles_in_service: 175,
			status_dist: { on_time: 71, late: 55, severe: 9, early: 10, unknown: 30 },
			on_time_pct: 87,
			non_responding: 7,
		});
		// https://data.yesid.dev/v1/octranspo/live/network.json, generated 07:07:40Z.
		const ottawa = published({
			vehicles_in_service: 28,
			status_dist: { on_time: 4, late: 5, severe: 1, early: 4, unknown: 14 },
			on_time_pct: 64,
			non_responding: 0,
		});
		expect(selectLivePulse(stm)).toEqual({ reporting: 175, silent: 7 });
		expect(selectLivePulse(ottawa)).toEqual({ reporting: 28, silent: 0 });
		expect(brokenRules(stm, selectLivePulse(stm))).toEqual([]);
		expect(brokenRules(ottawa, selectLivePulse(ottawa))).toEqual([]);
	});

	it('has nothing to say before the live snapshot arrives', () => {
		expect(selectLivePulse(null)).toBeNull();
	});
});
