import { stampCopy } from '../src/lib/v1/stamp.copy.ts';
import { closedTrendPoints, trendClosedThrough } from '../src/lib/v1/closedWindow.ts';
import rich from './__fixtures__/b9/rich.json' with { type: 'json' };
import sparse from './__fixtures__/b9/sparse.json' with { type: 'json' };

export const FIXTURES = Object.freeze({ rich, sparse });
export const SURFACES = Object.freeze(['line', 'stop', 'network']);
export const MARK_KINDS = Object.freeze(
	'trend histogram dot-strip magnitude-bars line sparkline bullet heatmap stacked-share service-span'.split(
		' ',
	),
);

const CLOCK_NORMALIZATION_ALLOWLIST = Object.freeze([
	{
		id: 'frozen-freshness-now',
		pattern: /\b(?:just now|à l'instant)\b/gu,
		replacement: '<fresh-now>',
	},
	{
		id: 'ephemeral-loopback-port',
		pattern: /http:\/\/127\.0\.0\.1:\d+/gu,
		replacement: 'http://127.0.0.1:<port>',
	},
	{
		id: 'ssr-relative-freshness-minute',
		pattern: /\b(?:\d+ minutes? ago|il y a \d+ minutes?)\b/giu,
		replacement: '<fresh-minutes>',
	},
]);

function invariant(condition, message) {
	if (!condition) throw new Error(`B9 oracle invariant: ${message}`);
}

export function normalizeObservation(value) {
	let normalized = String(value)
		.replace(/[\t\n\r ]+/gu, ' ')
		.trim();
	for (const rule of CLOCK_NORMALIZATION_ALLOWLIST) {
		normalized = normalized.replace(rule.pattern, rule.replacement);
	}
	return normalized;
}

function stable(value) {
	if (Array.isArray(value)) return value.map(stable);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, stable(value[key])]),
		);
	}
	return value;
}

export function compareObservations(expected, actual, label = 'observations') {
	const toMap = (rows, side) => {
		const out = new Map();
		for (const row of rows) {
			invariant(row && typeof row.id === 'string' && row.id !== '', `${label} ${side} id`);
			invariant(!out.has(row.id), `${label} duplicate ${side} observation ${row.id}`);
			out.set(row.id, stable(row.value));
		}
		return out;
	};
	const want = toMap(expected, 'expected');
	const got = toMap(actual, 'actual');
	const missing = [...want.keys()].filter((key) => !got.has(key));
	const extra = [...got.keys()].filter((key) => !want.has(key));
	const wrong = [...want.keys()].flatMap((key) => {
		if (!got.has(key)) return [];
		const left = JSON.stringify(want.get(key));
		const right = JSON.stringify(got.get(key));
		return left === right ? [] : [`${key}: expected ${left}, got ${right}`];
	});
	if (missing.length || extra.length || wrong.length) {
		throw new Error(
			`B9 ${label} mismatch` +
				(missing.length ? `\nmissing: ${missing.join(', ')}` : '') +
				(extra.length ? `\nextra: ${extra.join(', ')}` : '') +
				(wrong.length ? `\nwrong:\n${wrong.join('\n')}` : ''),
		);
	}
	return { observations: want.size };
}

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const round = (value, digits = 1) => {
	const factor = 10 ** digits;
	return Math.round((value + Number.EPSILON) * factor) / factor;
};
const pct = (numerator, denominator, digits = 1) =>
	numerator != null && denominator > 0 ? round((100 * numerator) / denominator, digits) : null;
const verdictCount = (otp, n, onTime, wilsonLo, wilsonHi) => {
	if (otp == null || n == null || n < 0) return null;
	if (n < 30) return n;
	if (onTime == null) {
		if (
			wilsonLo == null ||
			wilsonHi == null ||
			!Number.isFinite(wilsonLo) ||
			!Number.isFinite(wilsonHi) ||
			wilsonLo < 0 ||
			wilsonLo > wilsonHi ||
			wilsonHi > 100
		)
			return n;
		return (wilsonLo >= 80 && Math.round(otp) >= 80) || wilsonHi < 80 ? null : n;
	}
	const successes = onTime;
	const z2 = 1.96 ** 2;
	const center = (successes / n + z2 / (2 * n)) / (1 + z2 / n);
	const margin =
		(1.96 * Math.sqrt(((successes / n) * (1 - successes / n)) / n + z2 / (4 * n * n))) /
		(1 + z2 / n);
	return (center - margin >= 0.8 && Math.round(otp) >= 80) || center + margin < 0.8 ? null : n;
};
const latestDated = (rows) =>
	rows
		.filter((row) => typeof row.date === 'string')
		.slice()
		.sort((a, b) => a.date.localeCompare(b.date))
		.at(-1) ?? null;
const observedEndpoint = (iso, locale) =>
	typeof iso === 'string'
		? new Intl.DateTimeFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', {
				timeZone: 'America/Toronto',
				year: 'numeric',
				month: 'short',
				day: 'numeric',
				hour: '2-digit',
				minute: '2-digit',
				second: '2-digit',
				hourCycle: 'h23',
				timeZoneName: 'shortOffset',
			}).format(new Date(iso))
		: null;
const observation = (id, value) => ({ id, value });
const OCCUPANCY = Object.freeze(['empty', 'many_seats', 'few_seats', 'standing', 'full']);
const STATUS = Object.freeze(['early', 'on_time', 'late', 'severe', 'unknown']);
const SHIFTS = Object.freeze(['am_peak', 'midday', 'pm_peak', 'evening', 'night']);
const DAY_TYPES = Object.freeze(['weekday', 'weekend']);

const TABLE_COPY = Object.freeze({
	en: {
		x: 'x',
		group: 'group',
		row: 'row',
		day: 'Day of week',
		shift: 'Shift',
		dayType: 'Day type',
		weekday: 'Weekday',
		weekend: 'Weekend',
		otp: 'On-time',
		avg: 'Avg delay',
		avgStop: 'Average delay',
		severe: 'Severe-delay share',
		scheduled: 'Scheduled gap',
		observed: 'Gap between first reports',
		excess: 'Excess wait',
		cov: 'Spread (CoV)',
		bunched: 'Closely spaced appearances',
		bin: 'bin (min)',
		trips: 'trips',
		observations: 'observations',
		crowdingBand: 'Crowding band',
		networkOtp: 'On-time %',
		networkDelay: 'Slowest 10% (min)',
		canceled: '% canceled trip-days',
	},
	fr: {
		x: 'axe x',
		group: 'groupe',
		row: 'ligne',
		day: 'Jour de la semaine',
		shift: 'Période',
		dayType: 'Type de jour',
		weekday: 'Semaine',
		weekend: 'Fin de semaine',
		otp: 'Ponctualité',
		avg: 'Retard moyen',
		avgStop: 'Retard moyen',
		severe: 'Part des retards graves',
		scheduled: 'Intervalle prévu',
		observed: 'Intervalle entre premiers relevés',
		excess: 'Attente excédentaire',
		cov: 'Régularité (CV)',
		bunched: 'Apparitions rapprochées',
		bin: 'intervalle (min)',
		trips: 'trajets',
		observations: 'relevés',
		crowdingBand: "Niveau d'occupation",
		networkOtp: 'Ponctualité %',
		networkDelay: '10 % les plus lents (min)',
		canceled: '% de jours-trajets annulés',
	},
});

const TIER_TEXT = Object.freeze({
	en: [
		'Low relative score',
		'Moderate relative score',
		'High relative score',
		'◆ Very high relative score',
	],
	fr: [
		'Score relatif faible',
		'Score relatif modéré',
		'Score relatif élevé',
		'◆ Score relatif très élevé',
	],
});

const noDataText = (locale) => (locale === 'fr' ? 'Aucune donnée' : 'No data');
const cell = (value, suffix = '', absent = '') => ({
	value,
	text: value == null ? absent : `${value}${suffix}`,
});
const table = (headers, rows, suffixes = [], absent = '') => ({
	headers: rows.length ? headers : [],
	rows: rows.map(([key, ...values]) => [
		key,
		...values.map((value, index) => cell(value, suffixes[index] ?? '', absent)),
	]),
});
const trendTable = (headers, rows, locale, units) => ({
	headers: rows.length ? headers : [],
	rows: rows.map(([label, ...values]) => [
		label,
		...values.map((value, index) => {
			const rounded = value == null ? null : Math.sign(value) * round(Math.abs(value), 1);
			return {
				value: rounded,
				text:
					rounded == null
						? noDataText(locale)
						: new Intl.NumberFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', {
								maximumFractionDigits: 1,
							}).format(rounded) + units[index],
			};
		}),
	]),
});
const shareTable = (rows) => table([], rows, ['%']);
const heatmapTable = (tiers, locale) => ({
	headers: tiers.length
		? [
				TABLE_COPY[locale].day,
				...Array.from({ length: 24 }, (_, hour) => `${String(hour).padStart(2, '0')}:00`),
			]
		: [],
	rows: tiers.map((row) =>
		row.map((tier) => ({
			tier,
			text: tier == null ? noDataText(locale) : TIER_TEXT[locale][tier],
		})),
	),
});

function histogramTable(rows, locale, seconds = false, countLabel = TABLE_COPY[locale].trips) {
	const rangeTo = locale === 'fr' ? 'à' : 'to';
	const fmt = (value) =>
		new Intl.NumberFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', { maximumFractionDigits: 1 }).format(
			seconds ? value / 60 : value,
		);
	return {
		headers: rows?.length ? [TABLE_COPY[locale].bin, countLabel] : [],
		rows: (rows ?? []).map((row) => {
			const lo = finite(row.lo ?? row.lo_sec ?? row.lo_min ?? row[0]);
			const hi = finite(row.hi ?? row.hi_sec ?? row.hi_min ?? row[1]);
			const count = finite(row.count ?? row[2]);
			return {
				lo,
				hi,
				count,
				text: [
					`${lo == null ? '-∞' : fmt(lo)} ${rangeTo} ${hi == null ? '+∞' : fmt(hi)} min`,
					`${count}`,
				],
			};
		}),
	};
}

const FULL_WEEKDAYS = Object.freeze({
	en: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
	fr: ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'],
});
const OCCUPANCY_LABELS = Object.freeze({
	en: {
		empty: 'Empty',
		many_seats: 'Many seats',
		few_seats: 'Few seats',
		standing: 'Standing',
		full: 'Full',
	},
	fr: {
		empty: 'Vide',
		many_seats: 'Plusieurs places',
		few_seats: 'Peu de places',
		standing: 'Debout',
		full: 'Plein',
	},
});
const PRIOR_COPY = Object.freeze({
	en: {
		onTime: 'on-time',
		wait: 'wait',
		prior: 'vs prior day',
		none: 'no prior day',
		pts: 'pts',
		pt: 'pt',
	},
	fr: {
		onTime: 'ponctualité',
		wait: 'attente',
		prior: 'p/r à la veille',
		none: 'pas de veille',
		pts: 'pts',
		pt: 'pt',
	},
});
const COMPARE_LABELS = Object.freeze({
	en: {
		am_peak: 'AM peak',
		midday: 'Midday',
		pm_peak: 'PM peak',
		evening: 'Evening',
		night: 'Night',
		weekday: 'Weekday',
		weekend: 'Weekend',
	},
	fr: {
		am_peak: 'Pointe AM',
		midday: 'Journée',
		pm_peak: 'Pointe PM',
		evening: 'Soirée',
		night: 'Nuit',
		weekday: 'Semaine',
		weekend: 'Fin de semaine',
	},
});

