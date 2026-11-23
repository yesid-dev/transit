export const rankingLists = {
	line: { path: '/hotspots', label: { en: 'Lines', fr: 'Lignes' } },
	stop: { path: '/hotspots', label: { en: 'Stops', fr: 'Arrêts' } },
	departure: { path: '/repeat-offenders', label: { en: 'Departures', fr: 'Départs' } },
	vehicle: { path: '/repeat-offenders', label: { en: 'Vehicles', fr: 'Véhicules' } },
} as const;

export type RankingKind = keyof typeof rankingLists;
export type RankingPath = (typeof rankingLists)[RankingKind]['path'];
export const rankingKinds = Object.keys(rankingLists) as RankingKind[];

export function isRankingPath(path: string): path is RankingPath {
	return path === '/hotspots' || path === '/repeat-offenders';
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

export function rankingSelection(path: RankingPath, params: URLSearchParams) {
	const raw = params.get('kind');
	const requested = raw === 'stops' ? 'stop' : raw === 'buses' ? 'vehicle' : raw;
	const kind =
		rankingKinds.find((key) => key === requested && rankingLists[key].path === path) ??
		(path === '/hotspots' ? 'line' : 'departure');
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
