export function vehicleEngine(url) {
	const get = (key) => url.searchParams.get(key);
	const measure = get('measure');
	const group = get('group');
	const vehicle = get('vehicle');
	const from = get('from');
	const to = get('to');
	if (from === '2026-11-21') return { status: 503, body: {} };
	const fr = get('lang') === 'fr';
	if (get('format') === 'csv') {
		if (measure === 'vehicle_unfinished_trips')
			return {
				csv: `${fr ? 'Mesure,État' : 'Measure,State'}\n${measure},${fr ? 'Non suivi' : 'Not tracked'}\n`,
			};
		return { csv: `${fr ? 'Mesure,Valeur' : 'Measure,Value'}\n${measure},12\n` };
	}

	const states = {
		measured: { en: 'Measured', fr: 'Mesuré' },
		not_tracked: { en: 'Not tracked', fr: 'Non suivi' },
		not_measured: { en: 'Not measured', fr: 'Non mesuré' },
		too_few_to_judge: { en: 'Too few to judge', fr: 'Trop peu pour juger' },
		unknown: { en: 'Unknown', fr: 'Inconnu' },
	};
	const evidence = {
		start_date: from,
		end_date: to,
		days_measured: [from],
		days_included: [from],
		days_not_measured: [],
		method_version: 'vehicles-fixture-v1',
		cleaning_versions: [8],
		query_ms: 4,
	};
	const cell = (value, counts = {}, state = 'measured') => ({
		value,
		state,
		state_text: states[state],
		evidence: { counts, days_included: [from] },
	});
	const envelope = { evidence, coverage_note: null, info: [{ id: measure, minimum_sample: 30 }] };
	const noReport = vehicle === '1';
	const service = cell(
		{
			vehicle_days_in_service: noReport ? 0 : 5,
			vehicle_hours_in_service: noReport ? 0 : 12.5,
			vehicle_lines_run: noReport ? 0 : 2,
			vehicle_trips_run: noReport ? 0 : 22,
		},
		{},
		from === '2026-11-10' ? 'not_tracked' : 'measured',
	);
	if (group === 'vehicle') {
		const supported = from !== '2026-11-10';
		const state = supported ? 'measured' : 'not_tracked';
		return {
			body: {
				...envelope,
				state,
				state_text: states[state],
				cells: supported
					? [
							{ key: { vehicle: '40061' }, ...cell({ vehicle_days_in_service: 5 }) },
							{ key: { vehicle: '40062' }, ...cell({ vehicle_days_in_service: 3 }) },
						]
					: [],
			},
		};
	}
	if (!vehicle) return { status: 400, body: { message: 'Vehicle cut required' } };
	if (group === 'day') {
		const cells = [];
		for (let ms = Date.parse(from), index = 0; ms <= Date.parse(to); ms += 86_400_000, index++) {
			const day = new Date(ms).toISOString().slice(0, 10);
			const active = !noReport && index < 5;
			cells.push({
				key: { day },
				...cell({
					vehicle_days_in_service: active ? 1 : 0,
					vehicle_hours_in_service: active ? 2.5 : 0,
				}),
			});
		}
		return { body: { ...envelope, cells } };
	}
	if (group === 'line') {
		return {
			hold: from === '2026-11-09',
			body: {
				...envelope,
				cells: [
					{ key: { line: '80' }, ...cell({ vehicle_trips_run: 12 }) },
					{ key: { line: '24' }, ...cell({ vehicle_trips_run: 10 }) },
				],
			},
		};
	}
	const row = {
		vehicles: service,
		vehicle_reporting_gaps_per_100_hours: cell(
			{ vehicle_reporting_gaps_per_100_hours: 16 },
			{ reporting_gaps: 2, hours_in_service: 12.5 },
		),
		vehicle_unfinished_trips: {
			...cell({ vehicle_unfinished_trips: null }, { completion_sample: 20 }, 'not_tracked'),
			evidence: {
				counts: { completion_sample: 20, completion_confirmed_upstream_reassignments: 0 },
				days_included: [],
				days_not_tracked_reasons: { [from]: 'trip_end_not_observable' },
			},
		},
		vehicle_on_time: cell(
			{ vehicle_on_time: null },
			{ punctuality_classified: 12 },
			'too_few_to_judge',
		),
	}[measure];
	if (!row) return { status: 400, body: { message: 'Wrong measure' } };
	return { body: { ...envelope, ...row, evidence: { ...evidence, ...row.evidence } } };
}