function bestTimeText(habits, locale) {
	const observed = (habits?.matrix ?? [])
		.flatMap((row, day) =>
			row.flatMap((value, hour) => {
				const score = finite(value);
				return score != null && score >= 0 && score <= 1 ? [{ day, hour, score }] : [];
			}),
		)
		.sort((a, b) => b.score - a.score || a.day - b.day || a.hour - b.hour);
	if (observed.length < 2 || observed[0].score === observed.at(-1).score) return null;
	const peak = observed[0];
	const day = FULL_WEEKDAYS[locale][peak.day];
	const hour = `${String(peak.hour).padStart(2, '0')}:00`;
	return locale === 'fr'
		? `Un pic observé du score relatif de cette ligne : ${day}, ${hour}.`
		: `An observed peak in this line’s relative score: ${day}, ${hour}.`;
}

function compareDisplay(row, key, locale, type) {
	const copy = PRIOR_COPY[locale];
	const noun = copy[type];
	const ariaNoun = `${COMPARE_LABELS[locale][key] ?? key} ${noun}`;
	const value = type === 'onTime' ? finite(row.otp_pct) : finite(row.observed_min);
	const prior = type === 'onTime' ? finite(row.prior_otp_pct) : finite(row.prior_observed_min);
	const difference = value == null || prior == null ? null : finite(value - prior);
	const change =
		difference == null
			? null
			: Number(
					new Intl.NumberFormat('en', {
						useGrouping: false,
						maximumFractionDigits: type === 'onTime' ? 0 : 1,
						roundingMode: 'halfExpand',
					}).format(difference),
				);
	const state = change == null ? 'absent' : change === 0 ? 'flat' : 'change';
	const text =
		value == null
			? noDataText(locale)
			: type === 'onTime'
				? `${value}%`
				: `${value.toFixed(1)} min`;
	let delta;
	if (state === 'absent') delta = `${ariaNoun} ${copy.none}`;
	else {
		const shown =
			type === 'onTime'
				? `${change > 0 ? '+' : ''}${change} ${Math.abs(change) === 1 ? copy.pt : copy.pts}`
				: `${change > 0 ? '+' : ''}${change.toFixed(1)} min`;
		delta = `change ${shown} ${ariaNoun} ${copy.prior}`;
	}
	return { key, value: { value, text }, state, delta };
}

const countText = (value, locale) =>
	new Intl.NumberFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', { maximumFractionDigits: 0 }).format(
		value,
	);
const relativeSeconds = (seconds, locale) => {
	if (Math.abs(seconds) < 5) return locale === 'fr' ? 'maintenant' : 'now';
	const units = [
		['year', 31_536_000],
		['month', 2_592_000],
		['week', 604_800],
		['day', 86_400],
		['hour', 3_600],
		['minute', 60],
		['second', 1],
	];
	const [unit, size] = units.find(([, size]) => Math.abs(seconds) >= size);
	return new Intl.RelativeTimeFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', {
		numeric: 'auto',
	}).format(-Math.round(seconds / size), unit);
};

function conformanceDisplay(conformance, locale) {
	if (conformance == null) return null;
	const verdict =
		conformance.status === 'conformant'
			? 'conformant'
			: conformance.status === 'out_of_norm'
				? 'out_of_norm'
				: 'unknown';
	const members = conformance.unknown_members ?? [];
	const preview =
		members.length > 3
			? `${members.slice(0, 3).join(', ')}, +${members.length - 3}`
			: members.join(', ');
	const label =
		verdict === 'conformant'
			? locale === 'fr'
				? 'Flux conforme'
				: 'Feed compliant'
			: verdict === 'out_of_norm'
				? locale === 'fr'
					? 'Flux hors-norme'
					: 'Feed out-of-norm'
				: conformance.status;
	const detail =
		verdict === 'out_of_norm' && members.length
			? locale === 'fr'
				? `· ${members.length} champ${members.length > 1 ? 's' : ''} non modélisé${members.length > 1 ? 's' : ''} (${preview})`
				: `· ${members.length} unmodelled field${members.length > 1 ? 's' : ''} (${preview})`
			: null;
	const title =
		verdict === 'out_of_norm'
			? locale === 'fr'
				? `Le flux contient des champs hors du modèle standard (${members.join(', ')}) : ${countText(conformance.extra_row_count ?? 0, locale)} ligne(s) conservée(s) telles quelles, jamais supprimées.`
				: `The feed carries fields beyond the standard model (${members.join(', ')}): ${countText(conformance.extra_row_count ?? 0, locale)} row(s) captured verbatim, never dropped.`
			: locale === 'fr'
				? 'Le flux GTFS le plus récent ne contient que des champs que la chaîne de traitement modélise.'
				: 'The latest GTFS feed only carries fields the pipeline models.';
	return {
		verdict,
		label: label.toLocaleUpperCase(locale === 'fr' ? 'fr-CA' : 'en-CA'),
		detail,
		title,
	};
}

function shareRows(values, keys) {
	if (values == null) return [];
	const total = keys.reduce((sum, key) => sum + Math.max(0, finite(values[key]) ?? 0), 0);
	return total > 0
		? keys.flatMap((key) => {
				const value = Math.max(0, finite(values[key]) ?? 0);
				return value > 0 ? [[key, Math.round((value / total) * 100)]] : [];
			})
		: [];
}

function dominantShare(values, keys) {
	if (values == null) return null;
	const bands = keys.map((key) => [key, Math.max(0, finite(values[key]) ?? 0)]);
	const total = bands.reduce((sum, [, value]) => sum + value, 0);
	if (total <= 0) return null;
	const dominant = bands.reduce((best, row) => (row[1] > best[1] ? row : best));
	return [dominant[0], Math.round((dominant[1] / total) * 100)];
}

function heatmapTiers(habits) {
	const matrix = habits?.matrix ?? [];
	if (!matrix.some((row) => row.some((value) => finite(value) != null))) return [];
	return Array.from({ length: 7 }, (_, row) =>
		Array.from({ length: 24 }, (_, column) => {
			const value = finite(matrix[row]?.[column]);
			if (value == null) return null;
			return Math.min(3, Math.floor(Math.min(1, Math.max(0, value)) * 4));
		}),
	);
}

function meanMix(rows) {
	const present = rows.filter((row) => row.mix != null);
	if (present.length === 0) return null;
	const weighted = present.every((row) => finite(row.n) > 0);
	const denominator = weighted ? present.reduce((sum, row) => sum + row.n, 0) : present.length;
	return Object.fromEntries(
		OCCUPANCY.map((key) => [
			key,
			present.reduce((sum, row) => sum + (finite(row.mix[key]) ?? 0) * (weighted ? row.n : 1), 0) /
				denominator,
		]),
	);
}

const ids = (value) => Object.freeze(value.trim().split(/\s+/u));
export const OBSERVATION_IDS = Object.freeze({
	line: ids(`line.day.otp_pct line.day.avg_delay_min line.day.p50_min line.day.p90_min
		line.day.severe_pct line.day.observation_count line.day.cancellation_pct line.day.skipped_pct
		line.day.completeness_pct line.day.scheduled_counts line.service_span line.weak_stops.eligible_ids
		line.weak_stops.hrefs line.weak_stops.raw_count line.pane.freshness_iso line.trend.rows
		line.habits.tiers line.time.rows line.headway.rows line.occupancy.shares
		line.delay_by_crowding line.week.histogram`),
	stop: ids(`stop.day.late_pct stop.day.p50_min stop.day.p90_min stop.record.answer
		stop.day.observation_count stop.daily.rows stop.daily.limits stop.routes.ranked stop.habits.tiers
		stop.weekday.rows stop.time.rows stop.occupancy.shares stop.display.scalars stop.pane.freshness_iso`),
	network: ids(`network.live.vehicles network.live.on_time_pct network.live.coverage_pct
		network.live.p50_min network.live.p90_min network.live.non_responding network.live.status_shares
		network.live.occupancy_shares network.live.histogram network.live.silent_routes
		network.verdict.delta_pct network.latest.completeness_pct network.trend.rows
		network.vehicles.rows network.cancellations.rows network.occupancy.rows
		network.shift.rows network.daytype.rows`),
});

function rawFile(fixture, path) {
	const value = fixture.files[path];
	invariant(value && typeof value === 'object', `${fixture.name} missing raw ${path}`);
	return value;
}

function routeFile(fixture) {
	return rawFile(fixture, 'historic/route_reliability/24.json');
}
export function expectedDefaultLineHeadline(fixture) {
	const file = routeFile(fixture);
	const through = file.periods_by_grain?.find((row) => row.grain === 'day')?.date;
	const rows = file.periods_by_grain?.find((row) => row.grain === 'week')?.by_daytype;
	if (!through || !rows?.length) return null;
	const n = rows.reduce((n, r) => n + r.observation_count, 0);
	const on = rows.reduce((n, r) => n + r.on_time, 0);
	return {
		grain: 'week',
		otp_pct: n > 0 ? Math.round((100 * on) / n) : null,
		observation_count: n,
		on_time: on,
	};
}
export function expectedScheduleTruth(fixture) {
	const route = routeFile(fixture);
	const date =
		route.periods_by_grain?.find((row) => row.grain === 'day')?.date ??
		latestDated((route.periods ?? []).filter((row) => row.grain === 'day'))?.date;
	const receiptsPath = fixture.files['manifest.json'].files.historic.receipts_index;
	const receipts = fixture.files[receiptsPath];
	const availability = (receipts?.available ?? []).find((row) => row.date === date);
	invariant(
		typeof date === 'string' && availability != null,
		'latest route day lacks receipt availability truth',
	);
	return { date, hasData: availability.has_data, hasSchedule: availability.has_schedule === true };
}

function stopFile(fixture) {
	return rawFile(fixture, 'historic/stop_reliability/52095.json');
}

function networkFile(fixture) {
	return rawFile(fixture, 'live/network.json');
}

function networkTrend(fixture) {
	return rawFile(fixture, 'historic/network_trend.json');
}

