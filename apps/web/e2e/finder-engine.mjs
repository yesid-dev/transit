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

export const stopsFixture = (city) => {
	const names = city === 'octranspo' ? ottawaNames : montrealNames;
	return names.map((name, index) => ({
		id: `finder-stop-${index + 1}`,
		code: String(52840 + index),
		name:
			city === 'octranspo' && index === 0
				? '8TH Line / Byron'
				: `${city === 'octranspo' ? 'Bank' : 'Beaubien'} / ${name}`,
		lat: city === 'octranspo' ? 45.42 : 45.53,
		lon: city === 'octranspo' ? -75.7 : -73.6,
		routes: city === 'octranspo' && index === 0 ? ['105', '51A', '51', '51'] : ['24'],
	}));
};

export function finderEngine(url) {
	const from = url.searchParams.get('from');
	const to = url.searchParams.get('to');
	const group = url.searchParams.get('group');
	const measure = url.searchParams.get('measure');
	const trips = measure === 'trips_run';
	const rich = from === '2026-11-04';
	const richLines = rich && group === 'line';
	const richStops = rich && group === 'stop_id';
	const days =
		richLines || richStops
			? Array.from({ length: (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 }, (_, i) =>
					new Date(Date.parse(from) + i * 86_400_000).toISOString().slice(0, 10),
				)
			: [from];
	if (group === 'line' && from === '2026-11-05') return { status: 502, body: {} };
	if (group === 'stop_id' && from === '2026-11-05') return { status: 502, body: {} };
	if (from === '2026-11-06') {
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
						onTime(
							process.env.TRANSIT_E2E_LINE_RECORD_NAMED === '1' &&
								url.searchParams.get('city') === 'stm'
								? '51'
								: '80',
							0.65,
						),
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
			cells: richStops
				? [
						...stopsFixture(url.searchParams.get('city')).map(({ id, name }, i) =>
							name === '8TH Line / Byron'
								? cell(
										{ stop: id },
										{ on_time: null },
										{ classified: 29, scheduled: 42 },
										'too_few_to_judge',
									)
								: cell(
										{ stop: id },
										{ on_time: (780 + 4 * i) / 1000 },
										{ classified: 2456 + i, scheduled: 2972 + i, on_time: 1900 + i },
									),
						),
						cell(
							{ stop: '57430' },
							{ on_time: 0.81 },
							{ classified: 210, scheduled: 275, on_time: 170 },
						),
					]
				: richLines
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
				days_included: days,
				days_measured: days,
				days_not_measured: [],
				method_version: `finder-${trips ? 'delivery' : 'timing'}-v${richLines ? 3 : 1}`,
				cleaning_versions: [richLines ? 12 : 8],
				query_ms: 4,
			},
		},
	};
}
