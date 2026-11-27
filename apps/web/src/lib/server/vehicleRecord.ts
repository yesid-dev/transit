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

const queries = {
	fleet: { measure: 'vehicle_days_in_service', group: 'vehicle' },
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
	const sections: VehicleSection[] = id
		? ['service', 'lines', 'reporting', 'completion', 'punctuality']
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
		`vehicles-${section}.csv`,
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
