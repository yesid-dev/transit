import { intl } from '#lib/i18n/index.ts';
import { roundHalfAwayFromZero } from './rounding';

export type FormatLang = 'en' | 'fr';

function isPresent(v: number | null | undefined): v is number {
	return v != null && Number.isFinite(v);
}

type Rounding = 'raw' | 'round' | 'fixed1' | 'auto';

function roundFor(v: number, rounding: Rounding): number {
	return rounding === 'raw' ? v : roundHalfAwayFromZero(v, rounding === 'round' ? 0 : 1);
}

function fractionDigits(rounding: Rounding): Intl.NumberFormatOptions | undefined {
	if (rounding === 'fixed1') return { minimumFractionDigits: 1, maximumFractionDigits: 1 };
	if (rounding === 'auto') return { maximumFractionDigits: 1 };
	return undefined;
}

function core(v: number, rounding: Rounding, locale: FormatLang | undefined): string {
	const rounded = roundFor(v, rounding);
	if (locale) return intl.number(locale, fractionDigits(rounding)).format(rounded);

	switch (rounding) {
		case 'round':
			return String(rounded);
		case 'auto':
			return Number.isInteger(v) ? String(v) : rounded.toFixed(1);
		case 'fixed1':
			return rounded.toFixed(1);
		default:
			return String(v);
	}
}

interface BaseOpts<NoData extends string | null> {
	rounding?: Rounding;
	locale?: FormatLang;
	noData?: NoData;
}

export function fmtPct<NoData extends string | null = null>(
	v: number | null | undefined,
	opts: BaseOpts<NoData> & { suffix?: string } = {},
): string | NoData {
	if (!isPresent(v)) return (opts.noData ?? null) as NoData;
	return `${core(v, opts.rounding ?? 'raw', opts.locale)}${opts.suffix ?? '%'}`;
}

/**
 * Reader-facing percentage in the locale's own typography: en-CA "82%", fr-CA "82 %"
 * (no-break space, decimal comma). `v` is in percentage points, like fmtPct. Rounding is
 * bounded (default: at most one decimal) and uses decimal half-away ties before Intl
 * formats. Absent values return `noData`; a measured 0 is "0%". fmtPct is unchanged.
 */
export function fmtLocalePct<NoData extends string | null = null>(
	v: number | null | undefined,
	locale: FormatLang,
	opts: { rounding?: Exclude<Rounding, 'raw'>; noData?: NoData } = {},
): string | NoData {
	if (!isPresent(v)) return (opts.noData ?? null) as NoData;
	const rounding = opts.rounding ?? 'auto';
	const options = { style: 'percent', ...fractionDigits(rounding) } as const;
	return intl.number(locale, options).format(roundFor(v, rounding) / 100);
}

export function fmtNumber<NoData extends string | null = null>(
	v: number | null | undefined,
	opts: BaseOpts<NoData> = {},
): string | NoData {
	if (!isPresent(v)) return (opts.noData ?? null) as NoData;
	return core(v, opts.rounding ?? 'raw', opts.locale);
}

export { fmtNumber as fmtCount };

export function fmtDelayMin<NoData extends string | null = null>(
	v: number | null | undefined,
	opts: BaseOpts<NoData> & { suffix?: string } = {},
): string | NoData {
	if (!isPresent(v)) return (opts.noData ?? null) as NoData;
	const suffix = opts.suffix ?? ' min';

	return `${core(v, opts.rounding ?? 'raw', opts.locale)}${suffix}`;
}
