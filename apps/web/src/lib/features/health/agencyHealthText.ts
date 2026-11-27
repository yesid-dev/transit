import type { Locale } from '#lib/i18n/index.ts';
import type {
	EngineResult,
	MeasureAnswer,
	RecordMeasure,
	RecordSeries,
	ScorecardAnswer,
} from '#lib/server/engine.ts';
import {
	alertsNotCollected,
	type AgencyName,
	compactServiceDay,
	countedUnit,
	frenchAgency,
	hoursReading,
	recordPercent,
	recordRatio,
} from '#lib/site/presenter.ts';
import { publishedAlertEffect, unstatedEffect } from '../alerts/alertCards.ts';
import { feedLabels, networkRows } from '../network/networkRecordText.ts';
import { healthReason } from '../record/dataHealthText.ts';
import { recordState, recordStateFor, type RecordState } from '../record/recordStates.ts';
import { choose, tally } from '../record/recordText.ts';

/** A row reads "Published", one of the record states, or "Unavailable" when the engine failed. */
export type PublishState = 'published' | 'unavailable' | RecordState;

export type HealthRow = { id: string; label: string; state: PublishState; note: string | null };

export function publishStateText(state: PublishState, locale: Locale) {
	if (state === 'published') return choose(locale, 'Published', 'Publié');
	if (state === 'unavailable') return choose(locale, 'Unavailable', 'Indisponible');
	return recordState(state)[locale];
}

const answerOf = <T>(result: EngineResult<T> | null) =>
	result?.kind === 'answer' ? result.answer : null;

const number = (value: unknown) => (typeof value === 'number' ? value : null);

/** The share of scheduled stop events that have a reading, and its counts. */
export function stopEventCoverage(answer: MeasureAnswer, locale: Locale) {
	const share = answer.evidence.share_observed;
	if (share == null || answer.state === 'not_measured') return null;
	const scheduled = number(answer.evidence.counts.scheduled);
	const observed = number(answer.evidence.counts.classified);
	const days = countedUnit(answer.evidence.days_included.length, 'day', locale);
	return {
		value: recordPercent(share, locale),
		sentence: choose(
			locale,
			'of scheduled stop events have a reading.',
			'des passages prévus aux arrêts ont un relevé.',
		),
		counted:
			scheduled != null && observed != null
				? choose(
						locale,
						`${tally(observed, locale)} of ${tally(scheduled, locale)} scheduled stop events, ${days}`,
						`${tally(observed, locale)} passages prévus aux arrêts sur ${tally(scheduled, locale)}, ${days}`,
					)
				: days,
		rest: choose(
			locale,
			'The rest are left out of every figure, never counted as on time.',
			'Les autres sont exclus de tous les résultats et ne sont jamais comptés comme étant à l’heure.',
		),
	};
}

function accessibilityRow(
	id: 'stops' | 'trips',
	result: EngineResult<RecordMeasure>,
	locale: Locale,
): HealthRow {
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const label =
		id === 'stops'
			? t('Wheelchair boarding at stops', 'Accès en fauteuil roulant aux arrêts')
			: t('Wheelchair access on trips', 'Accès en fauteuil roulant des trajets');
	const answer = answerOf(result);
	if (!answer) return { id, label, state: 'unavailable', note: null };
	const count = (key: string) => number(answer.evidence.counts[`${id}_${key}`]);
	const accessible = count('accessible');
	const notAccessible = count('not_accessible');
	const noInformation = count('no_information');
	const noColumn = count('not_published');
	if (
		answer.state === 'not_measured' ||
		accessible == null ||
		notAccessible == null ||
		noInformation == null ||
		noColumn == null
	)
		return { id, label, state: 'not_measured', note: null };
	const total = accessible + notAccessible + noInformation + noColumn;
	const declared = accessible + notAccessible;
	// The stops served and the trips scheduled on these dates, named apart from the timetable's stops.
	const unit = (value: number) =>
		countedUnit(value, id === 'stops' ? 'stop-served' : 'trip-scheduled', locale);
	if (!total) return { id, label, state: 'unknown', note: null };
	if (!declared)
		return {
			id,
			label,
			state: 'not_published',
			note: t(
				`No information for any of ${unit(total)}`,
				`Aucune information pour les ${unit(total)}`,
			),
		};
	return {
		id,
		label,
		state: 'published',
		note: recordRatio(declared, unit(total), locale),
	};
}

