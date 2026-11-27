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

export const dailyReportStops = [
	{ id: '52716', name: 'Express Saint-Joseph / Bélanger', code: '52716' },
	{ id: '55357', name: 'Saint-Michel / Iberville', code: '55357' },
	{ id: '54034', name: 'Sherbrooke / Langelier', code: '54034' },
];
export const dailyReportLines = [
	{ id: '121', short: '121', long: 'Sauvé / Côte-Vertu', type: 3 },
	{ id: '67', short: '67', long: 'Saint-Michel', type: 3 },
	{ id: '51', short: '51', long: 'Édouard-Montpetit', type: 3 },
];

export function departureDailyEngine(url, dailyMessageHold, richReport = false) {
	const get = (name) => url.searchParams.get(name);
	const from = get('from');
	const to = get('to');
	const measure = get('measure');
	const kind = get('kind');
	const group = get('group');
	const departure = get('departure');
	if (departure && from === '2026-11-22' && measure === 'late' && group === 'day')
		return { status: 503, body: {}, headers: { 'retry-after': '15' } };
	if (departure && from === '2026-11-21') return { status: 503, body: {} };
	const identityLookup = departure && measure === 'trips_run' && group === 'departure';
	if (
		departure &&
		!identityLookup &&
		(!['24', '80', 'archived-line'].includes(get('line')) ||
			get('direction') !== '0' ||
			departure !== '07:00:00')
	) {
		return { status: 400, body: { message: 'Wrong departure cut' } };
	}
	const days =
		richReport && from !== to
			? Array.from({ length: (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 }, (_, index) =>
					new Date(Date.parse(from) + index * 86_400_000).toISOString().slice(0, 10),
				)
			: [from];
	const scaleCounts = (counts) =>
		richReport && measure !== 'alert_counts'
			? Object.fromEntries(Object.entries(counts).map(([key, count]) => [key, count * days.length]))
			: counts;
	const evidence = {
		start_date: from,
		end_date: to,
		days_measured: days,
		days_included: days,
		days_not_measured: [],
		method_version: richReport ? 'punctuality-v3' : 'daily-fixture-v1',
		cleaning_versions: [richReport ? 12 : 8],
		query_ms: 5,
	};
	const timing = richReport
		? {
				classified: 609056,
				early: 35482,
				on_time: 480458,
				late: 93116,
				scheduled: 637088,
				vehicle_stopped: 435113,
				trip_update_passed: 173943,
			}
		: {
				classified: 100,
				on_time: 80,
				early: 0,
				late: 20,
				scheduled: 250,
				vehicle_stopped: 40,
				trip_update_passed: 60,
			};
	const timingCoverage = richReport
		? { share_observed: 0.956, low_coverage: false }
		: { share_observed: 0.4, low_coverage: true };
	const service = richReport
		? { scheduled: 17403, eligible: 17403, ran: 16924, cancelled: 151, missing: 328 }
		: { scheduled: 70, eligible: 65, ran: 60, cancelled: 2, missing: 3 };
	const cell = (key, counts, value = {}, extra = {}) => ({
		key,
		value,
		state: 'measured',
		state_text: { en: 'Measured', fr: 'Mesuré' },
		evidence: { counts: scaleCounts(counts), days_included: days, ...extra },
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
				rows: richReport
					? (kind === 'line' ? dailyReportLines : dailyReportStops).map(({ id }, index) => ({
							id,
							value: 0.684 + index * 0.008,
							sample: (263 + index * 100) * days.length,
							rank: index + 1,
							counts: scaleCounts({ classified: 263 + index * 100 }),
							range: { lower: 0.6, upper: 0.8, method: 'wilson_95' },
						}))
					: [
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
	if (identityLookup) {
		const known =
			['24', '80', 'archived-line'].includes(get('line')) &&
			get('direction') === '0' &&
			departure === '07:00:00';
		return {
			body: {
				...envelope,
				cells: known ? [cell({ direction: 0, departure }, { scheduled: 1 })] : [],
			},
		};
	}
	if (group === 'stop' && departure && from === '2026-11-15')
		return { body: { ...envelope, cells: [] } };
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
				...(departure && measure === 'late'
					? {
							evidence: {
								...evidence,
								days_included: Array.from(
									{ length: (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 },
									(_, i) => new Date(Date.parse(from) + i * 86_400_000).toISOString().slice(0, 10),
								),
							},
						}
					: {}),
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
				cells: richReport
					? [5, 7, 10, 15, 19].map((hour, index) => {
							const classified = [39294, 134761, 159348, 185078, 90575][index];
							const late = [4361, 26683, 24062, 25586, 12424][index];
							return cell({ hour }, { scheduled: Math.ceil(classified / 0.956), classified, late });
						})
					: [
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
			cell(
				null,
				service,
				{ trips_run: service.ran / service.eligible },
				{ trip_ids, share_eligible: service.eligible / service.scheduled },
			),
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
		if (richReport)
			return result(
				cell(
					null,
					{ alerts: 1690 },
					{ alerts: 1690 },
					{
						alert_messages: Array.from({ length: 6 }, (_, index) => ({
							source: 'feed',
							id: String(index + 1),
							version: '1',
							routes: [dailyReportLines[index % dailyReportLines.length].id],
							stops: [],
							header: {
								en: index % 2 ? 'Your stop' : 'Your line',
								fr: index % 2 ? 'Votre arrêt' : 'Votre ligne',
							},
							description: {
								en: null,
								fr:
									[
										'Le service est réduit sur Sauvé en raison de travaux.',
										'Les véhicules font un détour près de Saint-Michel.',
										'L’arrêt sur Édouard-Montpetit est temporairement déplacé.',
										'La ligne emprunte un itinéraire temporaire vers Côte-Vertu.',
										'Le passage à l’arrêt habituel est suspendu sur Saint-Michel.',
										'Les travaux se poursuivent près du terminus.',
									][index] +
									' Consultez l’avis de service pour connaître les arrêts accessibles et prévoir votre déplacement pendant les travaux de réaménagement.',
							},
							periods: [
								{
									start: from + (index === 0 ? 'T13:00:00Z' : 'T12:00:00Z'),
									end: to + 'T20:00:00Z',
								},
								{ start: to + 'T18:00:00Z', end: to + 'T23:00:00Z' },
							],
						})),
					},
				),
			);
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
		cell(
			null,
			timing,
			{
				early: timing.early / timing.classified,
				on_time: timing.on_time / timing.classified,
				late: timing.late / timing.classified,
				median_delay: 60,
				p90_delay: 360,
			},
			timingCoverage,
		),
	);
}
