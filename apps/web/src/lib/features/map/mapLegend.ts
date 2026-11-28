import type { Locale } from '#lib/i18n/index.ts';
import { lineIsScheduleOnly } from '#lib/site/providerCapabilities.ts';
import { transitTerms } from '#lib/i18n/transitTerms.copy.ts';
import { ON_TIME_LIMITS_S } from '#lib/v1/live/statusBands.ts';
import { OCCUPANCY_CODES, STATUS_CODES } from '#lib/v1/schemas/types.ts';
import type { OccupancyCode, StatusCode } from '#lib/v1/schemas/index.ts';
import type { RecordMapLayer } from '#lib/site/mapFrame.ts';
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
	note: string | null;
}

const NB = ' ';

type LegendCopy = MapCopy['legend'];

/** "2 min 30 s"; null when the cutoff is not a positive, finite time. */
function duration(seconds: number): string | null {
	const total = Number.isFinite(seconds) ? Math.round(seconds) : 0;
	if (total <= 0) return null;
	const m = Math.floor(total / 60);
	const s = total % 60;
	return [m > 0 ? `${m}${NB}min` : '', s > 0 ? `${s}${NB}s` : ''].filter(Boolean).join(NB);
}

function statusRows(locale: Locale, t: LegendCopy): LegendRow[] {
	const earlyMinutes = -ON_TIME_LIMITS_S.from / 60;
	const lateMinutes = ON_TIME_LIMITS_S.through / 60;
	const definitions: Record<StatusCode, string> = {
		early: t.moreEarly(earlyMinutes),
		on_time: t.earlyToLate(earlyMinutes, lateMinutes),
		late: t.moreLate(lateMinutes),
		unknown: t.unknown,
	};
	return STATUS_CODES.map((code) => ({
		id: `status-${code}`,
		mark: { kind: 'status', code },
		label: mapStatusLabel(locale, code),
		definition: definitions[code],
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
		note: colourBy === 'occupancy' ? t.zoomCrowdingBadges : null,
	};
}

export function railLegendName(
	locale: Locale,
	provider: Parameters<typeof lineIsScheduleOnly>[0],
	routes: readonly { id: string; type?: number | null }[],
): string | undefined {
	const types = new Set(
		routes
			.filter(({ id, type }) => lineIsScheduleOnly(provider, id, type ?? null))
			.map(({ type }) => type),
	);
	if (types.size !== 1) return undefined;
	switch (types.values().next().value) {
		case 0:
			return locale === 'fr' ? 'train léger' : 'light rail';
		case 1:
			return 'métro';
		case 2:
			return 'train';
		default:
			return undefined;
	}
}

/**
 * What each Record layer colours, in one line: the legend's title and the line under the layer
 * choice, so Corridors and Clear run say how they differ where the rider picks one.
 */
export function recordLayerTitle(layer: Exclude<RecordMapLayer, 'live'>, locale: Locale): string {
	const fr = locale === 'fr';
	switch (layer) {
		case 'stops':
			return fr
				? 'Part des passages enregistrés en retard'
				: 'Share of recorded stop arrivals that were late';
		case 'waits':
			return fr ? 'Attente en plus à chaque arrêt' : 'Extra wait at each stop';
		case 'clear-run':
			return fr
				? 'Temps perdu entre deux arrêts, par rapport aux trajets les plus rapides'
				: 'Time lost between two stops, against the fastest trips';
		case 'corridors':
			return fr
				? 'Temps perdu entre deux arrêts, par rapport à l’horaire'
				: 'Time lost between two stops, against the timetable';
	}
}

/** The legend note for a capped overview; the count is what the map actually colours. */
export function recordCapNote(count: string, locale: Locale): string {
	return locale === 'fr'
		? `Seuls les ${count} pires sont en couleur à ce zoom. Zoomez pour les voir tous, bons et mauvais.`
		: `Only the ${count} worst are coloured at this zoom. Zoom in to see all of them, good and bad.`;
}