function retainedLineDays(fixture, view) {
	if (!view.includes('from=')) return [];
	const params = new URLSearchParams(view.split('?')[1] ?? '');
	const from = params.get('from');
	const to = params.get('to');
	const path = Object.keys(fixture.files).find((candidate) =>
		/^historic\/history\/lines\/3234\/generations\/[0-9a-f]{64}\/\d{4}-\d{2}\.json$/u.test(
			candidate,
		),
	);
	return path
		? (rawFile(fixture, path).days ?? []).filter(
				(row) => (!from || from <= row.date) && (!to || row.date <= to),
			)
		: [];
}

function retainedStopDays(fixture, view) {
	if (!view.includes('from=')) return null;
	const params = new URLSearchParams(view.split('?')[1] ?? '');
	const from = params.get('from');
	const to = params.get('to');
	return Object.keys(fixture.files)
		.filter((candidate) =>
			/^historic\/history\/stops\/3532303935\/generations\/[0-9a-f]{64}\/\d{4}-\d{2}\.json$/u.test(
				candidate,
			),
		)
		.flatMap((path) => rawFile(fixture, path).days ?? [])
		.filter((row) => (!from || from <= row.date) && (!to || row.date <= to));
}

function stopOccupancyMix(raw, retained) {
	if (retained == null) return raw.occupancy_mix;
	return Object.fromEntries(
		OCCUPANCY.map((key) => [
			key,
			retained.reduce((sum, row) => sum + (finite(row.occupancy?.[key]) ?? 0), 0),
		]),
	);
}

function sumField(rows, group, field) {
	return rows.reduce((sum, row) => sum + (finite(row[group]?.[field]) ?? 0), 0);
}

const localeTag = (locale) => (locale === 'fr' ? 'fr-CA' : 'en-CA');
const isCount = (value) => Number.isInteger(value) && value >= 0;
/** A published reading count is whole and at least one; an unpublished one is no objection. */
const readingsValid = (row) =>
	row?.observation_count == null || (isCount(row.observation_count) && row.observation_count > 0);

/**
 * A share of readings on time, from its definition: with both counts published, on time over
 * readings, rounded half up to `digits`; with no on-time count, the published share itself.
 */
function shareOf(row, digits) {
	if (!readingsValid(row)) return null;
	const n = row?.observation_count;
	const on = row?.on_time;
	const scale = 10 ** digits;
	if (on != null)
		return n != null && isCount(on) && on <= n
			? Math.floor((200 * scale * on + n) / (2 * n)) / scale
			: null;
	const otp = finite(row?.otp_pct);
	return otp != null && otp >= 0 && otp <= 100
		? Math.sign(otp) * round(Math.abs(otp), digits)
		: null;
}

/** The record answer: a whole percent, never from a share the record does not publish. */
const recordShare = (row) => (finite(row?.otp_pct) == null ? null : shareOf(row, 0));

const tenthPct = (value, locale) =>
	new Intl.NumberFormat(localeTag(locale), {
		style: 'percent',
		minimumFractionDigits: 1,
		maximumFractionDigits: 1,
	}).format(value / 100);
const TIME_OF_DAY_COPY = Object.freeze({
	en: {
		headers: ['Period', 'On time', 'Readings'],
		dayType: 'Day type',
		absent: 'Not published for this period',
	},
	fr: {
		headers: ['Période', 'À l’heure', 'Relevés'],
		dayType: 'Type de jour',
		absent: 'Non publié pour cette période',
	},
});
const STOP_COPY = Object.freeze({
	en: {
		valueNote: ' of readings more than 5 minutes late',
		reading: 'reading',
		readings: 'readings',
	},
	fr: {
		valueNote: ' des relevés avec plus de 5 minutes de retard',
		reading: 'relevé',
		readings: 'relevés',
	},
});
const GAPS_COPY = Object.freeze({
	en: {
		headers: ['Period', 'Scheduled', 'Between first reports'],
		summary:
			'Waiting time is not measured here. These are gaps between first reports, not arrivals at your stop.',
		frequency:
			'Frequent service Which periods count as frequent will come from a published classification. Transit never guesses it from a line’s name or from one schedule period.',
	},
	fr: {
		headers: ['Période', 'Prévu', 'Entre premiers relevés'],
		summary:
			'Le temps d’attente n’est pas mesuré ici. Ce sont des intervalles entre les premiers relevés, pas entre les passages à votre arrêt.',
		frequency:
			'Service fréquent Les périodes considérées comme fréquentes viendront d’une classification publiée. Transit ne la devine jamais à partir du nom d’une ligne ni d’une seule période de l’horaire.',
	},
});
const LINE_DAILY_COPY = Object.freeze({
	en: { headers: ['Day', 'On time', 'Readings', 'Average delay'], gap: 'Not published' },
	fr: { headers: ['Jour', 'À l’heure', 'Relevés', 'Retard moyen'], gap: 'Non publié' },
});
const DAY_SIGNAL = ['otp_pct', 'avg_delay_min', 'p50_min', 'p90_min', 'severe_pct'];

/** Day by day: one share a day, tenths rounded half up from integer counts, with its own table. */
function lineDailyTable(raw, closedDate, view, locale, retained) {
	const params = new URLSearchParams(view.split('?')[1] ?? '');
	const from = params.get('from');
	const to = params.get('to');
	const byDate = new Map();
	if (from && to) {
		// A chosen range is built from its retained days only: counts and delay sums per day.
		for (const row of retained) {
			const delay = row.delay;
			if (delay == null) continue;
			const n = finite(delay.observation_count);
			const clamped = finite(delay.in_clamp_observation_count);
			const sum = finite(delay.sum_delay_seconds);
			byDate.set(row.date, {
				date: row.date,
				observation_count: n,
				on_time: finite(delay.on_time_count),
				otp_pct: n > 0 ? pct(finite(delay.on_time_count), n, 0) : null,
				avg_delay_min: clamped > 0 && sum != null ? sum / clamped / 60 : null,
			});
		}
	} else
		for (const row of raw.periods ?? [])
			if (row.grain === 'day' && row.date && DAY_SIGNAL.some((key) => row[key] != null))
				byDate.set(row.date, row);
	// The window: a chosen range, or the latest complete day and the 13 days before it.
	const day = (key, shift = 0) =>
		new Date(Date.parse(`${key}T00:00:00Z`) + shift * 86_400_000).toISOString().slice(0, 10);
	const latest = (raw.periods ?? [])
		.filter(
			(row) => row.grain === 'day' && row.date && closedDate != null && row.date <= closedDate,
		)
		.map((row) => row.date)
		.sort()
		.at(-1);
	const [lo, hi] =
		from && to ? (from <= to ? [from, to] : [to, from]) : latest ? [day(latest, -13), latest] : [];
	const dates = [];
	for (let key = lo; key && key <= hi; key = day(key, 1)) dates.push(key);
	// Every day of the window has a row; a day the record does not publish is a gap.
	const rows = dates.map((date) => byDate.get(date) ?? { date });
	const tag = localeTag(locale);
	const copy = LINE_DAILY_COPY[locale];
	const cell = (value, text) => ({ value, text: value == null ? copy.gap : text(value) });
	return {
		headers: rows.length ? copy.headers : [],
		rows: rows.map((row) => {
			const share = shareOf(row, 1);
			const counted = share != null && row.observation_count != null;
			const avg = row.observation_count === 0 ? null : finite(row.avg_delay_min);
			return [
				new Intl.DateTimeFormat(tag, {
					weekday: 'long',
					month: 'long',
					day: 'numeric',
					timeZone: 'UTC',
				}).format(new Date(`${row.date}T00:00:00Z`)),
				cell(share, (value) =>
					new Intl.NumberFormat(tag, { style: 'percent', maximumFractionDigits: 1 }).format(
						value / 100,
					),
				),
				cell(counted ? row.observation_count : null, (value) =>
					new Intl.NumberFormat(tag).format(value),
				),
				cell(
					avg == null ? null : Math.sign(avg) * round(Math.abs(avg)) + 0,
					(value) =>
						`${new Intl.NumberFormat(tag, { maximumFractionDigits: 1 }).format(value)} min`,
				),
			];
		}),
	};
}

