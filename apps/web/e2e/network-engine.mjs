const enFr = (en, fr) => ({ en, fr });

export function networkServiceFixture(url) {
	const { searchParams: query } = url;
	if (['line', 'stop', 'departure', 'vehicle'].some((key) => query.has(key))) return null;
	const measure = query.get('measure');
	const group = query.get('group');
	if (
		!['crowding', 'service_delivered'].includes(measure) &&
		!['day_type', 'weekday_hour'].includes(group) &&
		!(
			['punctuality', 'on_time', 'delay_distribution'].includes(measure) &&
			(query.get('from') === '2026-11-20' || query.get('from') === '2026-10-19')
		)
	)
		return null;
	const from = query.get('from');
	const to = query.get('to');
	if (query.get('format') === 'csv') return { csv: `measure,from,to\n${measure},${from},${to}\n` };
	const days = Array.from(
		{ length: (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 },
		(_, i) => new Date(Date.parse(from) + i * 86_400_000).toISOString().slice(0, 10),
	);
	const counts = { classified: 55720, scheduled: 58338, early: 3120, on_time: 44966, late: 7634 };
	// Scheduled = no live data + status unknown + ran + cancelled + missing, as the engine answers.
	const delivery = { scheduled: 18515, eligible: 15861, ran: 15476, cancelled: 125, missing: 260 };
	const tripExclusions = { route_without_live_data: 1654, unconfirmed: 1000, capture_gap: 0 };
	const trips = (days_included) => ({
		...measured({ trips_run: delivery.ran / delivery.eligible }, delivery, days_included),
		evidence: { counts: delivery, excluded: tripExclusions, days_included },
	});
	const evidence = {
		start_date: from,
		end_date: to,
		days_measured: days,
		days_included: days,
		days_not_measured: [],
		method_version: '3',
		cleaning_versions: [12],
		query_ms: 6,
	};
	const measured = (value, counts, days_included = days) => ({
		state: 'measured',
		state_text: enFr('Measured', 'Mesuré'),
		value,
		evidence: { counts, days_included },
	});
	const share = 44966 / 55720;
	let result;
	if (measure === 'delay_distribution') {
		const bins = [
			[null, -181, 'early', 650],
			[-180, -121, 'early', 950],
			[-120, -61, 'early', 1520],
			[-60, -1, 'on_time', 9500],
			[0, 59, 'on_time', 14500],
			[60, 119, 'on_time', 10500],
			[120, 179, 'on_time', 6500],
			[180, 239, 'on_time', 3000],
			[240, 300, 'on_time', 966],
			[301, 359, 'late', 2800],
			[360, 419, 'late', 1600],
			[420, 479, 'late', 1050],
			[480, 539, 'late', 850],
			[540, null, 'late', 1334],
		];
		result = {
			...measured({}, counts),
			measure,
			group: 'delay_minute',
			cells: bins.map(([min_seconds, max_seconds, band, count]) => ({
				key: { min_seconds, max_seconds, band },
				...measured(
					{ delay_distribution: count / counts.classified, stop_events: count },
					{ stop_events: count },
				),
			})),
		};
	} else if (group === 'day_type') {
		result = {
			cells: [
				{ key: { day_type: 'weekday' }, ...measured({ on_time: share }, counts) },
				{
					key: { day_type: 'saturday' },
					...measured({ on_time: 0.84 }, { on_time: 16800, classified: 20000 }),
				},
				{
					key: { day_type: 'sunday' },
					...measured({ on_time: 0.86 }, { on_time: 17200, classified: 20000 }),
				},
			],
		};
	} else if (group === 'weekday_hour') {
		const fullDay = from === '2026-10-19';
		result = {
			cells: Array.from({ length: 7 }, (_, day) =>
				Array.from({ length: fullDay ? 24 : 20 }, (_, index) => {
					const hour = fullDay ? index : (index + 5) % 24;
					const late = 110 + ((day * 17 + index * 37) % 170);
					const key = { weekday: day + 1, hour };
					if (day === 0 && index === 0) {
						return {
							key,
							state: 'not_measured',
							state_text: enFr('Not measured', 'Non mesuré'),
							value: { late: null },
							evidence: { counts: { scheduled: 58 }, days_included: [] },
						};
					}
					if (fullDay && ((day === 0 && hour === 1) || (day === 2 && hour === 21))) {
						return {
							key,
							state: 'too_few_to_judge',
							state_text: enFr('Too few to judge', 'Trop peu pour juger'),
							value: { late: null },
							evidence: { counts: { classified: 12 }, days_included: days },
						};
					}
					if (fullDay && ((day === 0 && hour === 2) || (day === 4 && hour === 22))) {
						return {
							key,
							state: 'unknown',
							state_text: enFr('No service', 'Aucun service'),
							value: { late: null },
							evidence: { counts: { scheduled: 0 }, days_included: [] },
						};
					}
					return {
						key,
						...measured({ late: late / 1000 }, { classified: 1000, late }),
					};
				}),
			).flat(),
			info: [{ id: 'late', minimum_sample: 60 }],
		};
	} else if (group === 'day') {
		result = {
			cells: days.map((day, i) => ({
				key: { day },
				...(measure === 'service_delivered'
					? trips([day])
					: measured({ on_time: share + Math.sin(i * 1.3) * 0.025 }, counts, [day])),
			})),
		};
	} else if (measure === 'service_delivered') {
		result = trips(days);
	} else if (measure === 'crowding') {
		result = measured(
			{
				crowding_empty: 0.1,
				crowding_many_seats: 0.5,
				crowding_few_seats: 0.29,
				crowding_standing: 0.08,
				crowding_crushed: 0.02,
				crowding_full: 0.01,
			},
			{ readings: 2048 },
		);
	} else {
		result = measured(
			{
				on_time: share,
				early: counts.early / counts.classified,
				late: counts.late / counts.classified,
				median_delay: 72,
				p90_delay: 398,
			},
			counts,
		);
	}
	return {
		body: { ...result, coverage_note: null, evidence: { ...evidence, ...result.evidence } },
	};
}

export const networkFixtures = {
	poll_success: {
		value: { trip_updates: 0.8, vehicle_positions: null },
		dimensions: { trip_updates: 'measured', vehicle_positions: 'too_few_to_judge' },
		counts: {
			trip_updates: { attempts: 25, successful: 20 },
			vehicle_positions: { attempts: 3, successful: 2 },
		},
	},
	feed_age_at_capture: {
		value: { trip_updates: { median_seconds: 8, p90_seconds: 'over_10_minutes' } },
		dimensions: { trip_updates: 'measured' },
		counts: { trip_updates: { samples: 25 } },
	},
	feed_update_interval: {
		value: { trip_updates: { median_seconds: 24, p90_seconds: 43 } },
		dimensions: { trip_updates: 'measured' },
		counts: { trip_updates: { samples: 24 } },
	},
	live_trip_coverage: {
		value: 0.75,
		dimensions: {},
		counts: { appeared: 30, eligible: 40, never_seen: 10, scheduled: 50, never_seen_share: 0.2 },
	},
	vehicle_field_completeness: {
		value: { occupancy: null, position: 1 },
		dimensions: { occupancy: 'not_published', position: 'measured' },
		counts: { position: { present_us: 7200000000, reporting_us: 7200000000 } },
	},
	prediction_error: {
		value: {
			1: {
				sample_count: 40,
				median_signed_seconds: -5,
				p90_absolute_seconds: 60,
				within_60_seconds_share: 0.9,
			},
			3: {
				sample_count: 2,
				median_signed_seconds: null,
				p90_absolute_seconds: null,
				within_60_seconds_share: null,
			},
		},
		dimensions: { 1: 'measured', 3: 'too_few_to_judge' },
		counts: {},
	},
};

export function networkEngine(url) {
	const get = (name) => url.searchParams.get(name);
	const measure = get('measure');
	const { value, dimensions, counts } = networkFixtures[measure];
	const from = get('from');
	const to = get('to');
	if (get('group'))
		return { status: 400, body: { message: 'Scorecard measures do not support group' } };
	if (get('format') === 'csv') {
		const header = get('lang') === 'fr' ? 'Mesure,Valeur' : 'Measure,Value';
		return { csv: `${header}\n${measure},${from}\n` };
	}

	return {
		body: {
			measure,
			value: { [measure]: value },
			state: 'measured',
			state_text: enFr('Measured', 'Mesuré'),
			coverage_note: enFr(
				'Only measured days are included.',
				'Seuls les jours mesurés sont inclus.',
			),
			evidence: {
				start_date: from,
				end_date: to,
				days_measured: [from],
				days_included: [from],
				days_not_measured: from < to ? [to] : [],
				days_not_measured_reasons: from < to ? { [to]: 'no_raw_captures' } : {},
				method_version: '2',
				cleaning_versions: [9],
				query_ms: 4,
				counts: { [measure]: counts },
				dimension_states: { [measure]: dimensions },
				capture_gap_days: { [measure]: measure === 'live_trip_coverage' && from < to ? [to] : [] },
			},
			info: [{ id: measure, minimum_sample: measure === 'prediction_error' ? 30 : 20 }],
		},
	};
}

/** Wheelchair declarations: Montréal declares every stop and trip, Ottawa declares no stop. */
export function accessibilityEngine(url) {
	const from = url.searchParams.get('from');
	const to = url.searchParams.get('to');
	const ottawa = url.searchParams.get('city') === 'octranspo';
	const counts = ottawa
		? {
				trips_accessible: 540,
				trips_not_accessible: 0,
				trips_no_information: 1,
				trips_not_published: 0,
				stops_accessible: 0,
				stops_not_accessible: 0,
				stops_no_information: 120,
				stops_not_published: 0,
			}
		: {
				trips_accessible: 700,
				trips_not_accessible: 300,
				trips_no_information: 0,
				trips_not_published: 0,
				stops_accessible: 180,
				stops_not_accessible: 20,
				stops_no_information: 0,
				stops_not_published: 0,
			};
	return {
		body: {
			measure: 'accessible_trips',
			value: { accessible_trips: ottawa ? 540 / 541 : 0.7 },
			state: 'measured',
			state_text: enFr('Measured', 'Mesuré'),
			coverage_note: null,
			evidence: {
				start_date: from,
				end_date: to,
				days_measured: [from],
				days_included: [from],
				days_not_measured: [],
				method_version: 'accessibility-v2',
				cleaning_versions: [9],
				query_ms: 3,
				counts,
				excluded: {},
				measure_states: { accessible_trips: 'measured' },
			},
			info: [{ id: 'accessible_trips', minimum_sample: 1 }],
		},
	};
}
