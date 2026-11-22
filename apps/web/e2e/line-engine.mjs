// Engine contract fixtures for the server-side Line requests.
export function lineEngine(url) {
	const get = (key) => url.searchParams.get(key);
	const group = get('group');
	const measure = get('measure');
	const from = get('from');
	const to = get('to');
	const direction = get('direction') === '1' ? 1 : 0;
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
	const counts = { early: 10, on_time: sampled, late: 90 - sampled, classified: 100 };
	const cell = (key, value = values, sample = { counts }) => ({
		key,
		value,
		state: 'measured',
		state_text: { en: 'Measured', fr: 'Mesuré' },
		evidence: { ...sample, days_included: [from] },
	});

	if (get('format') === 'csv') {
		const fr = get('lang') === 'fr';
		return { csv: fr ? 'Mesure,Valeur\npunctuality,0.8\n' : 'Measure,Value\npunctuality,0.8\n' };
	}
	if (url.pathname === '/ranking') {
		return {
			body: {
				measure,
				kind: 'departure',
				class: null,
				coverage_note,
				evidence,
				info: [{ minimum_sample: 30 }],
				excluded: [],
				rows: [
					{
						id: 'departure',
						departure: '07:00:00',
						direction,
						rank: 1,
						value: values.late,
						sample: 100,
						counts,
						range: { lower: 0, upper: 1, method: 'wilson_95' },
					},
				],
			},
		};
	}
	if (group) {
		const cells = {
			day: [cell({ day: from })],
			weekday_hour: [cell({ weekday: 1, hour: 7 })],
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
					{ counts: { cancelled: 2, missing: 6, scheduled: 40 } },
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
			hold: from === '2026-11-09' && group === 'stop',
			body: { cells, coverage_note, evidence },
		};
	}

	let row = cell(null);
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
				periods: [
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
				],
			},
		);
	}
	return { body: { ...row, coverage_note, evidence: { ...evidence, ...row.evidence } } };
}
