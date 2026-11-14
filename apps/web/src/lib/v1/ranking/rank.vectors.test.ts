import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { rankEntities, shownUnits } from './rank.ts';

const integer = z
	.string()
	.regex(/^-?\d+$/)
	.transform(BigInt);
const share = z.tuple([integer, integer]);
const specSchema = z.object({
	id: z.string(),
	numerator: z.string().nullable(),
	denominator: z.string().nullable(),
	denominator_from: z.enum(['entity', 'network']),
	scale: share,
	precision: integer,
	worse: z.enum(['lower', 'higher']),
	series: z.string(),
	floor_trips: integer.nullable(),
	floor_trips_of: z.string(),
	floor_units: integer.nullable(),
	floor_units_of: z.string().nullable(),
	floor_service_days: z.boolean(),
	pair: z.null(),
});
const rulesSchema = z.object({
	version: integer,
	default_measure: z.string(),
	measures: z.array(z.string()),
	windows: z.array(z.string()),
	rounding: z.string(),
	badge_precision: integer,
	measured_share: share,
	service_day_base: z.record(z.string(), integer),
	service_day_range: z.tuple([integer, share]),
	service_day_never_below: integer,
	tie_order: z.array(z.string()),
	daytime_first_hour: integer,
	daytime_hours: integer,
	frequent_gap_seconds: integer,
	frequent_min_share: share,
	all_day_min_share: share,
	headline_patterns: z.array(z.string()),
	min_class_ranked: integer,
	relative_filter_share: share,
	relative_filter_small_class: integer,
});
const raw = readFileSync(new URL('./__fixtures__/ranking_vectors.json', import.meta.url), 'utf8');
const document = z
	.object({ rules: rulesSchema, vectors: z.array(z.unknown()) })
	.parse(JSON.parse(raw));
