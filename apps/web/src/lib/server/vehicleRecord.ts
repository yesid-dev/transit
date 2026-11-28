import { frameClock, type FrameClock, parseAnswerFrameState } from '#lib/site/frameState.ts';
import {
	getRecordAnswer,
	getVehicleDayAnswers,
	type EnginePeriod,
	type RecordQuery,
} from './engine.ts';
import { invalidRecordCsv, missingRecordCsv, recordCsvResponse } from './recordCsv.ts';
import { validEntityId, vehicleIdentity } from './entityIdentity.ts';
import { fetchCaptureSnapshot } from '#lib/live/captureSnapshot.ts';
import { fleetQuestion } from './screenQuestions.ts';

const queries = {
	fleet: fleetQuestion,
	service: { measure: 'vehicles' },
	lines: { measure: 'vehicle_trips_run', group: 'line' },
	reporting: { measure: 'vehicle_reporting_gaps_per_100_hours' },
	completion: { measure: 'vehicle_unfinished_trips' },
	punctuality: { measure: 'vehicle_on_time' },
} as const;

export type VehicleSection = keyof typeof queries;

function recordQuery(section: VehicleSection, id?: string): RecordQuery {
	return { path: '/measure', parameters: { ...queries[section], ...(id ? { vehicle: id } : {}) } };
}

export function readVehicleSections(scope: EnginePeriod, id?: string, only?: ReadonlySet<string>) {
	// Unfinished trips are not tracked for any vehicle: the page says so once, under About these
	// figures, and its CSV section stays available by address.
	const sections: VehicleSection[] = id
		? ['service', 'lines', 'reporting', 'punctuality']
		: ['fleet'];
	const include = (section: string) => !only || only.has(section);
	const bundled =
		id && include('service') && include('days') ? getVehicleDayAnswers(id, scope) : null;
	return {
		sections: sections.filter(include).map((section) => ({
			section,
			answer:
				section === 'service' && bundled
					? bundled.service
					: getRecordAnswer(recordQuery(section, id), scope),
		})),
		days:
			id && include('days')
				? (bundled?.days ??
					getRecordAnswer(
						{
							path: '/measure',
							parameters: { ...recordQuery('service', id).parameters, group: 'day' },
						},
						scope,
					))
				: null,
	};
}

/** When a vehicle was last in service on the chosen dates, and its busiest line that day. */
export type VehicleLastSeen =
	| { kind: 'seen'; day: string; line: string | null }
	| { kind: 'absent'; from: string; to: string }
	| { kind: 'unavailable' };

export async function readVehicleLastSeen(
	scope: EnginePeriod,
	id: string,
): Promise<VehicleLastSeen> {
	const days = await getRecordAnswer(
		{ path: '/measure', parameters: { measure: 'vehicles', vehicle: id, group: 'day' } },
		scope,
	);
	if (days.kind !== 'answer' || !('cells' in days.answer)) return { kind: 'unavailable' };
	const measured = days.answer.cells.filter(({ state }) => state === 'measured');
	const day = measured
		.flatMap(({ key, value }) =>
			typeof key.day === 'string' && (value.vehicle_days_in_service ?? 0) > 0 ? [key.day] : [],
		)
		.sort()
		.at(-1);
	if (!day)
		return measured.length || days.answer.evidence.days_measured?.length
			? { kind: 'absent', from: scope.from, to: scope.to }
			: { kind: 'unavailable' };
	const lines = await getRecordAnswer(recordQuery('lines', id), { ...scope, from: day, to: day });
	let line: string | null = null;
	let most = 0;
	if (lines.kind === 'answer' && 'cells' in lines.answer)
		for (const { key, state, value } of lines.answer.cells) {
			const trips = state === 'measured' ? (value.vehicle_trips_run ?? 0) : 0;
			if (typeof key.line === 'string' && trips > most) [line, most] = [key.line, trips];
		}
	return { kind: 'seen', day, line };
}

export function loadVehiclePage(
	url: URL,
	request: Request,
	city: string,
	clock: FrameClock,
	id?: string,
) {
	const { mode, period } = parseAnswerFrameState(url.searchParams, clock);
	const scope = period && {
		...period,
		city,
		visitorIp: request.headers.get('cf-connecting-ip'),
	};
	return {
		mode,
		period,
		city,
		id,
		...(mode === 'record' && scope ? readVehicleSections(scope, id) : { sections: [], days: null }),
		lastSeen: mode === 'live' && scope && id ? readVehicleLastSeen(scope, id) : null,
	};
}

export function vehicleCsv(
	url: URL,
	request: Request,
	language?: string,
	id?: string,
	fetcher?: typeof fetch,
) {
	const section = url.searchParams.get('section') ?? '';
	const lang = language === 'fr' ? 'fr' : 'en';
	if (id !== undefined && !validEntityId(id)) return missingRecordCsv(lang, 'VEHICLE_NOT_FOUND');
	if (!Object.hasOwn(queries, section) || (section === 'fleet') === Boolean(id))
		return invalidRecordCsv(lang);
	return recordCsvResponse(
		recordQuery(section as VehicleSection, id),
		url,
		request,
		lang,
		id ? `vehicle-${id}-${section}.csv` : `vehicles-${section}.csv`,
		id
			? {
					identity: {
						code: 'VEHICLE_NOT_FOUND',
						check: (provider, scope) =>
							vehicleIdentity(
								id,
								frameClock(provider),
								scope,
								provider.inputs.vehicle_positions,
								() => fetchCaptureSnapshot(scope.city, request.signal, fetcher),
								request.signal,
							),
					},
				}
			: undefined,
	);
}