function lineOracle(fixture, locale, view) {
	const raw = routeFile(fixture);
	const closedDate = raw.periods_by_grain?.find((row) => row.grain === 'day')?.date;
	const closedDay = (raw.periods ?? []).find((p) => p.grain === 'day' && p.date === closedDate);
	const retained = retainedLineDays(fixture, view);
	const observationN = sumField(retained, 'delay', 'observation_count');
	const delayN = sumField(retained, 'delay', 'in_clamp_observation_count');
	const day = retained.length
		? {
				date: retained.at(-1).date,
				otp_pct: pct(sumField(retained, 'delay', 'on_time_count'), observationN, 0),
				on_time: sumField(retained, 'delay', 'on_time_count'),
				avg_delay_min: delayN
					? round(sumField(retained, 'delay', 'sum_delay_seconds') / delayN / 60)
					: null,
				p50_min:
					retained.length === 1
						? round(retained[0].delay_percentiles?.p50_delay_seconds / 60)
						: null,
				p90_min:
					retained.length === 1
						? round(retained[0].delay_percentiles?.p90_delay_seconds / 60)
						: null,
				severe_pct: pct(sumField(retained, 'delay', 'severe_count'), delayN),
				observation_count: sumField(retained, 'delay', 'observation_count'),
			}
		: closedDay;
	const cancellation = retained.length
		? Object.fromEntries(
				[
					'canceled_trip_days',
					'total_trip_days',
					'scheduled_trip_days',
					'delivered_trip_days',
					'silent_trip_days',
				].map((field) => [field, sumField(retained, 'cancellation', field)]),
			)
		: ((raw.cancellations ?? []).find((row) => row.date === closedDate) ?? null);
	const skipped = retained.length
		? {
				skipped_stop_count: sumField(retained, 'skipped_stops', 'skipped_stop_count'),
				stop_time_update_count: sumField(retained, 'skipped_stops', 'stop_time_update_count'),
			}
		: ((raw.skipped_stops ?? []).find((row) => row.date === closedDate) ?? null);
	const retainedSpan = retained.at(-1)?.service_span;
	const span = retainedSpan
		? {
				date: retained.at(-1).date,
				first_trip_utc: retainedSpan.first_trip_utc,
				last_trip_utc: retainedSpan.last_trip_utc,
				service_span_min: round(
					(Date.parse(retainedSpan.last_trip_utc) - Date.parse(retainedSpan.first_trip_utc)) /
						60_000,
					0,
				),
				first_trip_delay_min: round(retainedSpan.first_trip_delay_seconds / 60),
				last_trip_delay_min: round(retainedSpan.last_trip_delay_seconds / 60),
				trip_count: retainedSpan.trip_count,
			}
		: view.includes('from=')
			? null
			: latestDated(raw.service_spans ?? []);
	const hasSpanPair =
		typeof span?.first_trip_utc === 'string' && typeof span?.last_trip_utc === 'string';
	const windowedStops =
		(raw.weak_stops_by_grain ?? []).find((row) => row.grain === 'day')?.stops ?? [];
	const eligibleStops = windowedStops.map((row) => {
		const n = finite(row.observation_count);
		const severe = finite(row.severe_pct);
		const lower = finite(row.wilson_lo);
		const upper = finite(row.wilson_hi);
		const notSevere = severe == null ? null : 100 - severe;
		invariant(
			n >= 30 &&
				severe != null &&
				lower != null &&
				upper != null &&
				lower <= upper &&
				notSevere >= lower - 0.2 &&
				notSevere <= upper + 0.2,
			'invalid weak-stop publisher row',
		);
		return row;
	});
	const independentlyRanked = eligibleStops
		.slice()
		.sort(
			(a, b) =>
				a.wilson_lo - b.wilson_lo ||
				(finite(b.avg_delay_min) ?? 0) - (finite(a.avg_delay_min) ?? 0) ||
				a.id.localeCompare(b.id),
		);
	invariant(
		independentlyRanked.every((row, index) => row.id === eligibleStops[index]?.id),
		'weak-stop publisher order does not match Wilson, delay, and id ranking',
	);
	const chosenRange = view.includes('from=');
	// A chosen range has no stop, time-of-day or gap cut of its own: those sections say so instead.
	const listedStops = chosenRange
		? []
		: eligibleStops
				.map((row, index) => ({ row, index }))
				.sort(
					(a, b) =>
						b.row.severe_pct - a.row.severe_pct ||
						b.row.observation_count - a.row.observation_count ||
						a.index - b.index,
				)
				.map(({ row }) => row);
	const windowedBreakdown = (raw.periods_by_grain ?? []).find((row) => row.grain === 'day');
	const breakdown = windowedBreakdown ?? {
		by_shift: (raw.periods ?? []).filter((row) => SHIFTS.includes(row.grain)),
		by_daytype: (raw.periods ?? []).filter((row) => DAY_TYPES.includes(row.grain)),
		by_shift_daytype: [],
		day_of_week: raw.day_of_week ?? [],
	};
	const orderRows = (rows, order) =>
		(rows ?? []).slice().sort((a, b) => order.indexOf(a.grain) - order.indexOf(b.grain));
	const byShift = orderRows(breakdown.by_shift, SHIFTS);
	const byDayType = orderRows(breakdown.by_daytype, DAY_TYPES);
	const crosstab = new Map(
		(breakdown.by_shift_daytype ?? []).map((row) => [`${row.shift}|${row.day_type}`, row]),
	);
	const crosstabRows = SHIFTS.map((shift) => [
		shift,
		...DAY_TYPES.map((dayType) => {
			const row = crosstab.get(`${shift}|${dayType}`);
			return finite(row?.observation_count) >= 30 ? finite(row?.otp_pct) : null;
		}),
	]);
	const timeCopy = TIME_OF_DAY_COPY[locale];
	const timeShareRows = (rows) =>
		rows.map((row) => {
			const share = shareOf(row, 0);
			return [
				row.grain,
				share == null
					? { value: null, text: timeCopy.absent }
					: {
							value: share,
							text: new Intl.NumberFormat(localeTag(locale), { style: 'percent' }).format(
								share / 100,
							),
						},
				share == null || row.observation_count == null
					? { value: null, text: '' }
					: { value: row.observation_count, text: countText(row.observation_count, locale) },
			];
		});
	const timeTableRows = [
		...timeShareRows(byShift),
		...(byDayType.length ? [[timeCopy.dayType], ...timeShareRows(byDayType)] : []),
	];
	const timeTable =
		chosenRange || !timeTableRows.some((row) => row[1]?.value != null)
			? { headers: [], rows: [] }
			: { headers: timeCopy.headers, rows: timeTableRows };
	const timeRows = chosenRange
		? { shift: [], dayType: [], crosstab: [], weekday: [] }
		: {
				shift: byShift
					.filter((row) => finite(row.severe_pct) != null)
					.map((row) => [row.grain, row.severe_pct]),
				dayType: byDayType
					.filter((row) => finite(row.severe_pct) != null)
					.map((row) => [row.grain, row.severe_pct]),
				crosstab: crosstabRows.some((row) => row.slice(1).some((value) => value != null))
					? crosstabRows
					: [],
				weekday: Array.from({ length: 7 }, (_, index) => {
					const iso = index + 1;
					return [
						iso,
						finite(
							(breakdown.day_of_week ?? raw.day_of_week ?? []).find(
								(row) => row.day_of_week_iso === iso,
							)?.avg_delay_min,
						),
					];
				}),
			};
	const windowedHeadway = (raw.headway_by_grain ?? []).find((row) => row.grain === 'day');
	const headwayRows = chosenRange ? [] : (windowedHeadway?.headway ?? raw.headway ?? []);
	const primaryHeadway = headwayRows.some((row) => row.direction_id == null && row.day_type == null)
		? headwayRows.filter((row) => row.direction_id == null && row.day_type == null)
		: headwayRows;
	const headwayDisplay = {
		dumbbell: primaryHeadway.some(
			(row) => finite(row.scheduled_min) > 0 || finite(row.observed_min) > 0,
		)
			? primaryHeadway.map((row) => [
					row.shift,
					finite(row.scheduled_min),
					finite(row.observed_min),
				])
			: [],
		summary: GAPS_COPY[locale].summary,
		frequency: GAPS_COPY[locale].frequency,
	};
	const byDow = raw.occupancy_by_dow ?? [];
	const activeMix =
		// A grain shows only its own mix, never the file-level one under the grain's name. The range
		// cell is read after the runner's day -> range round trip, which clears the chosen dates: a
		// range without dates has no mix of its own, so no figure is shown.
		chosenRange
			? null
			: ((raw.occupancy_by_grain ?? []).find((row) => row.grain === 'day')?.mix ?? null);
	const occupancyShares = {
		active: shareRows(activeMix, OCCUPANCY),
		weekday: shareRows(
			meanMix(byDow.filter((row) => row.day_of_week_iso >= 1 && row.day_of_week_iso <= 5)),
			OCCUPANCY,
		),
		weekend: shareRows(
			meanMix(byDow.filter((row) => row.day_of_week_iso >= 6 && row.day_of_week_iso <= 7)),
			OCCUPANCY,
		),
		byDow: byDow.length
			? Array.from({ length: 7 }, (_, index) => {
					const iso = index + 1;
					return [iso, shareRows(byDow.find((row) => row.day_of_week_iso === iso)?.mix, OCCUPANCY)];
				})
			: [],
	};
	const activeTotal = OCCUPANCY.reduce(
		(sum, key) => sum + Math.max(0, finite(activeMix?.[key]) ?? 0),
		0,
	);
	const dominantCode =
		activeTotal > 0
			? OCCUPANCY.reduce((best, key) =>
					(finite(activeMix[key]) ?? 0) > (finite(activeMix[best]) ?? 0) ? key : best,
				)
			: null;
	const dominant =
		dominantCode == null
			? { label: null, value: { value: null, text: '' } }
			: {
					label: OCCUPANCY_LABELS[locale][dominantCode],
					value: {
						value: Math.round(((finite(activeMix[dominantCode]) ?? 0) / activeTotal) * 100),
						text: `${Math.round(((finite(activeMix[dominantCode]) ?? 0) / activeTotal) * 100)}%`,
					},
				};
	const cancellationPct = pct(
		finite(cancellation?.canceled_trip_days),
		finite(cancellation?.total_trip_days),
	);
	const skippedPct = pct(
		finite(skipped?.skipped_stop_count),
		finite(skipped?.stop_time_update_count),
	);
	const completenessPct = retained.length
		? pct(finite(cancellation?.delivered_trip_days), finite(cancellation?.scheduled_trip_days))
		: null;
	const serviceCaptions = {
		completeness:
			retained.length && finite(cancellation?.scheduled_trip_days) > 0
				? locale === 'fr'
					? `${countText(cancellation.delivered_trip_days, locale)} jours-trajets observés non annulés / ${countText(cancellation.scheduled_trip_days, locale)} prévus${cancellation.silent_trip_days == null ? '' : ` · écart de décompte : ${countText(cancellation.silent_trip_days, locale)}`}. Aucun rapprochement par identifiant.`
					: `${countText(cancellation.delivered_trip_days, locale)} observed non-cancelled trip-days / ${countText(cancellation.scheduled_trip_days, locale)} scheduled${cancellation.silent_trip_days == null ? '' : ` · ${countText(cancellation.silent_trip_days, locale)} count shortfall`}. Trip identities are not matched.`
				: null,
		cancellation:
			cancellationPct == null
				? null
				: locale === 'fr'
					? `${countText(cancellation.canceled_trip_days, locale)} sur ${countText(cancellation.total_trip_days, locale)} (${tenthPct(cancellationPct, locale)})`
					: `${countText(cancellation.canceled_trip_days, locale)} of ${countText(cancellation.total_trip_days, locale)} (${tenthPct(cancellationPct, locale)})`,
		skipped:
			skippedPct == null
				? null
				: locale === 'fr'
					? `${countText(skipped.skipped_stop_count, locale)} des ${countText(skipped.stop_time_update_count, locale)} mises à jour d’arrêt (${tenthPct(skippedPct, locale)})`
					: `${countText(skipped.skipped_stop_count, locale)} of ${countText(skipped.stop_time_update_count, locale)} stop updates (${tenthPct(skippedPct, locale)})`,
	};
	const scalar = (value, unit, fixed = false) => ({
		value,
		text:
			value == null ? '' : `${fixed ? value.toFixed(1) : value}${unit === 'min' ? ' min' : '%'}`,
		unit,
	});
	// The record's own figures, in the reader's locale; none of them from zero readings.
	const measured = day?.observation_count !== 0;
	const recordPct = recordShare(day);
	const recordMin = (value) => {
		const shown = measured ? finite(value) : null;
		return {
			value: shown,
			text:
				shown == null
					? ''
					: `${new Intl.NumberFormat(localeTag(locale), {
							minimumFractionDigits: 1,
							maximumFractionDigits: 1,
						}).format(shown)} min`,
			unit: 'min',
		};
	};
	const scalars = {
		otp: {
			value: recordPct,
			text:
				recordPct == null
					? ''
					: new Intl.NumberFormat(localeTag(locale), { style: 'percent' }).format(recordPct / 100),
			unit: '%',
		},
		avg: recordMin(day?.avg_delay_min),
		p50: recordMin(day?.p50_min),
		p90: recordMin(day?.p90_min),
		severe: scalar(measured ? finite(day?.severe_pct) : null, '%'),
		completeness: {
			value: completenessPct,
			text: completenessPct == null ? '' : tenthPct(completenessPct, locale),
			unit: '%',
		},
		cancellation: { value: cancellationPct, text: serviceCaptions.cancellation ?? '', unit: '%' },
		skipped: { value: skippedPct, text: serviceCaptions.skipped ?? '', unit: '%' },
	};
	const delayByCrowdingRows = OCCUPANCY.map((band) => [
		band,
		finite((raw.delay_by_crowding ?? []).find((row) => row.band === band)?.avg_delay_min),
	]);
	const c = TABLE_COPY[locale];
	const histogram = histogramTable(closedDay?.delay_histogram ?? [], locale, true, c.observations);
	return [
		observation('line.day.otp_pct', recordPct),
		observation('line.day.avg_delay_min', scalars.avg.value),
		observation('line.day.p50_min', scalars.p50.value),
		observation('line.day.p90_min', scalars.p90.value),
		observation('line.day.severe_pct', scalars.severe.value),
		observation(
			'line.day.observation_count',
			recordPct != null ? (day.observation_count ?? null) : null,
		),
		observation('line.day.cancellation_pct', cancellationPct),
		observation('line.day.skipped_pct', skippedPct),
		observation('line.day.completeness_pct', completenessPct),
		observation(
			'line.day.scheduled_counts',
			retained.length && (finite(cancellation?.scheduled_trip_days) ?? 0) > 0
				? {
						scheduled: finite(cancellation?.scheduled_trip_days),
						delivered: finite(cancellation?.delivered_trip_days),
						silent: finite(cancellation?.silent_trip_days),
						captions: serviceCaptions,
						scalars,
					}
				: { scheduled: null, delivered: null, silent: null, captions: serviceCaptions, scalars },
		),
		observation('line.service_span', {
			date: span?.date ?? null,
			first: hasSpanPair ? observedEndpoint(span.first_trip_utc, locale) : null,
			last: hasSpanPair ? observedEndpoint(span.last_trip_utc, locale) : null,
			minutes: finite(span?.service_span_min),
			firstDelay: finite(span?.first_trip_delay_min),
			lastDelay: finite(span?.last_trip_delay_min),
			trips: finite(span?.trip_count),
		}),
		observation('line.weak_stops.eligible_ids', {
			headers: [],
			rows: listedStops.map((row) => ({
				name: row.name ?? row.id,
				value: row.severe_pct,
				unit: '%',
				readings: row.observation_count,
				text: `${new Intl.NumberFormat(localeTag(locale), { style: 'percent', maximumFractionDigits: 1 }).format(row.severe_pct / 100)}${STOP_COPY[locale].valueNote}`,
				readingsText: `${countText(row.observation_count, locale)} ${row.observation_count === 1 ? STOP_COPY[locale].reading : STOP_COPY[locale].readings}`,
			})),
		}),
		observation(
			'line.weak_stops.hrefs',
			listedStops.map(
				(row) => `${locale === 'fr' ? '/fr' : ''}/stop/${encodeURIComponent(row.id)}`,
			),
		),
		observation('line.weak_stops.raw_count', listedStops.length),
		observation('line.pane.freshness_iso', raw.generated_utc?.slice(0, 10) ?? null),
		observation('line.trend.rows', lineDailyTable(raw, closedDate, view, locale, retained)),
		observation('line.habits.tiers', {
			table: heatmapTable(heatmapTiers(raw.habits), locale),
			bestTime: bestTimeText(raw.habits, locale),
		}),
		observation('line.time.rows', {
			shift: table([c.group, '%'], timeRows.shift),
			dayType: table([c.dayType, c.severe], timeRows.dayType, ['%']),
			onTime: timeTable,
			crosstab: table([c.shift, c.weekday, c.weekend], timeRows.crosstab, ['', ''], '·'),
			weekday: table([c.day, c.avg], timeRows.weekday, [''], '·'),
		}),
		observation('line.headway.rows', {
			dumbbell: {
				headers: headwayDisplay.dumbbell.length ? GAPS_COPY[locale].headers : [],
				rows: headwayDisplay.dumbbell.map(([shift, ...minutes]) => [
					shift,
					...minutes.map((value) =>
						!(value > 0)
							? { value: null, text: TIME_OF_DAY_COPY[locale].absent }
							: {
									value: round(value),
									text: new Intl.NumberFormat(localeTag(locale), {
										maximumFractionDigits: 1,
									}).format(round(value)),
								},
					),
				]),
			},
			summary: headwayDisplay.summary,
			frequency: headwayDisplay.frequency,
		}),
		observation('line.occupancy.shares', {
			active: shareTable(occupancyShares.active),
			weekday: shareTable(occupancyShares.weekday),
			weekend: shareTable(occupancyShares.weekend),
			byDow: occupancyShares.byDow.map(([iso, rows]) => [iso, shareTable(rows)]),
			dominant,
		}),
		observation(
			'line.delay_by_crowding',
			delayByCrowdingRows.some((row) => row[1] != null)
				? table([c.crowdingBand, c.avg], delayByCrowdingRows, [' min'])
				: table([], []),
		),
		observation('line.week.histogram', histogram),
	];
}

