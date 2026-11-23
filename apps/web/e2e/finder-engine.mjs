export function finderEngine(url) {
	const from = url.searchParams.get('from');
	const to = url.searchParams.get('to');
	const group = url.searchParams.get('group');
	const measure = url.searchParams.get('measure');
	const trips = measure === 'trips_run';
	const cell = (key, value, counts, state = 'measured', en = 'Measured', fr = 'Mesuré') => ({
		key,
		value,
		state,
		state_text: { en, fr },
		evidence: { counts },
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
				? [cell({ line: '24' }, { trips_run: 0.9 }, { ran: 90, scheduled: 105 })]
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
			cells: rows,
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
