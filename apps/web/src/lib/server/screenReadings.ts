import type { RecoveryScreen } from '#lib/features/record/recordReadings.ts';
import { rankingPath } from '#lib/features/rankings/rankingSelection.ts';
import { fleetView, projectFleetAnswer } from '#lib/features/vehicles/vehicleFleet.ts';
import type { Locale } from '#lib/i18n/index.ts';
import { getCityCatalog, getScheduleEdition, type EnginePeriod } from './engine.ts';
import {
	dailyDirectory,
	departureDay,
	loadDailyRecord,
	loadDepartureRecord,
} from './departureDailyRecord.ts';
import { departureFromKey } from '#lib/features/record/departureIdentity.ts';
import { readLinesRecord } from './finderRecord.ts';
import { readHealthRecord } from './healthRecord.ts';
import { lineDirection, loadLineRecord } from './lineRecord.ts';
import { loadNetworkRecord } from './networkRecord.ts';
import { loadAlertRecord } from './alertRecord.ts';
import { readOverviewRecord } from './overviewRecord.ts';
import { loadRankingsRecord } from './rankingsRecord.ts';
import { projectStops } from './stopListing.ts';
import { loadStopRecord } from './stopRecord.ts';
import { readVehicleSections } from './vehicleRecord.ts';

export type ScreenAgain = {
	screen: RecoveryScreen;
	/** The period, city and visitor of the page that asked first. */
	scope: EnginePeriod & { visitorIp: string | null };
	id: string;
	/** The page's own address parameters: its direction, list view or ranking. */
	page: URLSearchParams;
	lang: Locale;
	request: Request;
};

/** The page's address with its dates pinned, for screens that read their choices from it. */
function pinnedPage({ page, scope }: ScreenAgain, path: string) {
	const url = new URL(path, 'https://transit.invalid');
	url.search = page.toString();
	url.searchParams.set('frameMode', 'record');
	url.searchParams.delete('period');
	url.searchParams.set('recordFrom', scope.from);
	url.searchParams.set('recordTo', scope.to);
	return url;
}

async function publicCity(city: string, visitorIp: string | null) {
	try {
		return (await getCityCatalog(visitorIp)).providers.find(({ id }) => id === city) ?? null;
	} catch {
		return null;
	}
}

const samePeriod = (period: { from: string; to: string } | null, scope: EnginePeriod) =>
	period?.from === scope.from && period.to === scope.to;

/**
 * The named readings of one screen, asked again with the page's own cut, in the same places as
 * in its page data. Readings that come with another (the Overview's three stop names) come too.
 */
export async function readScreenAgain(again: ScreenAgain, only: ReadonlySet<string>) {
	const { screen, scope, id, page, lang, request } = again;
	const { city, visitorIp } = scope;
	const timetable = () => getScheduleEdition(city, visitorIp);
	switch (screen) {
		case 'overview':
			return readOverviewRecord(scope, timetable, only);
		case 'lines':
			return readLinesRecord(scope, only);
		case 'line':
			return loadLineRecord(
				{ from: scope.from, to: scope.to },
				city,
				id,
				lineDirection(page),
				visitorIp,
				false,
				only,
			);
		case 'stop':
			return loadStopRecord(scope, id, only);
		case 'vehicle':
			return readVehicleSections(scope, id, only);
		case 'departure': {
			const identity = departureFromKey(id);
			return {
				sections: identity
					? loadDepartureRecord(scope, identity, departureDay(page, scope), only)
					: [],
			};
		}
		case 'vehicles': {
			const fleet = readVehicleSections(scope, undefined, only).sections[0]?.answer;
			return { fleet: fleet?.then((result) => projectFleetAnswer(result, fleetView(page), lang)) };
		}
		case 'network':
			return loadNetworkRecord(scope, only);
		case 'alerts':
			return { sections: loadAlertRecord(scope, only) };
		case 'status':
			// Only a screen that tracks alerts has their reading to ask again.
			return readHealthRecord(scope, true, only);
		case 'stops': {
			if (!only.has('punctuality')) return {};
			const [provider, edition] = await Promise.all([publicCity(city, visitorIp), timetable()]);
			if (!provider || !edition) return {};
			const url = pinnedPage(again, '/stops');
			const { finderRecord } = projectStops(edition, url, request, city, provider, lang);
			return samePeriod(finderRecord?.period ?? null, scope) ? { ...finderRecord } : {};
		}
		case 'rankings': {
			const provider = await publicCity(city, visitorIp);
			if (!provider) return {};
			const record = await loadRankingsRecord(
				rankingPath,
				{
					url: pinnedPage(again, rankingPath),
					request,
					locals: { rankingsSchedule: only.has('answer') ? await timetable() : undefined },
					parent: async () => ({ providerId: city, provider }),
				},
				only,
			);
			return samePeriod(record.period, scope) ? record : {};
		}
		case 'receipt': {
			const edition = only.has('messages') || only.has('stops') ? await timetable() : null;
			const lineNumbers = new Map(edition?.routes.map(({ id, short }) => [id, short || id]));
			const { sections } = loadDailyRecord(
				scope,
				true,
				lang,
				(line) => lineNumbers.get(line) ?? line,
				only,
			);
			const stops = sections.find(({ section }) => section === 'stops')?.answer;
			return { sections, directory: dailyDirectory(stops, async () => edition) };
		}
	}
}