// The stop record's weekly late-reading share, rebuilt from the stop's own daily rows: the
// publisher sums the window's daily counts, so the published share must equal that sum's ratio.
function stopRecordAnswer(fixture, raw, locale) {
	const index = fixture.files['historic/route_reliability/index.json'] ?? null;
	const rows = index?.weekly_stops ?? [];
	const absent = (state) => ({ state, late_pct: null, text: '', period: '', counts: [] });
	if (rows.length === 0) return absent('unpublished');
	const row = rows.find((candidate) => candidate.id === raw.id);
	if (row == null) return absent('not-listed');
	invariant(row.state === 'ranked', `${fixture.name} stop record oracle covers ranked rows only`);
	const days = (raw.daily ?? []).filter(
		(day) => day.date >= row.window_start && day.date <= row.window_end,
	);
	const readings = days.reduce((sum, day) => sum + day.observation_count, 0);
	const late = days.reduce((sum, day) => sum + day.severe_count, 0);
	invariant(
		readings === row.denominator && readings - late === row.numerator,
		`${fixture.name} weekly stop counts disagree with the stop's daily rows`,
	);
	invariant(late >= 0 && late <= readings, `${fixture.name} weekly stop late count out of range`);
	const share = pct(late, readings);
	invariant(
		share === row.severe_pct,
		`${fixture.name} weekly stop share disagrees with its counts`,
	);
	const tag = locale === 'fr' ? 'fr-CA' : 'en-CA';
	const date = (key, options) =>
		new Intl.DateTimeFormat(tag, { ...options, timeZone: 'UTC' }).format(
			new Date(`${key}T12:00:00Z`),
		);
	const day = (key) => String(Number(key.slice(8, 10)));
	const month = (key) => date(key, { month: 'long' });
	invariant(
		row.window_start.slice(0, 7) === row.window_end.slice(0, 7),
		`${fixture.name} stop record oracle covers one-month windows only`,
	);
	const year = row.window_end.slice(0, 4);
	const period =
		locale === 'fr'
			? `Du ${day(row.window_start)} au ${day(row.window_end)} ${month(row.window_end)} ${year} · 7 jours complets`
			: `${month(row.window_start)} ${day(row.window_start)} to ${day(row.window_end)}, ${year} · 7 complete days`;
	return {
		state: 'measured',
		late_pct: share,
		text: new Intl.NumberFormat(tag, { style: 'percent', maximumFractionDigits: 1 }).format(
			share / 100,
		),
		period,
		counts: [readings, late],
	};
}

/**
 * The stop's Day by day, from its definition: every calendar day of the chosen dates, else the
 * published record week, else the file's last seven days. A day's share is its late readings over
 * its readings in tenths, half up, from the integers; a day without a valid row is a gap.
 */
function stopDayByDay(fixture, raw, locale, chosen) {
	const tag = locale === 'fr' ? 'fr-CA' : 'en-CA';
	const index = fixture.files['historic/route_reliability/index.json'] ?? null;
	const recordRow = (index?.weekly_stops ?? []).find((row) => row.id === raw.id) ?? null;
	const daily = raw.daily ?? [];
	const DAY = 86_400_000;
	const time = (key) => Date.parse(`${key}T00:00:00Z`);
	const key = (ms) => new Date(ms).toISOString().slice(0, 10);
	const last = Math.max(...daily.map((row) => time(row.date)).filter(Number.isFinite));
	const [basis, window] = chosen
		? ['chosen', chosen]
		: recordRow
			? ['record', { from: recordRow.window_start, to: recordRow.window_end }]
			: Number.isFinite(last)
				? ['latest', { from: key(last - 6 * DAY), to: key(last) }]
				: [null, null];
	const dates = [];
	if (window)
		for (let ms = time(window.from); ms <= time(window.to); ms += DAY) dates.push(key(ms));
	const gapText = (reason) =>
		reason === 'no-readings'
			? locale === 'fr'
				? 'Aucun relevé'
				: 'No readings'
			: locale === 'fr'
				? 'Non publié'
				: 'Not published';
	const label = (date) => {
		const at = new Date(`${date}T12:00:00Z`);
		const part = (options) =>
			new Intl.DateTimeFormat(tag, { ...options, timeZone: 'UTC' }).format(at);
		if (locale !== 'fr') return part({ weekday: 'long', month: 'long', day: 'numeric' });
		const day = Number(date.slice(8));
		return `${part({ weekday: 'long' })} ${day === 1 ? '1er' : day} ${part({ month: 'long' })}`;
	};
	const measured = [];
	const rows = dates.map((date) => {
		const row = daily.find((candidate) => candidate.date === date);
		const n = row?.observation_count;
		const k = row?.severe_count;
		const valid = Number.isSafeInteger(n) && Number.isSafeInteger(k) && n > 0 && k >= 0 && k <= n;
		const tenths = valid ? Number((2000n * BigInt(k) + BigInt(n)) / (2n * BigInt(n))) : null;
		const agrees =
			tenths != null && (row.severe_pct == null || Math.round(row.severe_pct * 10) === tenths);
		if (!agrees) {
			const gap = { value: null, text: gapText(n === 0 ? 'no-readings' : 'not-published') };
			return [label(date), gap, gap, gap];
		}
		invariant(tenths >= 0 && tenths <= 1000, `${fixture.name} stop day share out of bounds`);
		measured.push(n);
		const count = (value) => ({ value, text: countText(value, locale) });
		return [
			label(date),
			{
				value: tenths / 10,
				text: new Intl.NumberFormat(tag, { style: 'percent', maximumFractionDigits: 1 }).format(
					tenths / 1000,
				),
			},
			count(n),
			count(k),
		];
	});
	const gaps = rows.length - measured.length;
	const limits = [
		...(basis === 'record' || basis === 'latest'
			? [[rows.length]]
			: basis === 'chosen'
				? [[]]
				: []),
		gaps > 0 ? [gaps, rows.length] : [],
		...(measured.length
			? [
					Math.min(...measured) === Math.max(...measured)
						? [measured[0]]
						: [Math.min(...measured), Math.max(...measured)],
				]
			: []),
	];
	return { rows, limits };
}