function alertRows(
	effects: EngineResult<RecordSeries> | null,
	agency: AgencyName,
	locale: Locale,
): HealthRow[] {
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const alerts = { id: 'alerts', label: t('Service alerts', 'Avis de service') };
	const effect = { id: 'alert_effects', label: t('Effect of each notice', 'Effet de chaque avis') };
	// One row says it once: the effects of alerts Transit does not collect are not tracked either.
	if (!effects)
		return [{ ...alerts, state: 'alerts_not_tracked', note: alertsNotCollected(agency, locale) }];
	const answer = answerOf(effects);
	if (!answer)
		return [
			{ ...alerts, state: 'unavailable', note: null },
			{ ...effect, state: 'unavailable', note: null },
		];
	if (answer.state === 'not_measured')
		return [
			{ ...alerts, state: 'not_measured', note: null },
			{ ...effect, state: 'not_measured', note: null },
		];
	let total = 0;
	let stated = 0;
	for (const cell of answer.cells) {
		const count = cell.value.alerts ?? 0;
		total += count;
		const key = typeof cell.key.effect === 'string' ? cell.key.effect : null;
		const published = publishedAlertEffect(key);
		if (published && published !== unstatedEffect) stated += count;
	}
	const alertCount = (value: number) =>
		t(
			`${tally(value, locale)} ${value === 1 ? 'notice' : 'notices'}`,
			`${tally(value, locale)} avis`,
		);
	if (!total)
		return [
			{
				...alerts,
				state: 'published',
				note: t('No notice in these dates', 'Aucun avis à ces dates'),
			},
			{
				...effect,
				state: 'not_measured',
				note: t('No notice to check', 'Aucun avis à vérifier'),
			},
		];
	return [
		{ ...alerts, state: 'published', note: alertCount(total) },
		stated
			? { ...effect, state: 'published', note: recordRatio(stated, alertCount(total), locale) }
			: {
					...effect,
					state: 'not_published',
					note: t(
						`None of ${alertCount(total)} states its effect`,
						`Aucun des ${alertCount(total)} n’indique son effet`,
					),
				},
	];
}

function occupancyRow(result: EngineResult<ScorecardAnswer>, locale: Locale): HealthRow {
	const id = 'occupancy';
	const label = choose(locale, 'How full each vehicle is', 'Occupation des véhicules');
	const answer = answerOf(result);
	if (!answer) return { id, label, state: 'unavailable', note: null };
	const measure = 'vehicle_field_completeness';
	const state = answer.evidence.dimension_states[measure]?.[id] ?? answer.state;
	const values = answer.value[measure];
	const value =
		values && typeof values === 'object' ? number((values as Record<string, unknown>)[id]) : null;
	if (state !== 'measured' || value == null)
		return { id, label, state: recordStateFor(state), note: null };
	if (value === 0)
		return {
			id,
			label,
			state: 'not_published',
			note: choose(locale, 'In no vehicle report', 'Dans aucun signalement de véhicule'),
		};
	return {
		id,
		label,
		state: 'published',
		note: choose(
			locale,
			`In ${recordPercent(value, locale)} of vehicle reporting time`,
			`Pendant ${recordPercent(value, locale)} du temps de signalement des véhicules`,
		),
	};
}

/** What the agency publishes and what it does not, from figures the engine already answers. */
export function publishingRows(
	{
		accessibility,
		alertEffects,
		completeness,
	}: {
		accessibility: EngineResult<RecordMeasure>;
		alertEffects: EngineResult<RecordSeries> | null;
		completeness: EngineResult<ScorecardAnswer>;
	},
	agency: AgencyName,
	locale: Locale,
): HealthRow[] {
	return [
		...alertRows(alertEffects, agency, locale),
		accessibilityRow('stops', accessibility, locale),
		accessibilityRow('trips', accessibility, locale),
		occupancyRow(completeness, locale),
	];
}

/** The foot of the "publishes" card: the stops and trips it read, over its days. */
export function publishingSample(accessibility: EngineResult<RecordMeasure>, locale: Locale) {
	const answer = answerOf(accessibility);
	if (!answer) return null;
	const sum = (prefix: string) =>
		['accessible', 'not_accessible', 'no_information', 'not_published'].reduce(
			(total, key) => total + (number(answer.evidence.counts[`${prefix}_${key}`]) ?? 0),
			0,
		);
	return [
		countedUnit(sum('stops'), 'stop-served', locale),
		countedUnit(sum('trips'), 'trip-scheduled', locale),
		countedUnit(answer.evidence.days_included.length, 'day', locale),
	].join(', ');
}

const object = (value: unknown): Record<string, unknown> =>
	value != null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

