export function departureDailyEngine(url) {
	const get = (name) => url.searchParams.get(name);
	const from = get('from');
	const to = get('to');
	const measure = get('measure');
	const kind = get('kind');
	const group = get('group');
	const departure = get('departure');
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
	const timing = { classified: 100, on_time: 80, late: 20 };
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
	if (get('format') === 'csv') {
		const heading = get('lang') === 'fr' ? 'Mesure,Du,Au' : 'Measure,From,To';
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
						rank: 1,
						range: { lower: 0.7, upper: 0.9, method: 'wilson_95' },
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
				cells: [
					cell(
						{ day: from },
						measure === 'late'
							? { classified: 10, late: 1 }
							: { eligible: 1, cancelled: 1, missing: 0 },
					),
					cell(
						{ day: to },
						measure === 'late'
							? { classified: 2, late: 0 }
							: { eligible: 1, cancelled: 0, missing: 1 },
					),
				],
			},
		};
	if (group === 'hour')
		return {
			body: {
				...envelope,
				cells: [
					cell({ hour: 0 }, { classified: 20, late: 10 }),
					cell({ hour: 19 }, { classified: 80, late: 10 }),
				],
			},
		};
	if (measure === 'trips_run') {
		const trip_ids = departure && get('line') === '80' ? ['T1'] : [];
		return result(cell(null, service, { trips_run: 60 / 65 }, { trip_ids }));
	}
	if (measure === 'alert_counts') {
		if (from === '2026-11-17')
			return {
				hold: true,
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
	return result(cell(null, timing, { on_time: 0.8, median_delay: 60, p90_delay: 360 }));
}
