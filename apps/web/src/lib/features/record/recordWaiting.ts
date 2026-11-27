import type { Locale } from '#lib/i18n/index.ts';
import { dateRange } from '#lib/site/presenter.ts';

/**
 * The shapes a card body takes while its answer is on the way. Each one draws the final
 * layout at the final height, so the page keeps its length when the answer arrives.
 */
export type RecordWaitingShape =
	| 'answer'
	| 'reading'
	| 'facts'
	| 'trip-facts'
	| 'bands'
	| 'band-comparison'
	| 'comparison-facts'
	| 'trend'
	| 'table'
	| 'card'
	| 'listing'
	| 'line'
	| 'rows'
	| 'grid'
	| 'histogram'
	| 'ladder'
	| 'notice'
	| 'tiles';

export interface RecordSkeletonSpec {
	shape: RecordWaitingShape;
	/** facts, rows, ladder, notice, tiles: how many. table: use `rows`. */
	count?: number;
	/** table: body rows. */
	rows?: number;
	/** rows: one line per row, or a name with a muted line under it. */
	lines?: 1 | 2;
	/** rows: the block before the name (a line plate, a stop code) or none. */
	lead?: 'plate' | 'code' | 'none';
	/** table and rows: draw the header row. */
	header?: boolean;
	/** answer: the comparison line some screens add under the evidence. */
	comparison?: boolean;
	/** tiles: a short catalogue card or a download file card. */
	size?: 'small' | 'file';
}

/** A screen passes a shape name, or a shape with its counts. */
export type RecordWaiting = RecordWaitingShape | RecordSkeletonSpec;

export type ResolvedSkeleton = Required<Omit<RecordSkeletonSpec, 'rows'>> & { rows: number };

/** A ladder shows at most this many stops while waiting; longer lines end with "Show all". */
export const LADDER_CAP = 12;

const defaultCount: Partial<Record<RecordWaitingShape, number>> = {
	facts: 3,
	rows: 8,
	ladder: LADDER_CAP,
	notice: 2,
	tiles: 4,
};

function whole(value: number | undefined, fallback: number) {
	return value !== undefined && Number.isFinite(value) ? Math.max(1, Math.round(value)) : fallback;
}

export function resolveWaiting(waiting: RecordWaiting): ResolvedSkeleton {
	const spec = typeof waiting === 'string' ? { shape: waiting } : waiting;
	return {
		shape: spec.shape,
		count: whole(spec.count, defaultCount[spec.shape] ?? 1),
		rows: whole(spec.rows, 4),
		lines: spec.lines ?? 2,
		lead: spec.lead ?? 'plate',
		header: spec.header ?? true,
		comparison: spec.comparison ?? false,
		size: spec.size ?? 'small',
	};
}

/** Measured heights of the filled parts, in rem (16 px). */
export const skeletonRem = {
	header: 2, // 32 px table header
	fact: 2.75, // 44 px fact row and table row
	tripFactsWideWrap: 1.4375, // scope note under the trip facts, rounded up to a whole pixel
	tripFactsPhoneWrap: 6.75, // wrapped labels, sample and notes under the trip facts
	rowTwoLines: 3.8125, // 61 px
	rowOneLine: 2.4375, // 39 px
	bandBar: 1.75, // 28 px
	bandRow: 2.25, // 36 px
	noteLine: 1.5, // a 16 px line and its 8 px gap
	gridRow: 2.1875, // 35 px
	gridLegend: 3.5, // 56 px
	histogram: 22,
	ladderRow: 3, // 48 px
	showAll: 2.75,
	notice: 7.9375, // 127 px
	noticeGap: 0.75,
	tileSmall: 5.9375, // 95 px
	tileFile: 13.1875, // 211 px
} as const;

function rem(value: number) {
	return `${Math.round(value * 10_000) / 10_000}rem`;
}

/**
 * The block size a shape takes, from the rule of the skeleton spec. Null when the height
 * follows the layout (answers, wrapped tiles): the shape then sizes itself.
 * A card that ends in a short honest state keeps this height as its minimum.
 */