/** The latest day the stop's Day by day draws, as the page names it ("Saturday, August 29"). */
export function expectedStopLatestDay(fixture, locale) {
	const raw = stopFile(fixture);
	return raw ? (stopDayByDay(fixture, raw, locale, null).rows.at(-1)?.[0] ?? null) : null;
}

function stopOracle(fixture, locale, view) {
	const raw = stopFile(fixture);
	const retained = retainedStopDays(fixture, view);
	const day = (raw.periods ?? []).find((row) => row.grain === 'day') ?? null;
	const window = new URL(view || '/', 'http://b9.local');
	const from = window.searchParams.get('from');
	const to = window.searchParams.get('to');
	const days = stopDayByDay(fixture, raw, locale, from && to ? { from, to } : null);
	const rankedRoutes = (raw.by_route ?? [])
		.filter((row) => finite(row.avg_delay_min) != null)
		.slice()
		.sort((a, b) => b.avg_delay_min - a.avg_delay_min)
		.map((row) => [row.route, row.avg_delay_min]);
	const weekdayRows = (raw.day_of_week ?? [])
		.filter((row) => finite(row.avg_delay_min) != null)
		.slice()
		.sort((a, b) => b.avg_delay_min - a.avg_delay_min)
		.map((row) => {
			const severe = finite(row.observation_count) >= 5 ? finite(row.severe_pct) : null;
			return [
				row.day_of_week_iso,
				{ value: row.avg_delay_min, text: `${row.avg_delay_min.toFixed(1)} min` },
				{
					values: severe == null ? [] : [severe],
					text:
						severe == null
							? locale === 'fr'
								? 'Retard moyen'
								: 'Avg delay'
							: `${locale === 'fr' ? 'Part des retards graves' : 'Severe-delay share'} ${severe.toFixed(1)}%`,
				},
			];
		});
	const timeRank = (keys) =>
		(raw.periods ?? [])
			.filter((row) => keys.includes(row.grain) && finite(row.severe_pct) != null)
			.slice()
			.sort((a, b) => b.severe_pct - a.severe_pct || keys.indexOf(a.grain) - keys.indexOf(b.grain))
			.map((row) => [
				row.grain,
				{ value: row.severe_pct, text: `${row.severe_pct.toFixed(1)}%` },
				{
					values: [],
					text: locale === 'fr' ? 'Part des retards graves' : 'Severe-delay share',
				},
			]);
	const occupancyMix = stopOccupancyMix(raw, retained);
	const occupancyRows = shareRows(occupancyMix, OCCUPANCY);
	const stopDominant = dominantShare(occupancyMix, OCCUPANCY);
	// Section 02 states the record answer's measure: the publisher's late share, else the
	// complement of its whole-number share, never the share that is not late.
	const dayLate =
		finite(day?.severe_pct) ?? (finite(day?.otp_pct) == null ? null : 100 - day.otp_pct);
	const stopScalars = {
		late: {
			value: dayLate,
			text:
				dayLate == null
					? ''
					: new Intl.NumberFormat(localeTag(locale), {
							style: 'percent',
							maximumFractionDigits: 1,
						}).format(dayLate / 100),
		},
		percentiles: [
			{
				value: finite(day?.p50_min),
				text: finite(day?.p50_min) == null ? '' : `${day.p50_min.toFixed(1)} min`,
			},
			{
				value: finite(day?.p90_min),
				text: finite(day?.p90_min) == null ? '' : `${day.p90_min.toFixed(1)} min`,
			},
		],
	};
	return [
		observation('stop.day.late_pct', dayLate),
		observation('stop.day.p50_min', finite(day?.p50_min)),
		observation('stop.day.p90_min', finite(day?.p90_min)),
		observation('stop.record.answer', stopRecordAnswer(fixture, raw, locale)),
		observation(
			'stop.day.observation_count',
			verdictCount(
				finite(day?.otp_pct),
				finite(day?.observation_count),
				null,
				finite(day?.wilson_lo),
				finite(day?.wilson_hi),
			),
		),
		observation('stop.daily.rows', days.rows),
		observation('stop.daily.limits', days.limits),
		observation('stop.routes.ranked', rankedRoutes),
		observation('stop.habits.tiers', heatmapTable(heatmapTiers(raw.habits), locale)),
		observation('stop.weekday.rows', weekdayRows),
		observation('stop.time.rows', {
			shift: timeRank(SHIFTS),
			dayType: timeRank(DAY_TYPES),
		}),
		observation('stop.occupancy.shares', {
			table: shareTable(occupancyRows),
			dominant:
				stopDominant == null
					? { label: null, value: { value: null, text: '' }, sublabel: null }
					: {
							label: OCCUPANCY_LABELS[locale][stopDominant[0]].toLocaleUpperCase(
								locale === 'fr' ? 'fr-CA' : 'en-CA',
							),
							value: { value: stopDominant[1], text: `${stopDominant[1]}%` },
							sublabel: locale === 'fr' ? 'Occupation la plus fréquente' : 'Most common loading',
						},
		}),
		observation('stop.display.scalars', stopScalars),
		observation('stop.pane.freshness_iso', raw.generated_utc?.slice(0, 10) ?? null),
	];
}

function retainedNetworkDays(fixture, view) {
	const path = Object.keys(fixture.files).find((candidate) =>
		/^historic\/history\/network\/generations\/[0-9a-f]{64}\/\d{4}-\d{2}\.json$/u.test(candidate),
	);
	if (!path) return [];
	const params = new URLSearchParams(view.split('?')[1] ?? '');
	const from = params.get('from');
	const to = params.get('to');
	return (rawFile(fixture, path).days ?? []).filter(
		(row) => (!from || from <= row.date) && (!to || row.date <= to),
	);
}

function networkOracle(fixture, locale, view) {
	const live = networkFile(fixture);
	const trend = networkTrend(fixture);
	const closedThrough = trendClosedThrough(
		fixture.files['historic/history/index.json'] ?? null,
		trend.series ?? [],
	);
	const retained = view.includes('from=') ? retainedNetworkDays(fixture, view) : [];
	const series =
		retained.length > 0
			? retained
					.slice()
					.sort((a, b) => a.date.localeCompare(b.date))
					.map((row) => ({
						date: row.date,
						otp_pct: pct(row.delay?.on_time_count, row.delay?.observation_count, 0),
						avg_delay_min:
							finite(row.delay?.in_clamp_observation_count) > 0
								? round(row.delay.sum_delay_seconds / row.delay.in_clamp_observation_count / 60)
								: null,
						p90_min:
							finite(row.delay_percentiles?.p90_delay_seconds) != null
								? round(row.delay_percentiles.p90_delay_seconds / 60)
								: null,
						vehicles: finite(row.vehicles),
						cancellation_rate: pct(
							row.cancellation?.canceled_trip_days,
							row.cancellation?.total_trip_days,
							2,
						),
						service_completeness_rate: pct(
							row.cancellation?.delivered_trip_days,
							row.cancellation?.scheduled_trip_days,
							2,
						),
						occupancy_mix: row.occupancy ?? null,
					}))
			: (trend.series ?? []).filter((row) => closedThrough != null && row.date <= closedThrough);
	const hasHistoric =
		series.length > 0 ||
		closedTrendPoints(trend.weekly ?? [], 'week', closedThrough).length > 0 ||
		closedTrendPoints(trend.monthly ?? [], 'month', closedThrough).length > 0;
	const latest = series.at(-1) ?? null;
	const prior = series.at(-2) ?? null;
	const rankRows = (rows) =>
		(rows ?? [])
			.filter((row) => finite(row.otp_pct) != null || finite(row.severe_pct) != null)
			.slice()
			.sort((a, b) => {
				const aOtp = finite(a.otp_pct);
				const bOtp = finite(b.otp_pct);
				if ((aOtp != null) !== (bOtp != null)) return aOtp != null ? -1 : 1;
				return aOtp != null && bOtp != null
					? aOtp - bOtp
					: (finite(b.severe_pct) ?? 0) - (finite(a.severe_pct) ?? 0);
			})
			.map((row) => {
				const otp = finite(row.otp_pct);
				const avg = finite(row.avg_delay_min);
				const severe = finite(row.severe_pct);
				const absent =
					locale === 'fr'
						? 'Aucune donnée ·\u00a0pas assez de mesures'
						: 'No data ·\u00a0not enough readings yet';
				const avgText = avg == null ? noDataText(locale) : `${avg} min`;
				const severeText = severe == null ? noDataText(locale) : `${severe.toFixed(1)}%`;
				return [
					row.grain,
					{ value: otp, text: otp == null ? absent : `${otp}%` },
					{
						values: [avg, severe].filter((value) => value != null),
						text: `${locale === 'fr' ? 'retard moyen' : 'avg delay'} ${avgText} · ${locale === 'fr' ? 'sévère' : 'severe'} ${severeText}`,
					},
				];
			});
	const p90Available = series.some((row) => finite(row.p90_min) != null);
	const avgAvailable = series.some((row) => finite(row.avg_delay_min) != null);
	const delayField = p90Available ? 'p90_min' : avgAvailable ? 'avg_delay_min' : 'p90_min';
	const minimumPoints = retained.length ? 1 : 2;
	const primaryCount = series.filter((row) => finite(row.otp_pct) != null).length;
	const delayCount = series.filter((row) => finite(row[delayField]) != null).length;
	const retardOnly =
		retained.length > 0 && primaryCount < minimumPoints && delayCount >= minimumPoints;
	const trendRows =
		primaryCount >= minimumPoints || retardOnly
			? series.map((row) =>
					retardOnly
						? [row.date, finite(row[delayField])]
						: [row.date, finite(row.otp_pct), finite(row[delayField])],
				)
			: [];
	const vehicleRows =
		series.filter((row) => finite(row.vehicles) != null).length >= 2
			? series.map((row) => [row.date, finite(row.vehicles)])
			: [];
	const cancellationRows =
		series.filter((row) => finite(row.cancellation_rate) != null).length >= 2
			? series.map((row) => [row.date, finite(row.cancellation_rate)])
			: [];
	const ageSeconds = Math.max(
		0,
		Math.round((Date.parse(fixture.frozen_utc) - Date.parse(live.generated_utc)) / 1000),
	);
	const networkMeta = {
		freshness: {
			text: normalizeObservation(
				stampCopy[locale].live('data', 'current', relativeSeconds(ageSeconds, locale)),
			),
			datetime: live.generated_utc,
			seconds: ageSeconds,
		},
		conformance: conformanceDisplay(fixture.files['provenance.json']?.conformance, locale),
		scalars: {
			headline: [
				{
					value: finite(live.on_time_pct),
					text: finite(live.on_time_pct) == null ? '' : `${live.on_time_pct}%`,
					unit: '%',
				},
				{
					value: finite(live.coverage_pct),
					text: finite(live.coverage_pct) == null ? '' : `${live.coverage_pct}%`,
					unit: '%',
				},
				{
					value: finite(live.delay_p50_min),
					text: finite(live.delay_p50_min) == null ? '' : `${live.delay_p50_min} min`,
					unit: 'min',
				},
				{
					value: finite(live.delay_p90_min),
					text: finite(live.delay_p90_min) == null ? '' : `${live.delay_p90_min} min`,
					unit: 'min',
				},
			],
			reporting: [
				{
					value: finite(live.vehicles_in_service),
					text: countText(live.vehicles_in_service, locale),
					unit: 'count',
				},
				{
					value: finite(live.non_responding),
					text: countText(live.non_responding, locale),
					unit: 'count',
				},
			],
			completeness: {
				value:
					finite(latest?.service_completeness_rate) == null
						? null
						: round(latest.service_completeness_rate),
				text:
					finite(latest?.service_completeness_rate) == null
						? ''
						: `${latest.service_completeness_rate.toFixed(1)}%`,
				unit: '%',
			},
		},
	};
	const latestCancellation =
		series.findLast((row) => finite(row.cancellation_rate) != null)?.cancellation_rate ?? null;
	return [
		observation('network.live.vehicles', finite(live.vehicles_in_service)),
		observation('network.live.on_time_pct', finite(live.on_time_pct)),
		observation('network.live.coverage_pct', finite(live.coverage_pct)),
		observation('network.live.p50_min', finite(live.delay_p50_min)),
		observation('network.live.p90_min', finite(live.delay_p90_min)),
		observation('network.live.non_responding', finite(live.non_responding)),
		observation('network.live.status_shares', {
			table: shareTable(shareRows(live.status_dist, STATUS)),
			meta: networkMeta,
		}),
		observation(
			'network.live.occupancy_shares',
			shareTable(shareRows(live.occupancy_mix, OCCUPANCY)),
		),
		observation('network.live.histogram', histogramTable(live.delay_histogram ?? [], locale)),
		observation(
			'network.live.silent_routes',
			(live.non_responding_by_route ?? [])
				.slice()
				.sort((a, b) => b.count - a.count || a.route_id.localeCompare(b.route_id))
				.map((row) => [
					row.route_id,
					row.count,
					`${locale === 'fr' ? '/fr' : ''}/lines/${encodeURIComponent(row.route_id)}`,
				]),
		),
		observation(
			'network.verdict.delta_pct',
			finite(latest?.otp_pct) != null && finite(prior?.otp_pct) != null
				? round(latest.otp_pct - prior.otp_pct, 0)
				: null,
		),
		observation(
			'network.latest.completeness_pct',
			finite(latest?.service_completeness_rate) == null
				? null
				: round(latest.service_completeness_rate),
		),
		observation(
			'network.trend.rows',
			trendTable(
				retardOnly
					? [TABLE_COPY[locale].x, TABLE_COPY[locale].networkDelay]
					: [TABLE_COPY[locale].x, TABLE_COPY[locale].networkOtp, TABLE_COPY[locale].networkDelay],
				trendRows,
				locale,
				retardOnly ? [' min'] : ['%', ' min'],
			),
		),
		observation('network.vehicles.rows', table([], vehicleRows, [''], '·')),
		observation('network.cancellations.rows', {
			table: trendTable(
				cancellationRows.length ? [TABLE_COPY[locale].x, TABLE_COPY[locale].canceled] : [],
				cancellationRows,
				locale,
				['%'],
			),
			latest:
				latestCancellation == null
					? { value: null, text: '' }
					: { value: round(latestCancellation), text: `${latestCancellation.toFixed(1)}%` },
		}),
		observation(
			'network.occupancy.rows',
			series.flatMap((row) => {
				const shares = shareRows(row.occupancy_mix, OCCUPANCY);
				return shares.length ? [shareTable(shares)] : [];
			}),
		),
		observation('network.shift.rows', hasHistoric ? rankRows(trend.by_shift) : []),
		observation('network.daytype.rows', hasHistoric ? rankRows(trend.by_daytype) : []),
	];
}

