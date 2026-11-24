import type { Locale } from '#lib/i18n/index.ts';
import { transitTerms } from '#lib/i18n/transitTerms.copy.ts';
import { LIVE_STATUS_BANDS, type DelayBand } from '#lib/v1/live/statusBands.ts';
import { OCCUPANCY_CODES, STATUS_CODES } from '#lib/v1/schemas/types.ts';
import type { OccupancyCode, StatusCode } from '#lib/v1/schemas/index.ts';
import { copy, type MapCopy } from './map.copy';
import { mapStatusLabel } from './mapStatusLabels';

/** What the vehicle markers are coloured by; the legend explains only that. */
export type LegendColourBy = 'status' | 'occupancy';

export type LegendMark =
	| { kind: 'status'; code: StatusCode }
	| { kind: 'occupancy'; code: OccupancyCode }
	| { kind: 'stale' }
	| { kind: 'heading' }
	| { kind: 'stop' };

export interface LegendRow {
	id: string;
	mark: LegendMark;
	label: string;
	/** A second, muted line: the exact rule behind the mark, when there is one to state. */
	definition: string | null;
}

export interface LegendGroup {
	id: LegendColourBy | 'position' | 'symbols';
	heading: string;
	rows: readonly LegendRow[];
}

export interface MapLegendModel {
	groups: readonly LegendGroup[];
	note: string;
}

const NB = ' ';

type LegendCopy = MapCopy['legend'];

/** The band's rule in words, or null for a shape the copy has no sentence for. */
function bandDefinition(t: LegendCopy, { fromS, belowS }: DelayBand): string | null {
	const from = fromS == null ? null : fromS / 60;
	const below = belowS == null ? null : belowS / 60;
	if ((from != null && !Number.isInteger(from)) || (below != null && !Number.isInteger(below)))
		return null;
	if (from == null && below != null && below < 0) return t.moreEarly(-below);
	if (from != null && from < 0 && below != null && below > 0) return t.earlyToLate(-from, below);
	if (from != null && from > 0 && below == null) return t.lateOrMore(from);
	return null;
}

/** "2 min 30 s"; null when the cutoff is not a positive, finite time. */
function duration(seconds: number): string | null {
	const total = Number.isFinite(seconds) ? Math.round(seconds) : 0;
	if (total <= 0) return null;
	const m = Math.floor(total / 60);
	const s = total % 60;
	return [m > 0 ? `${m}${NB}min` : '', s > 0 ? `${s}${NB}s` : ''].filter(Boolean).join(NB);
}

function statusRows(locale: Locale, t: LegendCopy): LegendRow[] {
	return STATUS_CODES.map((code) => ({
		id: `status-${code}`,
		mark: { kind: 'status', code },
		label: mapStatusLabel(locale, code),
		definition: code === 'unknown' ? t.unknown : bandDefinition(t, LIVE_STATUS_BANDS[code]),
	}));
}

function occupancyRows(t: LegendCopy): LegendRow[] {
	return OCCUPANCY_CODES.map((code) => ({
		id: `occupancy-${code}`,
		mark: { kind: 'occupancy', code },
		label: t.occupancy[code],
		definition: null,
	}));
}

/**
 * The map legend as data: the colour group follows what the map is coloured by (the same rule
 * as `colourDimension` in the vehicle layer), with each status's minutes read from the live
 * bands; then the "no recent position" mark at the map's own cutoff; then the map symbols.
 */
export function mapLegend(
	locale: Locale,
	{ colourBy, staleCutoffS }: { colourBy: LegendColourBy; staleCutoffS: number },
): MapLegendModel {
	const t = copy[locale].legend;
	const staleFor = duration(staleCutoffS);
	return {
		groups: [
			colourBy === 'occupancy'
				? { id: 'occupancy', heading: t.crowdingGroup, rows: occupancyRows(t) }
				: { id: 'status', heading: t.statusGroup, rows: statusRows(locale, t) },
			{
				id: 'position',
				heading: t.positionGroup,
				rows: [
					{
						id: 'not-reporting',
						mark: { kind: 'stale' },
						label: transitTerms[locale].vehicle.noRecentPosition,
						definition: staleFor == null ? null : t.staleFor(staleFor),
					},
				],
			},
			{
				id: 'symbols',
				heading: t.symbolsGroup,
				rows: [
					{ id: 'heading', mark: { kind: 'heading' }, label: t.heading, definition: null },
					{ id: 'stop', mark: { kind: 'stop' }, label: t.stop, definition: null },
				],
			},
		],
		note: colourBy === 'occupancy' ? t.zoomCrowdingBadges : t.zoomBadges,
	};
}
