import { intl, type Locale } from '#lib/i18n/index.ts';
import type { HistoricAvailabilityIndex, NetworkTrend, TrendPoint } from '#lib/v1/index.ts';
import { isReliableRate } from '#lib/v1/stats.ts';

/** Seven calendar days, as published dates (YYYY-MM-DD). */
export interface RecordWeek {
	readonly from: string;
	readonly to: string;
}

/**
 * The network's latest complete week, as the home's record card states it. `held` keeps the week's
 * own dates but no figure: too few readings to headline one, or a figure the file does not publish
 * or publishes out of range. A share is never derived from rounded weekly shares.
 */
export type HomeRecord =
	| {
			readonly kind: 'week';
			readonly week: RecordWeek;
			/** Share of the week's readings on time, 0 to 100, as published. */
			readonly onTimePct: number;
			readonly readings: number;
			/** The seven days before, when the record covers them with a figure of its own. */
			readonly previous: { readonly week: RecordWeek; readonly onTimePct: number } | null;
	  }
	| {
			readonly kind: 'held';
			readonly reason: 'thin' | 'unpublished';
			readonly week: RecordWeek;
			/** A whole count of readings; null when the file gives none it can be trusted for. */
			readonly readings: number | null;
	  }
	| { readonly kind: 'none' };

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A week as its own dates: "November 2 to 8" / "2 au 8 novembre", the month once when it does not
 * change, the year only when the week crosses one. French callers add « du ».
 */
export function formatWeek(week: RecordWeek, locale: Locale): string {
	const [from, to] = [week.from, week.to].map((key) => new Date(`${key}T00:00:00Z`));
	const year = from.getUTCFullYear() !== to.getUTCFullYear();
	const sameMonth = !year && from.getUTCMonth() === to.getUTCMonth();
	const part = (date: Date, month: boolean) => {
		const day = date.getUTCDate();
		const name = intl.dateTime(locale, { month: 'long', timeZone: 'UTC' }).format(date);
		const y = year ? date.getUTCFullYear() : null;
		if (locale === 'fr')
			return [day === 1 ? '1er' : String(day), month ? name : null, y].filter(Boolean).join(' ');
		return `${month ? `${name} ` : ''}${day}${y ? `, ${y}` : ''}`;
	};
	return locale === 'fr'
		? `${part(from, !sameMonth)} au ${part(to, true)}`
		: `${part(from, true)} to ${part(to, !sameMonth)}`;
}

function shift(key: string, days: number): string {
	const date = new Date(`${key}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

function readings(point: TrendPoint): number | null {
	const n = point.observation_count;
	return n != null && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function share(point: TrendPoint): number | null {
	const pct = point.otp_pct;
	return pct != null && Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct + 0 : null;
}

/** A week counts when it is over, began after collection did and has no published gap. */
export function latestCompleteWeek(
	trend: NetworkTrend | null | undefined,
	availability: HistoricAvailabilityIndex | null | undefined,
): HomeRecord {
	const network = availability?.families?.find((family) => family.family === 'network');
	const first = network?.first_available_date;
	const last = network?.last_available_date;
	if (!trend || !first || !last) return { kind: 'none' };
	const gaps = network.gaps ?? [];
	const weekOf = (point: TrendPoint): RecordWeek | null => {
		if (!DATE.test(point.date) || Number.isNaN(Date.parse(point.date))) return null;
		const week = { from: point.date, to: shift(point.date, 6) };
		const complete =
			week.from >= first &&
			week.to <= last &&
			!gaps.some((gap) => gap.start_date <= week.to && gap.end_date >= week.from);
		return complete ? week : null;
	};
	const complete = (trend.weekly ?? [])
		.map((point) => ({ point, week: weekOf(point) }))
		.filter((entry): entry is { point: TrendPoint; week: RecordWeek } => entry.week != null)
		.sort((a, b) => (a.week.from < b.week.from ? 1 : a.week.from > b.week.from ? -1 : 0));
	const latest = complete[0];
	if (!latest) return { kind: 'none' };
	const count = readings(latest.point);
	const pct = share(latest.point);
	if (count != null && !isReliableRate(count))
		return { kind: 'held', reason: 'thin', week: latest.week, readings: count };
	if (count == null || pct == null)
		return { kind: 'held', reason: 'unpublished', week: latest.week, readings: count };
	const before = complete.find((entry) => entry.week.from === shift(latest.week.from, -7));
	const beforePct = before && isReliableRate(readings(before.point)) ? share(before.point) : null;
	return {
		kind: 'week',
		week: latest.week,
		onTimePct: pct,
		readings: count,
		previous: before && beforePct != null ? { week: before.week, onTimePct: beforePct } : null,
	};
}
