const dates = { days_not_measured: [], source_date: '2026-11-21' };

export function recordLayerEngine(url) {
	const params = url.searchParams;
	const measure = params.get('measure');
	const clearRun = measure === 'clear_run_time_lost' && params.get('group') === 'segment';
	const waits = measure === 'excess_wait_time' && params.get('group') === 'line_stop';
	if (params.get('view') !== 'map' || (!clearRun && !waits)) return null;
	const rows = clearRun
		? [
				['24', 0, 'K1-A', 'K1-B', 42, 54, 96],
				['51', 0, 'K1-B', 'K1-C', 96, 80, 176],
				['24', 0, 'K1-C', 'K1-D', null, null, null],
				['24', 1, 'K1-B', 'K1-A', 17, 59, 76],
			]
		: [
				['24', 0, 'K1-A', null, -8],
				['51', 0, 'K1-A', null, 42],
				['24', 0, 'K1-B', null, 89],
				['51', 0, 'K1-C', null, null],
				['24', 1, 'K1-D', null, 16],
			];
	const lines = params.has('lines') ? JSON.parse(params.get('lines')) : null;
	const eligible = rows.filter(
		([line, direction]) =>
			(!lines || lines.includes(line)) &&
			(!params.has('line') || params.get('line') === line) &&
			(!params.has('direction') || params.get('direction') === String(direction)) &&
			(!params.has('route_type') || params.get('route_type') === '3') &&
			(!params.has('hour_from') ||
				(params.get('hour_from') === '22' && params.get('hour_to') === '6')),
	);
	return {
		body: {
			measure,
			minimum_sample: 20,
			line: eligible.map(([line]) => line),
			direction: eligible.map(([, direction]) => direction),
			value: eligible.map((row) => row[4]),
			state: eligible.map((row) =>
				row[4] !== null ? 'measured' : clearRun ? 'too_few_to_judge' : 'no_frequent_periods',
			),
			sample: eligible.map((row) => (row[4] === null ? 4 : 53)),
			low_coverage: eligible.map(() => false),
			...(clearRun
				? {
						from_stop: eligible.map((row) => row[2]),
						to_stop: eligible.map((row) => row[3]),
						clear_run_seconds: eligible.map((row) => row[5]),
						median_run_seconds: eligible.map((row) => row[6]),
					}
				: { stop: eligible.map((row) => row[2]) }),
			evidence: dates,
		},
	};
}
