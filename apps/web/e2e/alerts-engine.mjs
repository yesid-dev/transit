export function alertsEngine(url) {
	const { searchParams } = url;
	const from = searchParams.get('from');
	const to = searchParams.get('to');
	const group = searchParams.get('group');
	const messages = searchParams.has('alert_details');
	const fr = searchParams.get('lang') === 'fr';
	const measure = 'alert_counts';
	const value = { alerts: 3, alert_versions: 4, alert_hours: 12.5 };
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
		counts: { alerts: 3, alert_versions: 4, alert_seconds: 45_000 },
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
		const keys = {
			day: { day: to },
			hour: { hour: 7 },
			line: { line: '24' },
			stop_id: { stop: '51234' },
			effect: { effect: 'DETOUR' },
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
		evidence.alert_messages = [
			{
				source: 'fixture',
				id: 'a1',
				version: 'v1',
				routes: ['24'],
				stops: ['51234'],
				header: { en: 'Detour on line 24', fr: 'Détour sur la ligne 24' },
				description: { en: 'Use stop 51234.', fr: null },
				periods: [{ start: `${to}T12:00:00+00:00`, end: `${to}T15:00:00+00:00` }],
			},
		];
	return { body: { ...body, value }, hold: messages && from < '2026-11-17' && `alerts-${from}` };
}
