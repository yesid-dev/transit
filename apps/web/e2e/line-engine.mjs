import { waitingEngine } from './waiting-engine.mjs';
import {
	lineRecordFixture,
	namedLineCells,
	namedSchedulePeriods,
} from './line-record-fixtures.mjs';

const requestedRecoveryLines = new Set();

// Engine contract fixtures for the server-side Line requests.
export function lineEngine(url) {
	const get = (key) => url.searchParams.get(key);
	const group = get('group');
	const measure = get('measure');
	const from = get('from');
	const to = get('to');
	const direction = get('direction') === '1' ? 1 : 0;
	const line = get('line');
	const recovery = line?.startsWith('recovery-');
	if (recovery && measure === 'crowding' && !requestedRecoveryLines.has(line)) {
		requestedRecoveryLines.add(line);
		return { status: 503, body: {}, headers: { 'retry-after': '1' } };
	}
	const named =
		process.env.TRANSIT_E2E_LINE_RECORD_NAMED === '1' ? lineRecordFixture(get('city'), line) : null;
	if (named && from === '2026-11-01') return { status: 503, body: {} };
	const evidence = {
		start_date: from,
		end_date: to,
		days_measured: [from],
		days_included: [from],
		days_not_measured: [],
		method_version: 'line-fixture-v1',
		cleaning_versions: [7],
		query_ms: 4,
	};
	const coverage_note = null;
	const sampled = direction === 1 ? 40 : 80;
	const values = {
		early: 0.1,
		on_time: sampled / 100,
		late: (90 - sampled) / 100,
		median_delay: 37.5,
	};
	const counts = {
		early: 10,
		on_time: sampled,
		late: 90 - sampled,
		classified: 100,
		scheduled: 200,
		vehicle_stopped: 50,
		trip_update_passed: 50,
	};
	const cell = (key, value = values, sample = { counts, share_observed: 0.5 }) => ({
		key,
		value,
		state: 'measured',
		state_text: { en: 'Measured', fr: 'Mesuré' },
		evidence: { ...sample, days_included: [from] },
	});
	if (measure === 'on_time' && group === 'line') {
		return {
			body: {
				cells: line === 'unknown-entity' ? [] : [cell({ line })],
				evidence,
				coverage_note,
			},
		};
	}
	const schedulePeriods = named
		? namedSchedulePeriods(line)
		: [
				{
					period_text: { en: 'Morning peak', fr: 'Pointe du matin' },
					start_hour: 7,
					end_hour: 9,
					day_type: 'weekday',
					days: 1,
					scheduled_trips: 16,
					scheduled_clock_hours: 2,
					scheduled_frequency: 8,
				},
				{
					period_text: { en: 'Midday', fr: 'Milieu de journée' },
					start_hour: 9,
					end_hour: 15,
					day_type: 'saturday',
					days: 1,
					scheduled_trips: 24,
					scheduled_clock_hours: 6,
					scheduled_frequency: 4,
				},
			];

	if (get('format') === 'csv') {
		const fr = get('lang') === 'fr';
		return { csv: fr ? 'Mesure,Valeur\npunctuality,0.8\n' : 'Measure,Value\npunctuality,0.8\n' };
	}
	if (url.pathname === '/ranking') {
		const observedDates = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
		const departure = { id: 'departure', departure: '07:00:00', direction, sample: 100 };
		const rankingFloors = { observed_service_dates: 5, classified: 30 };
		const ranked = observedDates >= rankingFloors.observed_service_dates;
		const lower = direction === 1 ? 0.404 : 0.055;
		return {
			body: {
				measure,
				kind: 'departure',
				class: null,
				coverage_note,
				evidence,
				info: [{ minimum_sample: 30, ranking_floors: { departure: rankingFloors } }],
				excluded: ranked
					? []
					: [
							{
								...departure,
								reason: 'too_few_to_judge',
								reason_text: { en: 'Too few to judge', fr: 'Trop peu pour juger' },
							},
						],
				rows: ranked
					? [
							{
								...departure,
								rank: 1,
								value: values.late,
								counts: { ...counts, observed_service_dates: observedDates },
								share_observed: 0.5,
								ranking_bound: lower,
								range: { lower, upper: direction === 1 ? 0.596 : 0.174, method: 'wilson_95' },
							},
						]
					: [],
			},
		};
	}
	if (measure === 'waiting_and_gaps') {
		return waitingEngine(url, evidence);
	}
	if (group) {
		if (group === 'direction' && measure === 'scheduled_frequency') {
			const cells = [0, 1].map((direction) =>
				cell(
					{ direction },
					{},
					{
						counts: {},
						periods: schedulePeriods.map((period) => {
							const first = Math.round(period.scheduled_trips * 0.625);
							const scheduled_trips = direction === 0 ? first : period.scheduled_trips - first;
							return {
								...period,
								scheduled_trips,
								scheduled_frequency: scheduled_trips / period.scheduled_clock_hours,
							};
						}),
					},
				),
			);
			return { body: { cells, coverage_note, evidence } };
		}
		const cells =
			(named
				? namedLineCells(
						line,
						named,
						group,
						get('direction') == null ? null : direction,
						cell,
						from,
					)
				: undefined) ??
			{
				hour: [
					cell(
						{ hour: 7 },
						{ scheduled_frequency: 8 },
						{ counts: { scheduled_trips: 8, scheduled_clock_hours: 1 } },
					),
					cell(
						{ hour: 8 },
						{ scheduled_frequency: 0 },
						{ counts: { scheduled_trips: 0, scheduled_clock_hours: 1 } },
					),
				],
				day: [cell({ day: from })],
				weekday_hour: recovery
					? Array.from({ length: 24 }, (_, hour) => cell({ weekday: 1, hour }))
					: [cell({ weekday: 1, hour: 7 })],
				direction: [cell({ direction: 0 }), cell({ direction: 1 })],
				stop: [
					cell({ direction, stop_sequence: 1, stop: 'First stop' }),
					cell(
						{ direction, stop_sequence: 2, stop: 'Second stop' },
						{ ...values, median_delay: 337.5 },
					),
				],
				departure: [
					cell(
						{ direction, departure: '07:00:00' },
						{ trips_run: 0.8 },
						{ counts: { cancelled: 2, missing: 6, ran: 32, scheduled: 40 } },
					),
				],
				day_type: [
					cell(
						{ day_type: 'weekday' },
						{},
						{
							counts: {},
							boundary_departures: [
								{
									measure: 'first_trip',
									service_date: from,
									scheduled_departure: '05:44:00',
									scheduled: 1,
								},
								{
									measure: 'last_trip',
									service_date: from,
									scheduled_departure: '25:15:00',
									scheduled: 1,
								},
							],
						},
					),
				],
			}[group];
		return {
			hold:
				group === 'stop' &&
				((from === '2026-11-09' && 'line') ||
					(/^2026-10-1[5-8]$/u.test(from) && ['line', get('city'), from, to].join('-'))),
			body: {
				cells,
				coverage_note,
				evidence:
					group === 'day' && from !== to ? { ...evidence, days_not_measured: [to] } : evidence,
			},
		};
	}

	let row = cell(null);
	if (line === '715' && measure === 'punctuality') {
		return {
			body: {
				...cell(null, {}, { counts: {} }),
				state: 'not_measured',
				state_text: { en: 'Not measured', fr: 'Non mesuré' },
				coverage_note: {
					en: 'The feed carried this line without trip identifiers on these dates, so its vehicles cannot be matched to the timetable.',
					fr: 'Le flux de cette ligne ne contenait aucun identifiant de trajet à ces dates. Il est donc impossible d’associer ses véhicules à l’horaire.',
				},
				evidence: { ...evidence, counts: {} },
			},
		};
	}
	if (measure === 'crowding') {
		row =
			get('city') === 'octranspo'
				? {
						...cell(null, {}, { counts: {} }),
						state: 'not_tracked',
						state_text: { en: 'Not tracked', fr: 'Non suivi' },
					}
				: cell(
						null,
						{ crowding_full: 0.25 },
						{
							counts: { occupancy_vehicle_seconds: 7200.5 },
							percentage_levels: [{ percentage: 62, share: 0.75, vehicle_seconds: 5400.375 }],
						},
					);
	}
	if (measure === 'alert_counts') {
		row = cell(
			null,
			{ alerts: 3, alert_versions: 4 },
			{ counts: { alerts: 3, alert_versions: 4 } },
		);
	}
	if (measure === 'scheduled_frequency') {
		row = cell(
			null,
			{ scheduled_frequency: 8 },
			{
				counts: {},
				periods: schedulePeriods,
			},
		);
	}
	return { body: { ...row, coverage_note, evidence: { ...evidence, ...row.evidence } } };
}
