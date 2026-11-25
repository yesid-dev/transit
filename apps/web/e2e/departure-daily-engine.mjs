export const departureCaptureStops = [
	{ id: 'capture-A', name: 'Sherbrooke / Atwater', code: '51543', delay: -61 },
	{ id: 'capture-B', name: 'Sherbrooke / Guy', code: '51653', delay: 36 },
	{ id: 'capture-C', name: 'Sherbrooke / de la Montagne', code: '51705', delay: 97 },
	{ id: 'capture-D', name: 'Sherbrooke / Peel', code: '51735', delay: null },
	{ id: 'capture-E', name: 'Sherbrooke / Robert-Bourassa', code: '51824', delay: 245 },
	{ id: 'capture-F', name: 'Sherbrooke / Saint-Laurent', code: '51897', delay: 320 },
	{ id: 'capture-G', name: 'Station Sherbrooke', code: '51905', delay: 288 },
	{ id: 'capture-H', name: 'Sherbrooke / Saint-Hubert', code: '51926', delay: 302 },
];

export function departureDailyEngine(url, dailyMessageHold) {
	const get = (name) => url.searchParams.get(name);
	const from = get('from');
	const to = get('to');
	const measure = get('measure');
	const kind = get('kind');
	const group = get('group');
	const departure = get('departure');
	if (departure && from === '2026-11-21') return { status: 503, body: {} };
	if (
		departure &&
		(!['24', '80'].includes(get('line')) || get('direction') !== '0' || departure !== '07:00:00')
	) {
		return { status: 400, body: { message: 'Wrong departure cut' } };
	}
	const evidence = {
		start_date: from,
		end_date: to,
		days_measured: [from],
		days_included: [from],
		days_not_measured: [],
		method_version: 'daily-fixture-v1',
		cleaning_versions: [8],
		query_ms: 5,
	};
	const timing = {
		classified: 100,
		on_time: 80,
		late: 20,
		scheduled: 250,
		vehicle_stopped: 40,
		trip_update_passed: 60,
	};
	const timingCoverage = { share_observed: 0.4, low_coverage: true };
	const service = { scheduled: 70, eligible: 65, ran: 60, cancelled: 2, missing: 3 };
	const cell = (key, counts, value = {}, extra = {}) => ({
		key,
		value,
		state: 'measured',
		state_text: { en: 'Measured', fr: 'Mesuré' },
		evidence: { counts, days_included: [from], ...extra },
	});
	const envelope = { evidence, coverage_note: null, info: [{ minimum_sample: 30 }] };
	const result = (row) => ({
		body: { ...envelope, ...row, evidence: { ...evidence, ...row.evidence } },
	});
	const observedDelay = from === '2026-11-20' ? 320 : -61;
	if (get('format') === 'csv') {
		const heading = get('lang') === 'fr' ? 'Mesure,Du,Au' : 'Measure,From,To';
		if (group === 'stop' && get('departure')) {
			const column = get('lang') === 'fr' ? 'Retard observé (s)' : 'Observed delay (s)';
			return {
				csv: `${heading},${column}\n${measure},${from},${to},${observedDelay}\n`,
			};
		}
		return { csv: `${heading}\n${measure},${from},${to}\n` };
	}
	if (kind)
		return {
			body: {
				...envelope,
				kind,
				measure,
				class: get('class'),
				excluded: [],
				rows: [
					{
						id: kind === 'line' ? '24' : 'S1',
						value: 0.8,
						sample: 100,
						counts: timing,
						...timingCoverage,
						ranking_bound: 0.9,
						rank: 1,
						range: { lower: 0.7, upper: 0.9, method: 'wilson_95' },
					},
				],
			},
		};
	if (group === 'stop' && departure && process.env.TRANSIT_E2E_DEPARTURE_NAMED === '1') {
		return {
			body: {
				...envelope,
				cells: departureCaptureStops.map(({ id, delay }, index) => {
					const seconds = from === '2026-11-19' ? null : delay;
					const stop = cell(
						{ direction: 0, stop_sequence: index + 1, stop: id },
						{ classified: seconds == null ? 0 : 1, scheduled: 1 },
						{},
						{ observed_delay_seconds: seconds },
					);
					return seconds == null
						? {
								...stop,
								state: 'not_measured',
								state_text: { en: 'Not measured', fr: 'Non mesuré' },
							}
						: stop;
				}),
			},
		};
	}
	if (group === 'stop' && departure && from === '2026-11-19')
		return {
			body: {
				...envelope,
				cells: [
					{
						...cell(
							{ direction: 0, stop_sequence: 1, stop: 'S1' },
							{ classified: 0, scheduled: 1 },
						),
						state: 'not_measured',
						state_text: { en: 'Not measured', fr: 'Non mesuré' },
					},
				],
			},
		};
	if (group === 'stop')
		return {
			body: {
				...envelope,
				cells: [
					cell(
						{ direction: 0, stop_sequence: 1, stop: 'S1' },
						{ classified: 1 },
						{},
						{ observed_delay_seconds: from === '2026-11-20' ? 320 : -61 },
					),
				],
			},
		};
	if (group === 'day')
		return {
			body: {
				...envelope,
				cells: Array.from(
					{ length: (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 },
					(_, index) => {
						const day = new Date(Date.parse(from) + index * 86_400_000).toISOString().slice(0, 10);
						return {
							...cell(
								{ day },
								measure === 'late'
									? { classified: 20, late: index === 0 ? 1 : 0 }
									: { eligible: 1, cancelled: day === from ? 1 : 0, missing: day === to ? 1 : 0 },
							),
							state: 'too_few_to_judge',
							state_text: { en: 'Too few to judge', fr: 'Trop peu pour juger' },
						};
					},
				),
			},
		};
	if (group === 'hour')
		return {
			body: {
				...envelope,
				info: [{ minimum_sample: 30, minimum_coverage: 0.25, low_coverage_below: 0.5 }],
				cells: [
					cell({ hour: 0 }, { scheduled: 40, classified: 20, late: 10 }),
					cell({ hour: 19 }, { scheduled: 120, classified: 80, late: 10 }),
					{
						...cell({ hour: 8 }, { scheduled: 200, classified: 40, late: 10 }),
						state: 'not_measured',
						state_text: { en: 'Not measured', fr: 'Non mesuré' },
					},
				],
			},
		};
	if (measure === 'trips_run') {
		const trip_ids = departure && get('line') === '80' ? ['T1'] : [];
		return result(
			cell(null, service, { trips_run: 60 / 65 }, { trip_ids, share_eligible: 65 / 70 }),
		);
	}
	if (measure === 'alert_counts') {
		if (dailyMessageHold)
			return {
				hold: dailyMessageHold,
				...result({
					...cell(null, { alerts: null }),
					state: 'not_tracked',
					state_text: { en: 'Not tracked', fr: 'Non suivi' },
				}),
			};
		return result(
			cell(
				null,
				{ alerts: 1 },
				{ alerts: 1 },
				{
					alert_messages: [
						{
							source: 'feed',
							id: 'alert',
							version: '1',
							routes: ['24'],
							stops: [],
							header: { en: 'Detour on 24', fr: 'Détour sur la ligne 24' },
							description: { en: 'Work near the terminus.', fr: 'Travaux près du terminus.' },
						},
					],
				},
			),
		);
	}
	return result(
		cell(null, timing, { on_time: 0.8, median_delay: 60, p90_delay: 360 }, timingCoverage),
	);
}