export function expectedDomainObservationsFromFixture(fixture, surface, locale = 'en', view = '') {
	invariant(fixture != null, 'missing fixture');
	invariant(SURFACES.includes(surface), `unknown surface ${surface}`);
	const rows =
		surface === 'line'
			? lineOracle(fixture, locale, view)
			: surface === 'stop'
				? stopOracle(fixture, locale, view)
				: networkOracle(fixture, locale, view);
	invariant(
		JSON.stringify(rows.map((row) => row.id)) === JSON.stringify(OBSERVATION_IDS[surface]),
		`${surface} observation contract expansion`,
	);
	return rows;
}

export function expectedDomainObservations(fixtureName, surface, locale = 'en', view = '') {
	const fixture = FIXTURES[fixtureName];
	invariant(fixture != null, `unknown fixture ${fixtureName}`);
	return expectedDomainObservationsFromFixture(fixture, surface, locale, view);
}

function expectLiteral(actual, expected, id) {
	const left = JSON.stringify(stable(actual));
	const right = JSON.stringify(stable(expected));
	invariant(left === right, `${id}: expected ${right}, got ${left}`);
}

function proveNegativeControl(family) {
	const actual = [observation(`${family}.value`, 17), observation(`${family}.absence`, null)];
	compareObservations(structuredClone(actual), actual, `${family} self-check baseline`);
	for (const [kind, mutate] of [
		['wrong', (rows) => (rows[0].value = 18)],
		['missing', (rows) => rows.pop()],
		['extra', (rows) => rows.push(observation(`${family}.extra`, 1))],
		['duplicate', (rows) => rows.push(structuredClone(rows[0]))],
	]) {
		const corrupted = structuredClone(actual);
		mutate(corrupted);
		let rejected = false;
		try {
			compareObservations(actual, corrupted, `${family} ${kind} negative control`);
		} catch (error) {
			rejected = /mismatch|duplicate/u.test(String(error));
		}
		invariant(rejected, `${family} ${kind} negative control was not rejected`);
	}
}