/** Each card's whole content is one state when no part of its answer was measured. */
export function scorecardState(answer: ScorecardAnswer, measure: string): RecordState | null {
	const states = Object.values(answer.evidence.dimension_states[measure] ?? {});
	if (answer.state === 'measured' || states.includes('measured')) return null;
	return recordStateFor(answer.state);
}

export function minimumSample(answer: ScorecardAnswer, measure: string) {
	return answer.info.find((entry) => entry.id === measure)?.minimum_sample ?? null;
}

export function scorecardDays(answer: ScorecardAnswer, locale: Locale) {
	return countedUnit(answer.evidence.days_included.length, 'day', locale);
}

/** "3 of the 7 days" when the measure covers part of the dates, else "7 days". */
export function measuredDaysText(answer: ScorecardAnswer, locale: Locale) {
	const { start_date, end_date, days_included } = answer.evidence;
	const included = new Set(days_included).size;
	const selected = Math.round((Date.parse(end_date) - Date.parse(start_date)) / 86_400_000) + 1;
	if (!(included < selected)) return scorecardDays(answer, locale);
	const total = countedUnit(selected, 'day', locale);
	return choose(
		locale,
		`${tally(included, locale)} of the ${total}`,
		`${countedUnit(included, 'day', locale)} sur ${tally(selected, locale)}`,
	);
}

/**
 * Live trip coverage in two plain readings on one base: the trips scheduled on the days the
 * measure covers. Days with a capture gap are left out of both rows and of the foot.
 */
export function tripCoverageFacts(answer: ScorecardAnswer, locale: Locale) {
	const t = (en: string, fr: string) => choose(locale, en, fr);
	const measure = 'live_trip_coverage';
	const counts = answer.evidence.counts[measure] ?? {};
	const value = number(answer.value[measure]);
	const appeared = number(counts.appeared);
	const eligible = number(counts.eligible);
	const neverSeenAll = number(counts.never_seen);
	const scheduledAll = number(counts.scheduled);
	// Without a capture gap, the whole-period counts already share the base.
	const gapFree =
		eligible != null &&
		neverSeenAll != null &&
		scheduledAll != null &&
		scheduledAll === eligible + neverSeenAll;
	const neverSeen = number(counts.never_seen_on_measured_days) ?? (gapFree ? neverSeenAll : null);
	const scheduled = number(counts.scheduled_on_measured_days) ?? (gapFree ? scheduledAll : null);
	const days = measuredDaysText(answer, locale);
	const partial = days !== scorecardDays(answer, locale);
	const onDays = (text: string) => (partial ? `${text}, ${days}` : text);
	const trips = (n: number) => countedUnit(n, 'trip', locale);
	const facts = [
		{
			id: 'with_live_data',
			label: t('Trips with live data', 'Trajets avec des données en direct'),
			value: answer.state === 'measured' && value != null ? recordPercent(value, locale) : null,
			detail:
				appeared != null && eligible
					? onDays(
							t(
								`${recordRatio(appeared, trips(eligible), locale)} on lines seen in live data`,
								`${recordRatio(appeared, trips(eligible), locale)} sur les lignes vues en direct`,
							),
						)
					: null,
		},
		// A row on another base would not add up with the first, so it waits for the counts.
		...(neverSeen != null && scheduled
			? [
					{
						id: 'lines_never_seen',
						label: t(
							'Scheduled trips on lines never seen in live data',
							'Trajets prévus sur les lignes jamais vues en direct',
						),
						value: recordPercent(neverSeen / scheduled, locale),
						detail: onDays(
							t(
								`${recordRatio(neverSeen, trips(scheduled), locale)} scheduled`,
								`${recordRatio(neverSeen, trips(scheduled), locale)} prévus`,
							),
						),
					},
				]
			: []),
	];
	const base = scheduled ?? eligible;
	const included = new Set(answer.evidence.days_included);
	const skipped = (answer.evidence.capture_gap_days[measure] ?? []).filter(
		(day) => !included.has(day),
	);
	const skippedDays = skipped.map((day) => compactServiceDay(day, locale)).join(', ');
	return {
		facts,
		sample: base != null ? `${countedUnit(base, 'trip-scheduled', locale)}, ${days}` : null,
		gapNote: skipped.length
			? t(
					`This figure leaves out days with gaps in live data (${skippedDays}).`,
					`Ce résultat exclut les jours où les données en direct étaient incomplètes (${skippedDays}).`,
				)
			: null,
	};
}

