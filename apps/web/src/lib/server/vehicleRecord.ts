import { error } from '@sveltejs/kit';
import { frameToday, parseFrameState } from '#lib/site/frameState.ts';
import { getRecordAnswer, type RecordQuery } from './engine.ts';
import { recordCsvResponse } from './recordCsv.ts';

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

export function loadVehiclePage(
	url: URL,
	request: Request,
	city: string,
	now = new Date(),
	id?: string,
	timeZone?: string,
) {
	const { mode, period } = parseFrameState(url.searchParams, frameToday(timeZone, now));
	const sections: VehicleSection[] = id
		? ['service', 'lines', 'reporting', 'completion', 'punctuality']
		: ['fleet'];
	return {
		mode,
		period,
		city,
		id,
		sections:
			mode === 'record' && period
				? sections.map((section) => ({
						section,
						answer: getRecordAnswer(recordQuery(section, id), {
							...period,
							city,
							visitorIp: request.headers.get('cf-connecting-ip'),
						}),
					}))
				: [],
	};
}

export function vehicleCsv(url: URL, request: Request, lang?: string, id?: string) {
	const section = url.searchParams.get('section') ?? '';
	if (!Object.hasOwn(queries, section) || (section === 'fleet') === Boolean(id)) error(400);
	return recordCsvResponse(
		recordQuery(section as VehicleSection, id),
		url,
		request,
		lang === 'fr' ? 'fr' : 'en',
		`vehicles-${section}.csv`,
	);
}