export function runOracleSelfCheck() {
	for (const value of [0, null, undefined]) {
		const fixture = structuredClone(FIXTURES.sparse);
		routeFile(fixture).day_of_week[0].avg_delay_min = value;
		expectLiteral(
			expectedDomainObservationsFromFixture(fixture, 'line').find(
				(row) => row.id === 'line.time.rows',
			)?.value.weekday.rows[0][1],
			{ text: value === 0 ? '0' : '·', value: value ?? null },
			'explicit zero and absent weekday averages stay distinct',
		);
	}
	expectLiteral(
		verdictCount(87, 120, null, 80, 92),
		null,
		'published reliable stop omits hedge count',
	);
	expectLiteral(
		verdictCount(85, 230, null, 79.6, 88.9),
		230,
		'published tentative stop retains hedge count',
	);
	expectLiteral(
		verdictCount(80, 1_000_000, null, 79.6, 79.8),
		null,
		'published patchy stop omits hedge count',
	);
	expectLiteral(
		verdictCount(85, 230, 195, 80.1, 88.9),
		230,
		'exact counts precede published bounds',
	);
	for (const [lo, hi] of [
		[undefined, undefined],
		[null, null],
		[80, null],
		[90, 70],
		[-1, 90],
		[70, 101],
		[NaN, 90],
	]) {
		expectLiteral(
			verdictCount(87, 120, null, lo, hi),
			120,
			'missing or invalid bounds stay uncertain',
		);
	}
	expectLiteral(
		verdictCount(80, 120, null, 79.9, 80),
		120,
		'upper bound exactly 80 stays uncertain',
	);
	expectLiteral(
		expectedDomainObservationsFromFixture(FIXTURES.rich, 'stop', 'en').find(
			(row) => row.id === 'stop.day.observation_count',
		)?.value,
		null,
		'rich stop reliable verdict omits observation count',
	);
	for (const [otp, n, onTime, expected] of [
		[50, 30, 15, null],
		[55, 200, 110, null],
		[85, 100, 85, 100],
		[80, 1000, 800, 1000],
	]) {
		expectLiteral(verdictCount(otp, n, onTime), expected, `${otp}% at n=${n} hedge count`);
	}
	for (const [fixture, expected] of [
		[FIXTURES.rich, ['week', 76, 290]],
		[FIXTURES.sparse, [undefined, undefined, undefined]],
	]) {
		const window = expectedDefaultLineHeadline(fixture);
		expectLiteral(
			[window?.grain, window?.otp_pct, window?.observation_count],
			expected,
			`${fixture.name} independent current headline`,
		);
	}
	const thinCurrentDay = structuredClone(FIXTURES.rich);
	routeFile(thinCurrentDay).periods.at(-1).observation_count = 29;
	expectLiteral(
		expectedDefaultLineHeadline(thinCurrentDay),
		expectedDefaultLineHeadline(FIXTURES.rich),
		'open count does not change the closed week',
	);
	expectLiteral(
		expectedDomainObservations('sparse', 'line').find(
			(row) => row.id === 'line.day.observation_count',
		)?.value,
		null,
		'zero readings publish no share and no reading count',
	);
	for (const [iso, locale, expected] of [
		['2026-11-01T05:30:00Z', 'en', 'Nov 1, 2026, 01:30:00 GMT-4'],
		['2026-11-01T06:30:00Z', 'en', 'Nov 1, 2026, 01:30:00 GMT-5'],
		['2026-11-01T05:30:00Z', 'fr', '1 nov. 2026, 01 h 30 min 00 s UTC−4'],
		['2026-11-01T06:30:00Z', 'fr', '1 nov. 2026, 01 h 30 min 00 s UTC−5'],
	]) {
		expectLiteral(observedEndpoint(iso, locale), expected, `distinct fall-hour endpoint ${locale}`);
	}
	for (const [matrix, locale, expected] of [
		[[], 'en', null],
		[
			[
				[0, 0],
				[0, null],
			],
			'en',
			null,
		],
		[
			[
				[0.4, 0.4],
				[null, 0.4],
			],
			'fr',
			null,
		],
		[[[null, 0.7]], 'en', null],
		[
			[
				[0.25, 1],
				[1, 0],
			],
			'en',
			'An observed peak in this line’s relative score: Monday, 01:00.',
		],
		[
			[
				[0.25, 1],
				[1, 0],
			],
			'fr',
			'Un pic observé du score relatif de cette ligne : Lundi, 01:00.',
		],
		[[[Infinity, -1, 2]], 'en', null],
	])
		expectLiteral(bestTimeText({ matrix }, locale), expected, `relative peak ${locale}`);
	for (const [type, locale, current, prior, state, delta] of [
		['onTime', 'en', 90, 85, 'change', 'change +5 pts AM peak on-time vs prior day'],
		['onTime', 'fr', 85, 90, 'change', 'change -5 pts Pointe AM ponctualité p/r à la veille'],
		['onTime', 'en', 0, 0, 'flat', 'change 0 pts AM peak on-time vs prior day'],
		['wait', 'fr', 0, 0, 'flat', 'change 0.0 min Pointe AM attente p/r à la veille'],
		['onTime', 'fr', 80, null, 'absent', 'Pointe AM ponctualité pas de veille'],
		['wait', 'en', 12, null, 'absent', 'AM peak wait no prior day'],
		['wait', 'en', 12.25, 12, 'change', 'change +0.3 min AM peak wait vs prior day'],
		['wait', 'fr', 12, 12.25, 'change', 'change -0.3 min Pointe AM attente p/r à la veille'],
		['onTime', 'en', 1, 1.5, 'change', 'change -1 pt AM peak on-time vs prior day'],
		['onTime', 'fr', 1.5, 1, 'change', 'change +1 pt Pointe AM ponctualité p/r à la veille'],
		['wait', 'en', 1, 1.01, 'flat', 'change 0.0 min AM peak wait vs prior day'],
		['wait', 'en', 12, Infinity, 'absent', 'AM peak wait no prior day'],
	]) {
		const [valueField, priorField] =
			type === 'onTime' ? ['otp_pct', 'prior_otp_pct'] : ['observed_min', 'prior_observed_min'];
		const actual = compareDisplay(
			{ [valueField]: current, [priorField]: prior },
			'am_peak',
			locale,
			type,
		);
		expectLiteral(
			{ state: actual.state, delta: actual.delta },
			{ state, delta },
			`descriptive ${type} ${locale} ${current}/${prior}`,
		);
	}
	const retainedStopFixture = structuredClone(FIXTURES.rich);
	retainedStopFixture.files['historic/stop_reliability/52095.json'].occupancy_mix = {
		empty: 0,
		many_seats: 14,
		few_seats: 46,
		standing: 40,
		full: 0,
	};
	retainedStopFixture.files[
		'historic/history/stops/3532303935/generations/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/2026-08.json'
	] = {
		days: [
			{
				date: '2026-08-29',
				occupancy: {
					empty: 0,
					many_seats: 13,
					few_seats: 47,
					standing: 40,
					full: 0,
				},
			},
		],
	};
	expectLiteral(
		expectedDomainObservationsFromFixture(
			retainedStopFixture,
			'stop',
			'en',
			'?from=2026-08-29&to=2026-08-29',
		).find((row) => row.id === 'stop.occupancy.shares')?.value.dominant.value.value,
		47,
		'selected stop history occupancy replaces current mix',
	);
	retainedStopFixture.files[
		'historic/history/stops/3532303935/generations/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/2026-08.json'
	].days[0].occupancy = {
		empty: 0,
		many_seats: 462,
		few_seats: 464,
		standing: 74,
		full: 0,
	};
	expectLiteral(
		expectedDomainObservationsFromFixture(
			retainedStopFixture,
			'stop',
			'en',
			'?from=2026-08-29&to=2026-08-29',
		).find((row) => row.id === 'stop.occupancy.shares')?.value.dominant.label,
		'FEW SEATS',
		'stop dominant occupancy is selected before display rounding',
	);
	const noSpanFixture = structuredClone(FIXTURES.rich);
	noSpanFixture.files[
		'historic/history/lines/3234/generations/527864c22a3853a65c42ec69d86e009cd7a9fe782b9614e0abbda550d300ea43/2026-08.json'
	].days.find((day) => day.date === '2026-08-29').service_span = null;
	expectLiteral(
		expectedDomainObservationsFromFixture(
			noSpanFixture,
			'line',
			'en',
			'?from=2026-08-29&to=2026-08-29',
		).find((row) => row.id === 'line.service_span')?.value,
		{
			date: null,
			first: null,
			last: null,
			minutes: null,
			firstDelay: null,
			lastDelay: null,
			trips: null,
		},
		'selected line range never falls back to unselected current service span',
	);
	const oneDayNetworkFixture = structuredClone(FIXTURES.rich);
	const networkPartitionPath = Object.keys(oneDayNetworkFixture.files).find((candidate) =>
		/^historic\/history\/network\/generations\/[0-9a-f]{64}\/\d{4}-\d{2}\.json$/u.test(candidate),
	);
	invariant(networkPartitionPath != null, 'rich fixture lacks retained network partition');
	oneDayNetworkFixture.files[networkPartitionPath].days = [
		{
			date: '2026-08-29',
			cancellation: { canceled_trip_days: 1, total_trip_days: 200 },
		},
	];
	expectLiteral(
		expectedDomainObservationsFromFixture(
			oneDayNetworkFixture,
			'network',
			'en',
			'?from=2026-08-29&to=2026-08-29',
		).find((row) => row.id === 'network.cancellations.rows')?.value,
		{
			table: { headers: [], rows: [] },
			latest: { value: 0.5, text: '0.5%' },
		},
		'single retained cancellation keeps latest while chart remains absent',
	);
	expectLiteral(
		expectedDomainObservations('rich', 'line', 'en', '?from=2026-08-27&to=2026-08-29').find(
			(row) => row.id === 'line.day.completeness_pct',
		)?.value,
		93,
		'hand line completeness 93/100',
	);
	expectLiteral(
		expectedDomainObservations('rich', 'line').find((row) => row.id === 'line.day.completeness_pct')
			?.value,
		null,
		'current line completeness stands down',
	);
	for (const id of ['network.shift.rows', 'network.daytype.rows']) {
		expectLiteral(
			expectedDomainObservations('sparse', 'network').find((row) => row.id === id)?.value,
			[],
			'no closed point leaves the historic region empty: ' + id,
		);
	}
	expectLiteral(
		expectedDomainObservations('rich', 'network').find(
			(row) => row.id === 'network.verdict.delta_pct',
		)?.value,
		7,
		'hand network delta 79-72',
	);
	expectLiteral(
		expectedDomainObservations('rich', 'stop').find((row) => row.id === 'stop.daily.rows')?.value,
		[
			['Sunday, August 23', ...Array(3).fill({ value: null, text: 'Not published' })],
			['Monday, August 24', ...Array(3).fill({ value: null, text: 'Not published' })],
			['Tuesday, August 25', ...Array(3).fill({ value: null, text: 'Not published' })],
			['Wednesday, August 26', ...Array(3).fill({ value: null, text: 'Not published' })],
			[
				'Thursday, August 27',
				{ value: 10, text: '10%' },
				{ value: 40, text: '40' },
				{ value: 4, text: '4' },
			],
			[
				'Friday, August 28',
				{ value: 15, text: '15%' },
				{ value: 60, text: '60' },
				{ value: 9, text: '9' },
			],
			[
				'Saturday, August 29',
				{ value: 20, text: '20%' },
				{ value: 80, text: '80' },
				{ value: 16, text: '16' },
			],
		],
		'hand stop record week: 4/40, 9/60, 16/80 and four unpublished days',
	);
	expectLiteral(
		expectedDomainObservations('rich', 'stop', 'fr').find((row) => row.id === 'stop.daily.limits')
			?.value,
		[[7], [4, 7], [40, 80]],
		'hand stop limits: 7 record days, 4 gaps, 40 to 80 readings',
	);
	expectLiteral(
		expectedDomainObservations('sparse', 'stop').find((row) => row.id === 'stop.daily.rows')
			?.value[6],
		[
			'Saturday, August 29',
			{ value: 0, text: '0%' },
			{ value: 29, text: '29' },
			{ value: 0, text: '0' },
		],
		'hand sparse stop: a measured zero stays 0%, never a gap',
	);
	expectLiteral(
		[expectedStopLatestDay(FIXTURES.rich, 'en'), expectedStopLatestDay(FIXTURES.rich, 'fr')],
		['Saturday, August 29', 'samedi 29 août'],
		'hand stop representative day in words',
	);
	expectLiteral(
		expectedDomainObservations('rich', 'line')[11]?.value.rows.slice(0, 2),
		[
			{
				name: 'B9 Stop 01',
				value: 50,
				unit: '%',
				readings: 100,
				text: '50% of readings more than 5 minutes late',
				readingsText: '100 readings',
			},
			{
				name: 'B9 Stop 02',
				value: 48,
				unit: '%',
				readings: 100,
				text: '48% of readings more than 5 minutes late',
				readingsText: '100 readings',
			},
		],
		'hand stop list by late share, readings and no complementary interval',
	);
	expectLiteral(
		expectedDomainObservations('rich', 'line', 'en', '/lines/24?from=2026-08-27&to=2026-08-29')
			.filter((row) => ['line.weak_stops.raw_count', 'line.time.rows'].includes(row.id))
			.map((row) => (row.id === 'line.time.rows' ? row.value.onTime : row.value)),
		[0, { headers: [], rows: [] }],
		'a chosen range lends no stop or time-of-day cut from the latest day',
	);
	expectLiteral(
		expectedDomainObservations('rich', 'line')
			.find((row) => row.id === 'line.time.rows')
			?.value.onTime.rows.map((row) => [row[0], row[1]?.value ?? null]),
		[
			['am_peak', 70],
			['pm_peak', 60],
			['Day type', null],
			['weekday', 74],
			['weekend', 85],
		],
		'hand time of day from counts 35/50, 30/50, 59/80, 34/40 (published 84 is not the counts)',
	);
	expectLiteral(
		routeFile(FIXTURES.rich)
			.weak_stops_by_grain[0].stops.slice(1, 4)
			.map((row) => [row.id, row.wilson_lo, row.avg_delay_min]),
		[
			['b9-02', 42.3, 12],
			['b9-03', 42.3, 11],
			['b9-04', 42.3, 11],
		],
		'hand weak-stop equal-Wilson higher-delay then id tie-break',
	);
	const weekHistogram = expectedDomainObservations('rich', 'line').find(
		(row) => row.id === 'line.week.histogram',
	)?.value;
	const onTimeBin = weekHistogram.rows.find((bin) => bin.lo === 0 && bin.hi === 120);
	expectLiteral(onTimeBin.count / (onTimeBin.hi - onTimeBin.lo), 2 / 3, 'hand closed-day density');
	expectLiteral(
		expectedScheduleTruth(FIXTURES.rich),
		{ date: '2026-08-29', hasData: true, hasSchedule: true },
		'rich schedule truth',
	);
	expectLiteral(
		expectedScheduleTruth(FIXTURES.sparse),
		{ date: '2026-08-29', hasData: true, hasSchedule: false },
		'sparse schedule truth',
	);
	for (const family of SURFACES) proveNegativeControl(family);
	return {
		families: SURFACES.length,
		markKinds: MARK_KINDS.length,
		normalizationRules: CLOCK_NORMALIZATION_ALLOWLIST.length,
	};
}