const rules = document.rules;
const vectorSchema = z.object({
	id: z.string(),
	both: z.literal(true),
	spec: specSchema,
	window_days: integer,
	network: z.record(z.string(), integer).nullable(),
	rows: z.array(z.object({ entity_id: z.string(), counts: z.record(z.string(), integer) })),
	expected: z.array(
		z.object({
			entity_id: z.string(),
			state: z.literal('ranked'),
			reason: z.null(),
			rank: z.string(),
			numerator: z.string(),
			denominator: z.string().nullable(),
			shown_units: z.string(),
		}),
	),
});
function vector(id: string) {
	const matches = document.vectors.filter((v) => z.object({ id: z.string() }).parse(v).id === id);
	expect(matches).toHaveLength(1);
	z.object({ cases: z.never().optional() }).parse(matches[0]);
	return vectorSchema.parse(matches[0]);
}
const serialize = (value: unknown) =>
	JSON.parse(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
function verify(id: string) {
	const v = vector(id);
	for (const rows of [v.rows, [...v.rows].reverse()]) {
		expect(serialize(rankEntities(rows, { ...v, rules }))).toEqual(v.expected);
	}
	for (const e of v.expected) {
		expect(shownUnits(BigInt(e.numerator), BigInt(e.denominator ?? '1'), v.spec).toString()).toBe(
			e.shown_units,
		);
	}
}
test('half_exact', () => verify('half_exact'));
test('half_not_exact_in_binary', () => verify('half_not_exact_in_binary'));
test('half_negative', () => verify('half_negative'));
test('past_2_53', () => verify('past_2_53'));
test('shared_rank_keeps_exact_order', () => verify('shared_rank_keeps_exact_order'));
test('id_code_point', () => verify('id_code_point'));
test('code_point_beyond_bmp', () => verify('code_point_beyond_bmp'));
test('operands_past_2_53', () => verify('operands_past_2_53'));

test.each(['trips', 'sample_count'])(
	'exact_ties_use_descending_named_trips_then_code_point_id (%s)',
	(key) => {
		const v = vector('id_code_point');
		const rows = [
			['a', 30n],
			['z', 60n],
			['Z', 60n],
		].map(([id, trips]) => ({
			entity_id: String(id),
			counts: { on_time: 90n, n: 100n, [key]: BigInt(trips) },
		}));
		for (const input of [rows, [...rows].reverse()]) {
			const output = rankEntities(input, { ...v, rules, spec: { ...v.spec, floor_trips_of: key } });
			expect(output.map((r) => [r.entity_id, r.shown_units, r.rank])).toEqual([
				['Z', 900n, 1n],
				['z', 900n, 1n],
				['a', 900n, 1n],
			]);
		}
	},
);

test('precision_zero_and_signed_halves_stay_exact', () => {
	const { spec } = vector('half_negative');
	expect(shownUnits(-13500n, 100n, spec, { precision: 0n })).toBe(-2n);
	expect(shownUnits(-13500n, 100n, spec)).toBe(-23n);
	expect(shownUnits(0n, 100n, spec)).toBe(0n);
});
test('arithmetic_uses_the_supplied_spec_and_denominator_source', () => {
	const v = vector('half_exact');
	const rows = [{ entity_id: 'custom', counts: { custom: 90n, total: 100n, trips: 30n } }];
	const spec = {
		...v.spec,
		numerator: 'custom',
		denominator: 'total',
		denominator_from: 'network' as const,
	};
	expect(rankEntities(rows, { ...v, rules, spec, network: { total: 200n } })).toEqual([
		{
			entity_id: 'custom',
			state: 'ranked',
			reason: null,
			rank: 1n,
			numerator: 90n,
			denominator: 200n,
			shown_units: 450n,
		},
	]);
	expect(
		rankEntities(rows, {
			...v,
			rules,
			spec: { ...spec, denominator: null, scale: [1n, 1n], precision: 0n },
		}),
	).toEqual([
		{
			entity_id: 'custom',
			state: 'ranked',
			reason: null,
			rank: 1n,
			numerator: 90n,
			denominator: null,
			shown_units: 90n,
		},
	]);
	expect(() => rankEntities(rows, { ...v, rules, spec, network: null })).toThrow(/network/);
	expect(() => rankEntities(rows, { ...v, rules, spec, network: {} })).toThrow(/total/);
});

test('unsupported_pair_and_invalid_arithmetic_are_refused', () => {
	const v = vector('half_exact');
	const rank = (spec = v.spec, window_days = 1n, suppliedRules = rules, rows = v.rows) =>
		rankEntities(rows, { spec, window_days, rules: suppliedRules });
	expect(() => rankEntities(v.rows, { ...v, rules, spec: { ...v.spec, pair: v.spec } })).toThrow(
		/pair/,
	);
	expect(() => rank({ ...v.spec, numerator: null })).toThrow(/numerator/);
	expect(() => rank({ ...v.spec, numerator: 'toString' })).toThrow(/toString/);
	for (const key of ['on_time', 'n', 'trips']) {
		const counts = { ...v.rows[0].counts };
		delete counts[key];
		expect(() => rank(v.spec, 1n, rules, [{ entity_id: 'x', counts }])).toThrow(key);
	}
	for (const suppliedRules of [
		{ ...rules, rounding: 'nearest_even' },
		{ ...rules, tie_order: ['id_code_point'] },
		{ ...rules, tie_order: [rules.tie_order.join(',')] },
	]) {
		expect(() => rank(v.spec, 1n, suppliedRules)).toThrow(/rounding|tie order/);
	}
	for (const spec of [
		{ ...v.spec, scale: [0n, 1n] as [bigint, bigint] },
		{ ...v.spec, scale: [1n, -1n] as [bigint, bigint] },
		{ ...v.spec, precision: -1n },
	]) {
		expect(() => rank(spec)).toThrow(RangeError);
		expect(() => shownUnits(1n, 1n, spec)).toThrow(RangeError);
	}
	for (const d of [0n, -1n]) {
		expect(() => shownUnits(1n, d, v.spec)).toThrow(RangeError);
		expect(() =>
			rank(v.spec, 1n, rules, [{ entity_id: 'x', counts: { ...v.rows[0].counts, n: d } }]),
		).toThrow(RangeError);
	}
	for (const days of [0n, -1n]) expect(() => rank(v.spec, days)).toThrow(RangeError);
});

test('ranking_leaves_inputs_unchanged', () => {
	const v = vector('shared_rank_keeps_exact_order');
	const input = { ...v, rules, network: { n: 100n }, rows: [...v.rows].reverse() };
	const before = serialize(input);
	function freeze(value: unknown) {
		if (value && typeof value === 'object') {
			Object.values(value).forEach(freeze);
			Object.freeze(value);
		}
	}
	freeze(input);
	expect(serialize(rankEntities(input.rows, input))).toEqual(v.expected);
	expect(serialize(input)).toEqual(before);
	expect(rankEntities([], input)).toEqual([]);
	const counts = { on_time: 90n, n: 100n, trips: 30n };
	expect(
		rankEntities(
			['aa', 'a'].map((entity_id) => ({ entity_id, counts })),
			{ ...vector('id_code_point'), rules },
		).map((r) => r.entity_id),
	).toEqual(['a', 'aa']);
});

test('later_vector_records_are_preserved_without_execution', () => {
	const ids = [
		'state_per_measure',
		'scheduled_with_no_reading',
		'capped_floor',
		'unresolved_is_not_measured',
		'network_without_late_reading',
		'exact_tie_uses_pair',
		'equal_values_at_90_of_100',
		'pair_both_unavailable',
		'pair_available_before_unavailable',
	];
	const records = raw
		.split('\n')
		.filter((line) => line.startsWith('{"both":'))
		.map((line) => line.replace(/,$/, ''));
	const selected = ids.map((id) => {
		const matches = records.filter(
			(line) => z.object({ id: z.string() }).parse(JSON.parse(line)).id === id,
		);
		expect(matches).toHaveLength(1);
		return matches[0];
	});
	expect(records.filter((line) => selected.includes(line))).toEqual(selected);
	const preserved = selected.join('\n') + '\n';
	expect(Buffer.byteLength(preserved)).toBe(15153);
	expect(createHash('sha256').update(preserved).digest('hex')).toBe(
		'68f16fe1afdc80c731567f3b532669f07a76236112b77dc7ea49f7611fb8ead1',
	);
});