const fields = {
	position: ['Position on the map', 'Position sur la carte'],
	trip: ['Trip it is running', 'Trajet effectué'],
	route: ['Line', 'Ligne'],
	stop: ['Stop it is at or heading to', 'Arrêt actuel ou suivant'],
	current_status: ['At a stop or on its way', 'À l’arrêt ou en route'],
	occupancy: ['How full it is', 'Occupation du véhicule'],
} satisfies Record<string, [string, string]>;

/** Each detail a vehicle report can carry, with the share of reporting time that carried it. */
export function vehicleReportRows(answer: ScorecardAnswer, locale: Locale) {
	const measure = 'vehicle_field_completeness';
	const values = object(answer.value[measure]);
	const states = answer.evidence.dimension_states[measure] ?? {};
	const counts = answer.evidence.counts[measure] ?? {};
	const rows = Object.entries(fields).map(([id, label]) => {
		const value = number(values[id]);
		const state = states[id] ?? answer.state;
		return {
			id,
			label: choose(locale, ...label),
			share:
				state === 'measured' && value != null
					? recordPercent(value, locale)
					: publishStateText(recordStateFor(state), locale),
		};
	});
	const reporting = number(object(counts.position).reporting_us);
	const hours = reporting == null ? null : hoursReading(reporting / 3_600_000_000, locale);
	return {
		rows,
		sample: hours
			? choose(
					locale,
					`${hours} of vehicle reports, ${scorecardDays(answer, locale)}`,
					`${hours} de données des véhicules, ${scorecardDays(answer, locale)}`,
				)
			: scorecardDays(answer, locale),
	};
}

const ahead = (minutes: number, locale: Locale) =>
	locale === 'fr'
		? minutes === 1
			? 'une minute'
			: `${minutes} minutes`
		: minutes === 1
			? 'a minute'
			: `${minutes} minutes`;

/** Arrival predictions in a rider's words, then one row for each lead time. */
export function predictionReadings(answer: ScorecardAnswer, locale: Locale) {
	const measure = 'prediction_error';
	const values = object(answer.value[measure]);
	const states = answer.evidence.dimension_states[measure] ?? {};
	const horizons = Object.keys(values)
		.map(Number)
		.filter(Number.isFinite)
		.sort((left, right) => left - right);
	let checked = 0;
	const rows = horizons.map((minutes) => {
		const data = object(values[String(minutes)]);
		const share = number(data.within_60_seconds_share);
		const sample = number(data.sample_count) ?? 0;
		checked += sample;
		const state = states[String(minutes)] ?? answer.state;
		return {
			id: String(minutes),
			minutes,
			label: choose(locale, `${minutes} min ahead`, `${minutes} min à l’avance`),
			right:
				state === 'measured' && share != null
					? recordPercent(share, locale)
					: publishStateText(recordStateFor(state), locale),
			share: state === 'measured' ? share : null,
			checked: tally(sample, locale),
		};
	});
	const lead = rows.find((row) => row.share != null);
	const right = lead?.share == null ? null : Math.round(lead.share * 100);
	return {
		sentence:
			lead && right != null
				? choose(
						locale,
						`${right} predictions in 100 made ${ahead(lead.minutes, locale)} ahead were right within a minute.`,
						`${right} prévisions sur 100 faites ${ahead(lead.minutes, locale)} à l’avance étaient justes à une minute près.`,
					)
				: null,
		rows,
		checked,
		sample: choose(
			locale,
			`${tally(checked, locale)} ${checked === 1 ? 'prediction' : 'predictions'} checked, ${scorecardDays(answer, locale)}`,
			`${tally(checked, locale)} ${checked < 2 ? 'prévision vérifiée' : 'prévisions vérifiées'}, ${scorecardDays(answer, locale)}`,
		),
	};
}

/**
 * Predictions are checked only against a report of the vehicle stopped at the stop. A feed
 * that never sends one gives nothing to check: the card is "Not measured", with that reason.
 */
export function predictionsNotMeasured(
	answer: ScorecardAnswer,
	agency: AgencyName,
	locale: Locale,
) {
	const counts = answer.evidence.counts.prediction_error ?? {};
	let stopped = 0;
	let other = 0;
	for (const horizon of Object.values(counts)) {
		const bases = object(object(horizon).by_basis);
		for (const [basis, count] of Object.entries(bases)) {
			const n = number(count) ?? 0;
			if (basis === 'vehicle_stopped') stopped += n;
			else other += n;
		}
	}
	if (stopped > 0 || other === 0) return null;
	return choose(
		locale,
		`${agency.name}’s feed never reports a vehicle stopped at a stop, so no prediction could be checked against an arrival.`,
		`Le flux ${frenchAgency(agency).of} ne signale jamais un véhicule arrêté à un arrêt\u00a0: aucune prévision n’a donc pu être vérifiée par rapport à une arrivée.`,
	);
}

