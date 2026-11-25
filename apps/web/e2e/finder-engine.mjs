const montrealNames = [
	'Beaubien',
	'Papineau',
	'Édouard-Montpetit',
	'Saint-Laurent',
	'Saint-Michel',
	'Gouin',
	'Avenue du Parc',
	'Avenue du Mont-Royal',
	'Sherbrooke',
	'Sauvé / Côte-Vertu',
	'Pie-IX',
	'Jean-Talon Est',
	'Van Horne',
	'Côte-des-Neiges',
	'Rosemont',
	'Bord-du-Lac',
	'Express Saint-Joseph',
	'Express Pierrefonds',
	'YUL Aéroport / Centre-ville',
	'Waller <> Elmvale',
	'Baseline',
	'Carling',
	'Rideau',
	'Billings Bridge',
	'Vanier',
];
const ottawaNames = [
	'Waller <> Elmvale',
	'Baseline',
	'Carling',
	'Rideau',
	'Billings Bridge',
	'Vanier',
	'Hurdman',
	'St-Laurent',
	'South Keys',
	'Greenboro',
	'Mooney’s Bay',
	'Walkley',
	'Heron',
	'Elmvale',
	'Tunney’s Pasture',
	'Westboro',
	'Lincoln Fields',
	'Bayshore',
	'Pinecrest',
	'Iris',
	'Queensway',
	'Lees',
	'Blair',
	'Orléans',
	'Kanata',
];

export const linesFixtureRoutes = (city) =>
	(city === 'octranspo' ? ottawaNames : montrealNames).map((long, index) => {
		const id = String(300 + index);
		return { id, short: id, long, type: 3 };
	});

export function finderEngine(url) {
	const from = url.searchParams.get('from');
	const to = url.searchParams.get('to');
	const group = url.searchParams.get('group');
	const measure = url.searchParams.get('measure');
	const trips = measure === 'trips_run';
	const rich = from === '2026-11-04';
	if (group === 'line' && from === '2026-11-05') return { status: 502, body: {} };
	if (group === 'line' && from === '2026-11-06') {
		return { status: 503, headers: { 'retry-after': '20' }, body: {} };
	}
	const cell = (key, value, counts, state = 'measured', en = 'Measured', fr = 'Mesuré') => ({
		key,
		value,
		state,
		state_text: { en, fr },
		evidence: {
			counts,
			...(counts.classified === 100
				? {
						counts: { ...counts, scheduled: 250, vehicle_stopped: 40, trip_update_passed: 60 },
						share_observed: 0.4,
						low_coverage: true,
					}
				: !trips && counts.classified != null && counts.scheduled
					? { share_observed: counts.classified / counts.scheduled }
					: trips
						? { share_eligible: 100 / 105 }
						: {}),
		},
	});
	const onTime = (line, value) =>
		cell(
			{ line },
			{ on_time: value },
			{
				on_time: value * 100,
				late: 95 - value * 100,
				classified: 100,
			},
		);
	const rows =
		group === 'stop_id'
			? [cell({ stop: 'S1' }, { on_time: 0.8 }, { on_time: 80, late: 15, classified: 100 })]
			: trips
				? [cell({ line: '24' }, { trips_run: 0.9 }, { ran: 90, eligible: 100, scheduled: 105 })]
				: [
						onTime('24', 0.8),
						onTime('80', 0.65),
						cell(
							{ line: '99' },
							{ on_time: null },
							{ classified: 3 },
							'too_few_to_judge',
							'Too few to judge',
							'Trop peu pour juger',
						),
					];
	return {
		hold: from === '2026-11-09' && trips,
		body: {
			cells:
				rich && group === 'line'
					? [
							...linesFixtureRoutes(url.searchParams.get('city')).map(({ id }, index) => {
								const onTime = (732 + Math.round((index * 115) / 24)) / 1000;
								return trips
									? cell(
											{ line: id },
											{ trips_run: 0.97 },
											{ ran: 1197 + index, scheduled: 1234 + index },
										)
									: cell(
											{ line: id },
											{ on_time: onTime },
											{
												on_time: onTime * 10000,
												late: (190 - index * 2) * 10,
												classified: 10000,
												scheduled: 12500,
												vehicle_stopped: 7140,
												trip_update_passed: 2860,
											},
										);
							}),
							...(trips
								? []
								: [
										cell(
											{ line: '99' },
											{ on_time: null },
											{ classified: 394 },
											'too_few_to_judge',
											'Too few to judge',
											'Trop peu pour juger',
										),
										cell(
											{ line: '715' },
											{ on_time: null },
											{},
											'not_measured',
											'The feed carried this line without trip identifiers on these dates.',
											'Le flux contenait cette ligne sans identifiants de trajet pour ces dates.',
										),
										cell({ line: '716' }, { on_time: null }, {}, 'unknown', 'Unknown', 'Inconnu'),
									]),
						]
					: rows,
			info: [{ id: trips ? 'trips_run' : 'on_time', minimum_sample: 500 }],
			coverage_note: null,
			evidence: {
				start_date: from,
				end_date: to,
				days_included: [from],
				days_measured: [from],
				days_not_measured: [],
				method_version: trips ? 'finder-delivery-v1' : 'finder-timing-v1',
				cleaning_versions: [8],
				query_ms: 4,
			},
		},
	};
}
