import { intl, type Locale } from '#lib/i18n/index.ts';
import { fmtLocalePct } from '#lib/utils/format.ts';
import { datePart, dayOfMonth, periodRange } from '../../stopRecord';
import { stopReliabilityCopy } from '../stops-reliability.copy';
import type { DayByDay } from './dailyTrend';

/** "Monday, November 9" / "lundi 9 novembre" (« 1er » on the first). */
export function longDay(date: string, locale: Locale): string {
	if (locale === 'fr')
		return `${datePart(date, locale, { weekday: 'long' })} ${dayOfMonth(date, locale)} ${datePart(date, locale, { month: 'long' })}`;
	return datePart(date, locale, { weekday: 'long', month: 'long', day: 'numeric' });
}

/** "November 4 to 10, 2026" / "du 4 au 10 novembre 2026"; one day as "November 4, 2026". */
export function dayByDayDates(view: DayByDay, locale: Locale): string | null {
	if (view.from == null || view.to == null) return null;
	if (view.from !== view.to) return periodRange(view.from, view.to, locale);
	const year = view.from.slice(0, 4);
	return locale === 'fr'
		? `${dayOfMonth(view.from, locale)} ${datePart(view.from, locale, { month: 'long' })} ${year}`
		: `${datePart(view.from, locale, { month: 'long', day: 'numeric' })}, ${year}`;
}

/** The section's persistent one-line finding. */
export function dayByDaySummary(view: DayByDay, locale: Locale): string {
	const t = stopReliabilityCopy[locale].dayByDay;
	if (view.low == null || view.high == null) return t.summaryAbsent;
	const pct = (value: number) => fmtLocalePct(value, locale, { noData: '' });
	return t.summary(pct(view.low.percent), pct(view.high.percent), longDay(view.high.date, locale));
}

/** What these days are and what they cannot show: basis, gaps, readings per day. */
export function dayByDayScope(view: DayByDay, locale: Locale): string[] {
	const t = stopReliabilityCopy[locale].dayByDay;
	const n = (value: number) => intl.number(locale).format(value);
	const days = view.rows.length;
	const lines: string[] = [];
	if (view.basis === 'record') lines.push(t.basis.record(n(days)));
	else if (view.basis === 'chosen') lines.push(t.basis.chosen);
	else if (view.basis === 'latest') lines.push(t.basis.latest(n(days)));
	lines.push(view.gapDays > 0 ? t.gaps(view.gapDays, n(view.gapDays), n(days)) : t.noGaps);
	const { fewestReadings: fewest, mostReadings: most } = view;
	if (fewest != null && most != null)
		lines.push(
			fewest === most ? t.readingsSame(fewest, n(fewest)) : t.readings(n(fewest), n(most)),
		);
	return lines;
}
