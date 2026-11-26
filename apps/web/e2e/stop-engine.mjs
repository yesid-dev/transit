import { waitingEngine } from './waiting-engine.mjs';

export function stopEngine(url) {
	const get = (key) => url.searchParams.get(key);
	const from = get('from');
	const to = get('to');
	const days = Array.from(
		{ length: (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 },
		(_, index) => new Date(Date.parse(from) + index * 86_400_000).toISOString().slice(0, 10),
	);
	const group = get('group');
	const measure = get('measure');
	const evidence = {
		start_date: from,
		end_date: to,
		days_measured: days,
		days_included: days,
		days_not_measured: [],
		method_version: 'stop-fixture-v3',
		cleaning_versions: [12],
		query_ms: 4,
	};
	if (from === '2026-11-12') return { status: 503, body: {} };
	const counts = {
		early: 414,
		on_time: 6628,
		late: 1243,
		classified: 8285,
		scheduled: 8657,
		observed_trips: 230,
	};
	const value = {
		early: counts.early / counts.classified,
		on_time: 0.8,
		late: counts.late / counts.classified,
		median_delay: -30,
		p90_delay: 350,
	};
	const cell = (key, numbers = value, sample = counts) => ({
		key,
		value: numbers,
		state: 'measured',
		state_text: { en: 'Measured', fr: 'Mesuré' },
		evidence: { counts: sample, days_included: days },
	});
	const grid = Array.from({ length: 7 }, (_, day) =>
		Array.from({ length: 24 }, (_, hour) => {
			const key = { weekday: day + 1, hour };
			const total = 52 + ((hour * 9 + day * 7) % 60);
			const late = Math.round(total * (0.1 + ((hour + day) % 8) * 0.038));
			const reading = cell(
				key,
				{ late: late / total },
				{ late, classified: total, scheduled: total + 3 },
			);
			if ((hour > 0 && hour < 5) || (hour === 5 && day === 6) || (hour === 23 && day > 4))
				return {
					...cell(key, { late: null }, { scheduled: 0 }),
					state: 'unknown',
					state_text: { en: 'Unknown', fr: 'Inconnu' },
				};
			if (hour === 5 || (hour > 20 && (day + hour) % 2 === 0))
				return {
					...cell(key, { late: null }, { scheduled: 28, classified: 23 }),
					state: 'too_few_to_judge',
					state_text: { en: 'Too few to judge', fr: 'Trop peu pour juger' },
				};
			return reading;
		}),
	).flat();
	const coverage_note = null;
	const named = process.env.TRANSIT_E2E_STOP_RECORD_NAMED === '1';
	const stm = get('city') === 'stm';
	if (get('stop') === '57135') {
		const state = 'unknown';
		const state_text = { en: 'Unknown', fr: 'Inconnu' };
		return {
			body: {
				...(group ? { cells: [] } : { value: {} }),
				state,
				state_text,
				coverage_note,
				evidence: { ...evidence, counts: {}, days_included: [], days_measured: [] },
			},
		};
	}
	if (!['S1', 'archived-stop'].includes(get('stop')))
		return { status: 400, body: { message: 'Wrong stop cut' } };
	if (measure === 'punctuality' && from === '2026-10-24') {
		return {
			body: {
				value: {},
				state: 'not_measured',
				state_text: { en: 'Not measured', fr: 'Non mesuré' },
				coverage_note: { en: 'Low coverage', fr: 'Faible couverture' },
				evidence: {
					...evidence,
					counts: { classified: 5, scheduled: 100 },
					coverage_reason: 'insufficient_coverage',
				},
			},
		};
	}
	if (get('format') === 'csv') {
		const header = get('lang') === 'fr' ? 'Mesure,Valeur' : 'Measure,Value';
		const value = measure === 'accessible_stops' ? (get('city') === 'octranspo' ? 0 : 1) : 0.8;
		return { csv: `${header}\n${measure},${value}\n` };
	}
	if (measure === 'waiting_and_gaps' && group === 'line')
		return waitingEngine(url, {
			...evidence,
			method_version: 'waiting-fixture-v4',
			cleaning_versions: [13],
		});
	if (group) {
		const cells = {
			line: [
				cell(
					{ line: named && stm ? '51' : '80' },
					{ on_time: 6605 / 8252 },
					{ classified: 8252, on_time: 6605 },
				),
				{
					...cell(
						{ line: named ? (stm ? '368' : '111') : '24' },
						{ on_time: null },
						{ classified: 33 },
					),
					state: 'too_few_to_judge',
					state_text: { en: 'Too few to judge', fr: 'Trop peu pour juger' },
				},
			],
			hour: [cell({ hour: 7 })],
			weekday_hour: grid,
			day: days.map((day, index) => {
				const onTime = [75, 79, 81, 82, 84, 78, 81][index % 7];
				return cell({ day }, { on_time: onTime / 100 }, { classified: 100, on_time: onTime });
			}),
		}[group];
		return {
			hold:
				(group === 'weekday_hour' && from === '2026-11-09' && 'stop-hour-grid') ||
				(group === 'line' &&
					((from === '2026-11-09' && 'stop-by-line') ||
						(/^2026-10-1[5-8]$/u.test(from) && ['stop', get('city'), from, to].join('-')))),
			body: {
				cells,
				coverage_note,
				evidence,
				...(group === 'weekday_hour' || group === 'line'
					? {
							info: [{ id: measure, minimum_sample: group === 'weekday_hour' ? 30 : 60 }],
						}
					: {}),
			},
		};
	}
	let row = cell(null);
	if (measure === 'accessible_stops') {
		const accessible = stm && !named ? 1 : 0;
		row = cell(
			null,
			{ accessible_stops: accessible },
			{
				stops_accessible: accessible,
				stops_not_accessible: 0,
				stops_no_information: 1 - accessible,
				stops_not_published: 0,
			},
		);
	}
	if (measure === 'alert_counts') {
		if (from === '2026-11-09') {
			return { status: 503, headers: { 'retry-after': '10' }, body: { message: 'busy' } };
		}
		row =
			get('city') === 'octranspo'
				? {
						...cell(null, { alerts: null }, {}),
						state: 'not_tracked',
						state_text: { en: 'Not tracked', fr: 'Non suivi' },
					}
				: cell(null, { alerts: 3, alert_versions: 4 }, { alerts: 3, alert_versions: 4 });
	}
	return {
		headers: measure === 'punctuality' ? { 'x-transit-answer': 'last-good' } : {},
		body: {
			...row,
			coverage_note,
			evidence: {
				...evidence,
				...row.evidence,
				...(measure === 'alert_counts'
					? row.state === 'not_tracked'
						? { days_measured: [], days_included: [], method_version: '', cleaning_versions: [] }
						: {
								days_measured: days.slice(0, 4),
								days_included: days.slice(0, 4),
								method_version: 'alerts-fixture-v5',
								cleaning_versions: [14],
							}
					: {}),
				...(measure === 'punctuality'
					? { share_observed: counts.classified / counts.scheduled }
					: {}),
			},
		},
	};
}
