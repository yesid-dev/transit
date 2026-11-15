export type Counts = Readonly<Record<string, bigint>>;
export type RankingInput = Readonly<{ entity_id: string; counts: Counts }>;
export type MeasureSpec = Readonly<{
	id: string;
	numerator: string | null;
	denominator: string | null;
	denominator_from: 'entity' | 'network';
	scale: readonly [bigint, bigint];
	precision: bigint;
	worse: 'lower' | 'higher';
	series: string;
	floor_trips: bigint | null;
	floor_trips_of: string;
	floor_units: bigint | null;
	floor_units_of: string | null;
	floor_service_days: boolean;
	pair: MeasureSpec | null;
}>;
export type RankingRules = Readonly<{
	version: bigint;
	default_measure: string;
	measures: readonly string[];
	windows: readonly string[];
	rounding: string;
	badge_precision: bigint;
	measured_share: readonly [bigint, bigint];
	service_day_base: Counts;
	service_day_range: readonly [bigint, readonly [bigint, bigint]];
	service_day_never_below: bigint;
	tie_order: readonly string[];
	daytime_first_hour: bigint;
	daytime_hours: bigint;
	frequent_gap_seconds: bigint;
	frequent_min_share: readonly [bigint, bigint];
	all_day_min_share: readonly [bigint, bigint];
	headline_patterns: readonly string[];
	min_class_ranked: bigint;
	relative_filter_share: readonly [bigint, bigint];
	relative_filter_small_class: bigint;
}>;
export type RankedEntity = Readonly<{
	entity_id: string;
	state: 'ranked';
	reason: null;
	rank: bigint;
	numerator: bigint;
	denominator: bigint | null;
	shown_units: bigint;
}>;

export function shownUnits(
	numerator: bigint,
	denominator: bigint,
	spec: MeasureSpec,
	options?: Readonly<{ precision?: bigint | null }>,
): bigint {
	const p = options?.precision ?? spec.precision;
	if (denominator <= 0n || p < 0n || spec.scale.some((s) => s <= 0n))
		throw new RangeError('positive denominator/scale and nonnegative precision required');
	const n = numerator * spec.scale[0] * 10n ** p;
	const d = denominator * spec.scale[1];
	return (n < 0n ? -1n : 1n) * ((2n * (n < 0n ? -n : n) + d) / (2n * d));
}

/** Already-eligible, unique entities over a closed window; eligibility belongs to the caller. */
export function rankEntities(
	rows: readonly RankingInput[],
	options: Readonly<{
		spec: MeasureSpec;
		window_days: bigint;
		rules: RankingRules;
		network?: Counts | null;
	}>,
): RankedEntity[] {
	const { spec, rules, window_days } = options;
	if (spec.pair !== null) throw new Error('pair is unsupported');
	if (spec.numerator === null) throw new Error('named numerator required');
	if (window_days <= 0n) throw new RangeError('positive window_days required');
	shownUnits(0n, 1n, spec);
	if (
		rules.rounding !== 'half_away_from_zero' ||
		rules.tie_order.length !== 4 ||
		['exact_value', 'pair', 'trips_desc', 'id_code_point'].some(
			(key, i) => rules.tie_order[i] !== key,
		)
	)
		throw new Error('unsupported rounding or tie order');
	const trips = new Map(rows.map((r) => [r.entity_id, count(r.counts, spec.floor_trips_of)]));
	const ordered: RankedEntity[] = rows.map((row) => {
		if (spec.numerator === null) throw new Error('named numerator required');
		const numerator = count(row.counts, spec.numerator);
		const denominator =
			spec.denominator === null
				? null
				: count(
						spec.denominator_from === 'network' ? options.network : row.counts,
						spec.denominator,
					);
		return {
			entity_id: row.entity_id,
			state: 'ranked',
			reason: null,
			rank: 1n,
			numerator,
			denominator,
			shown_units: shownUnits(numerator, denominator ?? 1n, spec),
		};
	});
	ordered.sort((a, b) => {
		const difference = a.numerator * (b.denominator ?? 1n) - b.numerator * (a.denominator ?? 1n);
		return difference === 0n
			? trips.get(a.entity_id)! === trips.get(b.entity_id)!
				? compareIds(a.entity_id, b.entity_id)
				: trips.get(a.entity_id)! > trips.get(b.entity_id)!
					? -1
					: 1
			: (difference < 0n ? -1 : 1) * (spec.worse === 'lower' ? 1 : -1);
	});
	let position = 0n;
	let rank = 0n;
	let previous: bigint | undefined;
	return ordered.map((item) => {
		position += 1n;
		if (item.shown_units !== previous) rank = position;
		previous = item.shown_units;
		return { ...item, rank };
	});
}

function compareIds(a: string, b: string): -1 | 0 | 1 {
	const left = Array.from(a, (c) => c.codePointAt(0)!);
	const right = Array.from(b, (c) => c.codePointAt(0)!);
	for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
		if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
	}
	return left.length === right.length ? 0 : left.length < right.length ? -1 : 1;
}
function count(counts: Counts | null | undefined, key: string): bigint {
	if (counts == null) throw new Error('network counts required');
	if (!Object.hasOwn(counts, key) || counts[key] === undefined)
		throw new Error(`missing count: ${key}`);
	return counts[key];
}
