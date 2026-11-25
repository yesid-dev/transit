import { alertFixtures } from './alert-fixture.mjs';

export function alertsEngine(url) {
	const { searchParams } = url;
	const from = searchParams.get('from');
	const to = searchParams.get('to');
	if (from === '2026-11-05' && to === from) return { status: 503, body: {} };
	const group = searchParams.get('group');
	const messages = searchParams.has('alert_details');
	const fr = searchParams.get('lang') === 'fr';
	const measure = 'alert_counts';
	const value = { alerts: 426, alert_versions: 426, alert_hours: 12.5 };
	const measured = { state: 'measured', state_text: { en: 'Measured', fr: 'Mesuré' } };
	const missing = { state: 'not_measured', state_text: { en: 'Not measured', fr: 'Non mesuré' } };
	const partial = from !== to;
	const evidence = {
		start_date: from,
		end_date: to,
		days_measured: [to],
		days_included: [to],
		days_not_measured: partial ? [from] : [],
		days_not_measured_reasons: partial ? { [from]: 'no_raw_captures' } : {},
		method_version: 'alerts-fixture-v1',
		cleaning_versions: [7],
		query_ms: 8,
		counts: { alerts: 426, alert_versions: 426, alert_seconds: 45_000 },
	};
	const coverage_note = partial
		? {
				en: 'Some dates lack alert history.',
				fr: 'L’historique des alertes manque à certaines dates.',
			}
		: null;
	if (searchParams.get('format') === 'csv') {
		return { csv: `${fr ? 'Mesure,Du,Au' : 'Measure,From,To'}\n${measure},${from},${to}\n` };
	}
	const body = { measure, ...measured, coverage_note, evidence };
	if (group) {
		if (group === 'effect' || group === 'line') {
			const counts = new Map();
			for (const alert of alertFixtures(value.alerts)) {
				for (const key of group === 'line' ? alert.routes : [alert.effect]) {
					counts.set(key, (counts.get(key) ?? 0) + 1);
				}
			}
			return {
				body: {
					...body,
					group,
					cells: [...counts].map(([key, count]) => ({
						...measured,
						key: { [group]: key },
						value: { ...value, alerts: count },
						evidence: { counts: { alerts: count }, days_included: [to] },
					})),
				},
			};
		}
		const keys = {
			day: { day: to },
			hour: { hour: 7 },
			stop_id: { stop: '51234' },
			cause: { cause: 'CONSTRUCTION' },
		};
		const cells = [
			{
				...measured,
				key: keys[group],
				value,
				evidence: { counts: evidence.counts, days_included: [to] },
			},
		];
		if (group === 'day' && partial)
			cells.unshift({
				...missing,
				key: { day: from },
				value: { alerts: null, alert_versions: null, alert_hours: null },
				evidence: { counts: {}, days_included: [] },
			});
		return { body: { ...body, group, cells } };
	}
	if (messages)
		evidence.alert_messages = alertFixtures(value.alerts).map(
			({ id, routes, stops, header, description }) => ({
				source: 'fixture',
				id,
				version: 'v1',
				routes,
				stops,
				header,
				description: { en: null, fr: null, ...description },
				periods: [{ start: to + 'T12:00:00+00:00', end: to + 'T15:00:00+00:00' }],
			}),
		);
	const slowMessage = messages && from === to && /^2026-11-1[0-5]$/.test(from);
	return { body: { ...body, value }, hold: slowMessage && `alerts-${from}` };
}
