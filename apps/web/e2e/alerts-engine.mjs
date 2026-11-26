import { stmAlertFixtures } from './alert-fixture.mjs';

function messagePeriods(from, to, index) {
	const first = Date.parse(from + 'T05:00:00Z');
	const last = Date.parse(to + 'T05:00:00Z');
	const start = new Date(first + (index < 12 ? 7 * 3_600_000 : 0)).toISOString();
	if (index < 12 && index % 3 !== 1) {
		return [{ start, end: new Date(first + 10 * 3_600_000).toISOString() }];
	}
	const spanDays = (last - first) / 86_400_000 + 1;
	const overlaps = index < 12 || index % 48 === 0 ? spanDays : 1;
	return Array.from({ length: overlaps }, (_, offset) => ({
		start,
		end: new Date(first + (offset + 1) * 86_400_000 - 3 * 60_000).toISOString(),
	}));
}

export function alertsEngine(url) {
	const { searchParams } = url;
	const from = searchParams.get('from');
	const to = searchParams.get('to');
	if (from === '2026-11-05' && to === from) return { status: 503, body: {} };
	const group = searchParams.get('group');
	const messages = searchParams.has('alert_details');
	const fr = searchParams.get('lang') === 'fr';
	const measure = 'alert_counts';
	const value = { alerts: 1707, alert_versions: 1707, alert_hours: 12.5 };
	const measured = { state: 'measured', state_text: { en: 'Measured', fr: 'Mesuré' } };
	const missing = { state: 'not_measured', state_text: { en: 'Not measured', fr: 'Non mesuré' } };
	const partial = from !== to && from !== '2026-11-17';
	const dates = [];
	for (let day = Date.parse(from); day <= Date.parse(to); day += 86_400_000) {
		dates.push(new Date(day).toISOString().slice(0, 10));
	}
	const measuredDates = partial ? dates.slice(1) : dates;
	const evidence = {
		start_date: from,
		end_date: to,
		days_measured: measuredDates,
		days_included: measuredDates,
		days_not_measured: partial ? [from] : [],
		days_not_measured_reasons: partial ? { [from]: 'no_raw_captures' } : {},
		method_version: 'alerts-fixture-v1',
		cleaning_versions: [7],
		query_ms: 8,
		counts: { alerts: value.alerts, alert_versions: value.alert_versions, alert_seconds: 45_000 },
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
			for (const alert of stmAlertFixtures(value.alerts)) {
				for (const key of group === 'line' ? alert.routes : [alert.effect]) {
					counts.set(key, (counts.get(key) ?? 0) + 1);
				}
			}
			return {
				body: {
					...body,
					group,
					evidence: { ...evidence, counts: undefined },
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
	if (messages) {
		evidence.alert_messages = stmAlertFixtures(value.alerts).map(
			({ id, routes, stops, header, description }, index) => ({
				source: 'fixture',
				id,
				version: 'v1',
				routes,
				stops,
				header,
				description: { en: null, fr: null, ...description },
				periods: messagePeriods(from, to, index),
			}),
		);
		const roadworks = {
			header: { en: 'Your stop', fr: 'Votre arrêt' },
			description: {
				en: 'This stop is closed during roadworks.',
				fr: 'Cet arrêt est fermé pendant les travaux.',
			},
			stops: ['52997'],
			periods: messagePeriods(from, to, 1),
		};
		for (const index of [12, 13, 14]) {
			Object.assign(evidence.alert_messages[index], roadworks, {
				routes: [['34'], ['125'], ['353']][index - 12],
			});
		}
	}
	const slowMessage = messages && from === to && /^2026-11-1[0-5]$/.test(from);
	return { body: { ...body, value }, hold: slowMessage && `alerts-${from}` };
}
