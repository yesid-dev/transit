// Contract fixtures for the Worker-side engine fetches. Fixed dates keep the page
// independent of the browser clock and distinguish its previous period.
export function overviewEngine(url) {
	const from = url.searchParams.get('from');
	const to = url.searchParams.get('to');
	const city = url.searchParams.get('city');
	const measure = url.searchParams.get('measure');
	const kind = url.searchParams.get('kind');
	const measured = ['2026-11-01', '2026-11-08', '2026-11-09'].includes(from);
	const days = measured
		? Array.from({ length: (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 }, (_, i) =>
				new Date(Date.parse(from) + i * 86_400_000).toISOString().slice(0, 10),
			)
		: [];
	const evidence = {
		city,
		start_date: from,
		end_date: to,
		days_measured: days,
		days_included: days,
		days_not_measured: measured ? [] : [from],
		method_version: measure === 'trips_run' ? 'service-delivered-v1' : 'punctuality-v2',
		cleaning_versions: measured ? [6] : [],
		query_ms: 7,
	};
	const coverage_note = null;

	if (url.pathname === '/ranking') {
		const rows = measured
			? [0.4, 0.45, 0.5].map((value, index) => ({
					id: `${kind === 'line' ? 'L' : 'S'}${index + 1}`,
					rank: index + 1,
					value,
					sample: 100,
					share_observed: 0.5,
					counts: { scheduled: 200, classified: 100, vehicle_stopped: 50, trip_update_passed: 50 },
					ranking_bound: value + 0.1,
					range: { lower: value - 0.1, upper: value + 0.1, method: 'wilson_95' },
				}))
			: [];
		return {
			hold: kind === 'stop' && from === '2026-11-09' ? 'overview-stop-ranking' : false,
			body: {
				measure,
				kind,
				class: kind === 'line' ? '3:frequent' : null,
				rows,
				excluded: [],
				coverage_note,
				info: [{ minimum_sample: 30 }],
				evidence,
			},
		};
	}

	const onTime = from === '2026-11-01' ? 400000 : city === 'octranspo' ? 355460 : 412355;
	const trips = measure === 'trips_run';
	const counts = trips
		? { ran: 90, eligible: 100, scheduled: 111 }
		: {
				on_time: onTime,
				early: 50780,
				late: 457020 - onTime,
				classified: 507800,
				scheduled: 1100000,
				vehicle_stopped: 200000,
				trip_update_passed: 307800,
			};
	return {
		hold: false,
		body: {
			measure,
			value:
				measure === 'punctuality'
					? {
							on_time: measured ? onTime / 507800 : null,
							early: measured ? 0.1 : null,
							late: measured ? (457020 - onTime) / 507800 : null,
						}
					: { [measure]: measured ? (trips ? 0.9 : onTime / 507800) : null },
			state: measured ? 'measured' : 'not_measured',
			state_text: measured
				? { en: 'Measured', fr: 'Mesuré' }
				: { en: 'Not measured', fr: 'Non mesuré' },
			coverage_note,
			evidence: {
				...evidence,
				counts,
				excluded: {},
				...(trips
					? { share_eligible: 100 / 111 }
					: { share_observed: 507800 / 1100000, low_coverage: true }),
			},
		},
	};
}
