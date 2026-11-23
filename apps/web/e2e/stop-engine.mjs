import { waitingEngine } from './waiting-engine.mjs';

export function stopEngine(url) {
	const get = (key) => url.searchParams.get(key);
	const from = get('from');
	const to = get('to');
	const group = get('group');
	const measure = get('measure');
	const evidence = {
		start_date: from,
		end_date: to,
		days_measured: [from],
		days_included: [from],
		days_not_measured: [],
		method_version: 'stop-fixture-v1',
		cleaning_versions: [9],
		query_ms: 4,
	};
	const counts = { early: 5, on_time: 80, late: 15, classified: 100 };
	const value = { early: 0.05, on_time: 0.8, late: 0.15, median_delay: -30, p90_delay: 350 };
	const cell = (key, numbers = value, sample = counts) => ({
		key,
		value: numbers,
		state: 'measured',
		state_text: { en: 'Measured', fr: 'Mesuré' },
		evidence: { counts: sample, days_included: [from] },
	});
	const coverage_note = null;
	if (get('stop') !== 'S1') return { status: 400, body: { message: 'Wrong stop cut' } };
	if (get('format') === 'csv') {
		const header = get('lang') === 'fr' ? 'Mesure,Valeur' : 'Measure,Value';
		const value = measure === 'accessible_stops' ? (get('city') === 'octranspo' ? 0 : 1) : 0.8;
		return { csv: `${header}\n${measure},${value}\n` };
	}
	if (measure === 'waiting_and_gaps' && group === 'line') return waitingEngine(url, evidence);
	if (group) {
		const cells = {
			line: [
				cell({ line: '80' }),
				{
					...cell({ line: '24' }, { on_time: null }, { classified: 3 }),
					state: 'too_few_to_judge',
					state_text: { en: 'Too few to judge', fr: 'Trop peu pour juger' },
				},
			],
			hour: [cell({ hour: 7 })],
			day: [cell({ day: from })],
		}[group];
		return {
			hold:
				group === 'line' &&
				((from === '2026-11-09' && 'stop-by-line') ||
					(/^2026-10-1[5-8]$/u.test(from) && ['stop', get('city'), from, to].join('-'))),
			body: { cells, coverage_note, evidence },
		};
	}
	let row = cell(null);
	if (measure === 'accessible_stops') {
		const accessible = get('city') === 'octranspo' ? 0 : 1;
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
		body: { ...row, coverage_note, evidence: { ...evidence, ...row.evidence } },
	};
}
