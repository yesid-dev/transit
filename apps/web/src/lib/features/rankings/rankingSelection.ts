import { localizeHref, type Locale } from '#lib/i18n/index.ts';

export const rankingPath = '/rankings';
export const rankingLists = {
	line: { label: { en: 'Lines', fr: 'Lignes' }, title: { en: 'Worst lines', fr: 'Pires lignes' } },
	stop: { label: { en: 'Stops', fr: 'Arrêts' }, title: { en: 'Worst stops', fr: 'Pires arrêts' } },
	departure: {
		label: { en: 'Departures', fr: 'Départs' },
		title: { en: 'Departures that fail most often', fr: 'Départs qui échouent le plus souvent' },
	},
	vehicle: {
		label: { en: 'Vehicles', fr: 'Véhicules' },
		title: {
			en: 'Vehicles that stop reporting most often',
			fr: 'Véhicules qui interrompent le plus souvent leur signalement',
		},
	},
} as const;

export type RankingKind = keyof typeof rankingLists;
export type LegacyRankingPath = '/hotspots' | '/repeat-offenders';
export type RankingPath = typeof rankingPath | LegacyRankingPath;
export const rankingKinds = Object.keys(rankingLists) as RankingKind[];

export function isRankingPath(path: string): path is RankingPath {
	return path === rankingPath || path === '/hotspots' || path === '/repeat-offenders';
}

export const measures = {
	on_time: { en: 'On-time share', fr: 'Part à l’heure' },
	late: { en: 'Late share', fr: 'Part en retard' },
	early: { en: 'Early departure share', fr: 'Part des départs en avance' },
	excess_wait_time: { en: 'Excess wait time', fr: 'Attente excédentaire' },
	median_delay: { en: 'Median delay', fr: 'Retard médian' },
	cancelled_trips: { en: 'Cancelled trip share', fr: 'Part des trajets annulés' },
	missing_trips: { en: 'Missing trip share', fr: 'Part des trajets manquants' },
	vehicle_reporting_gaps_per_100_hours: {
		en: 'Stopped reporting',
		fr: 'Interruptions de signalement',
	},
} as const;

export type RankingMeasure = keyof typeof measures;
export const reporting = 'vehicle_reporting_gaps_per_100_hours';
const punctuality = ['on_time', 'late', 'median_delay'] as const;
const delivery = [...punctuality, 'cancelled_trips', 'missing_trips'] as const;
export const rankingMeasures: Record<RankingKind, readonly [RankingMeasure, ...RankingMeasure[]]> =
	{
		line: [...delivery, 'early', 'excess_wait_time'],
		stop: punctuality,
		departure: delivery,
		vehicle: [reporting],
	};

export function worseIsHigher(measure: RankingMeasure) {
	return measure !== 'on_time';
}

export function canRankVehicles(inputs?: Record<string, boolean>) {
	return inputs?.vehicle_positions !== false && inputs?.stable_vehicle_ids !== false;
}

const legacyKinds = {
	'/hotspots': ['line', 'stop'],
	'/repeat-offenders': ['departure', 'vehicle'],
} as const;

const aliases: Partial<Record<string, RankingKind>> = {
	lines: 'line',
	stops: 'stop',
	departures: 'departure',
	trips: 'departure',
	vehicles: 'vehicle',
	buses: 'vehicle',
};

export function rankingSelection(path: RankingPath, params: URLSearchParams) {
	const raw = params.get('kind');
	const requested = raw !== null && Object.hasOwn(aliases, raw) ? aliases[raw] : raw;
	const kinds: readonly RankingKind[] = path === rankingPath ? rankingKinds : legacyKinds[path];
	const kind = kinds.find((key) => key === requested) ?? kinds[0];
	const options = rankingMeasures[kind];
	const measure = options.find((option) => option === params.get('measure')) ?? options[0];
	const serviceClass = params.get('class');
	return {
		kind,
		measure,
		serviceClass:
			kind === 'line' &&
			serviceClass != null &&
			/^(?:all|(?:[0-9]+|unknown|mixed):(?:night|frequent|regular))$/.test(serviceClass)
				? serviceClass
				: null,
	};
}

export type RankingSelection = ReturnType<typeof rankingSelection>;

export function rankingHref(selection: RankingSelection, locale: Locale, source: URLSearchParams) {
	const params = new URLSearchParams(source);
	params.delete('kind');
	params.delete('measure');
	params.delete('class');
	if (selection.kind !== 'line') params.set('kind', selection.kind);
	if (selection.measure !== rankingMeasures[selection.kind][0])
		params.set('measure', selection.measure);
	if (selection.serviceClass) params.set('class', selection.serviceClass);
	return localizeHref(rankingPath + (params.size ? `?${params}` : ''), locale);
}

export function legacyRankingHref(path: LegacyRankingPath, url: URL, locale: Locale) {
	return rankingHref(rankingSelection(path, url.searchParams), locale, url.searchParams);
}