/** The foot of the feed checks card: every check Transit made, over its days. */
export function feedCheckSample(answer: ScorecardAnswer, locale: Locale) {
	const counts = answer.evidence.counts.poll_success ?? {};
	const attempts = Object.values(counts).reduce<number>(
		(total, feed) => total + (number(object(feed).attempts) ?? 0),
		0,
	);
	return choose(
		locale,
		`${tally(attempts, locale)} ${attempts === 1 ? 'feed check' : 'feed checks'}, ${scorecardDays(answer, locale)}`,
		`${tally(attempts, locale)} ${attempts < 2 ? 'contrôle' : 'contrôles'} des flux, ${scorecardDays(answer, locale)}`,
	);
}

/** A part that has too few readings names the minimum it needs. */
export function minimumNote(answer: ScorecardAnswer, measure: string, locale: Locale) {
	const minimum = minimumSample(answer, measure);
	const states = Object.values(answer.evidence.dimension_states[measure] ?? {});
	if (minimum == null || !states.includes('too_few_to_judge')) return null;
	return measure === 'prediction_error'
		? choose(
				locale,
				`At least ${tally(minimum, locale)} observed arrivals per lead time.`,
				`Au moins ${tally(minimum, locale)} arrivées observées par horizon de prévision.`,
			)
		: choose(
				locale,
				`At least ${tally(minimum, locale)} samples per reading.`,
				`Au moins ${tally(minimum, locale)} observations par résultat.`,
			);
}

/** Each feed's row shows its check outcomes and how often its file was stale. */
export function feedCheckRows(answer: ScorecardAnswer, locale: Locale, age?: ScorecardAnswer) {
	const ages = age?.evidence.counts.feed_age_at_capture ?? {};
	const countsByLabel = new Map(
		Object.entries(feedLabels).map(([feed, labels]) => [choose(locale, ...labels), ages[feed]]),
	);
	return networkRows('poll_success', answer, locale).rows.map(([label, answered, ratio]) => {
		const { overflow, attempts } = object(countsByLabel.get(label));
		const checked = ratio ? choose(locale, `${ratio} checks`, `${ratio} contrôles`) : null;
		const stale =
			typeof overflow === 'number' && overflow > 0 && typeof attempts === 'number'
				? recordRatio(overflow, tally(attempts, locale), locale)
				: null;
		const detail = [
			checked,
			stale &&
				choose(
					locale,
					`${stale} with a feed over 10 min old`,
					`${stale} avec un flux datant de plus de 10 min`,
				),
		]
			.filter(Boolean)
			.join(' · ');
		return { id: label, label, answered, detail: detail || undefined };
	});
}

/** The days Transit could not check the feeds, each with its reason, in one sentence. */
export function collectionGaps(answer: ScorecardAnswer, locale: Locale) {
	const { days_not_measured, days_not_measured_reasons, capture_gap_days } = answer.evidence;
	const interrupted = new Set(capture_gap_days.poll_success ?? []);
	const affected = [...new Set([...days_not_measured, ...interrupted])].sort();
	if (!affected.length) return null;
	const days = affected.map((day) => {
		const reason = interrupted.has(day)
			? choose(locale, 'collection interrupted', 'collecte interrompue')
			: healthReason(days_not_measured_reasons[day], locale).toLocaleLowerCase(locale);
		return `${compactServiceDay(day, locale)} (${reason})`;
	});
	return choose(
		locale,
		`Days with a gap in collection: ${days.join(', ')}.`,
		`Jours avec une lacune de collecte\u00a0: ${days.join(', ')}.`,
	);
}

export function tripsLeftOutByDay(answer: RecordSeries, locale: Locale) {
	return answer.cells.flatMap(({ key: { day }, evidence }) => {
		const count = evidence.excluded?.capture_gap;
		if (typeof day !== 'string' || count == null || count <= 0) return [];
		const date = compactServiceDay(day, locale);
		const trips = countedUnit(count, 'trip', locale);
		return [
			choose(
				locale,
				`${date}: ${trips} left out because live data was interrupted.`,
				`${date}\u00a0: ${trips} ${count === 1 ? 'écarté' : 'écartés'} à cause d’une interruption des données en direct.`,
			),
		];
	});
}