export function skeletonBlockSize(waiting: RecordWaiting): string | null {
	const s = resolveWaiting(waiting);
	const r = skeletonRem;
	switch (s.shape) {
		case 'facts':
			return rem(s.count * r.fact);
		case 'trip-facts':
			return rem(6 * r.fact);
		case 'table':
			return rem((s.header ? r.header : 0) + s.rows * r.fact);
		case 'rows':
			return rem(
				(s.header ? r.header : 0) + s.count * (s.lines === 2 ? r.rowTwoLines : r.rowOneLine),
			);
		case 'bands':
			return rem(r.bandBar + 3 * r.bandRow + 2 * r.noteLine);
		case 'grid':
			return rem(r.header + 7 * r.gridRow + r.gridLegend);
		case 'histogram':
			return rem(r.histogram);
		case 'trend':
			return 'calc(clamp(12rem, 26vw, 17rem) + 1.5rem)';
		case 'ladder':
			return rem(
				Math.min(s.count, LADDER_CAP) * r.ladderRow + (s.count > LADDER_CAP ? r.showAll : 0),
			);
		case 'notice':
			return rem(s.count * r.notice + (s.count - 1) * r.noticeGap);
		default:
			return null;
	}
}

/**
 * A waiting card keeps a foot line under its shape for the words, empty and invisible before
 * 3 s, so the words never cover a bar and the height never changes when they appear. One line
 * of small text; two on a phone, where the busy sentence wraps. RecordPending draws these.
 */
export const pendingFootRem = { gap: 0.5, wide: 1.375, phone: 2.75 } as const;

/**
 * The full waiting height of a card body drawn by RecordPending: the shape's rule height plus
 * the foot line, wide (from 40rem) and on a phone. Null when the shape follows its layout.
 */
export function pendingBlockSize(waiting: RecordWaiting): { wide: string; phone: string } | null {
	const shape = skeletonBlockSize(waiting);
	if (!shape) return null;
	const foot = (line: number) => `${Math.round((pendingFootRem.gap + line) * 10_000) / 10_000}rem`;
	const plus = (line: number) =>
		shape.endsWith('rem') && !shape.startsWith('calc')
			? rem(Number(shape.slice(0, -3)) + pendingFootRem.gap + line)
			: `calc(${shape} + ${foot(line)})`;
	const tripFacts = resolveWaiting(waiting).shape === 'trip-facts';
	return {
		wide: plus(pendingFootRem.wide + (tripFacts ? skeletonRem.tripFactsWideWrap : 0)),
		phone: plus(pendingFootRem.phone + (tripFacts ? skeletonRem.tripFactsPhoneWrap : 0)),
	};
}

/** Words a waiting card shows under its skeleton, small and muted. */
export const cardWaitingWords = {
	/** After 3 s. Before that the shape alone speaks. */
	still: { en: 'Still calculating…', fr: 'Calcul toujours en cours…' },
	/** The engine said busy: the skeleton stays and the card asks again. */
	busy: {
		en: 'Waiting for a turn. This card asks again in a few seconds.',
		fr: 'En attente. Cette carte redemande dans quelques secondes.',
	},
} as const satisfies Record<string, Record<Locale, string>>;

/** After this long without an answer a waiting card says it is still calculating. */
export const STILL_CALCULATING_MS = 3_000;

export type ScreenWaitingStage = 'loading' | 'still' | 'done' | 'live';

/**
 * The one live region of a screen (role="status"): what assistive tech hears while the
 * cards wait. Cards themselves never announce.
 */
export function screenWaitingWords(
	stage: ScreenWaitingStage,
	locale: Locale,
	period: { from: string; to: string } | null = null,
): string {
	const fr = locale === 'fr';
	if (stage === 'live') return fr ? 'Chargement des données en direct…' : 'Loading live reports…';
	if (stage === 'done') return fr ? 'Le bilan est affiché.' : 'The record is on screen.';
	const range = period ? dateRange(period, locale) : null;
	// French ranges read "du 19 au 25 nov. 2026"; a single day needs its own "du".
	const frDates = range && period ? (period.from === period.to ? `du ${range}` : range) : null;
	if (stage === 'loading') {
		if (fr) return frDates ? `Chargement du bilan ${frDates}.` : 'Chargement du bilan.';
		return range ? `Loading the record for ${range}.` : 'Loading the record.';
	}
	if (fr)
		return `${frDates ? `Le calcul du bilan ${frDates} se poursuit.` : 'Le calcul du bilan se poursuit.'} Chaque carte se remplit dès que sa réponse arrive.`;
	return `${range ? `Still calculating the record for ${range}.` : 'Still calculating the record.'} Each card fills in when its answer arrives.`;
}
