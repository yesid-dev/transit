import { describe, expect, it } from 'vitest';
import type {
	EngineResult,
	MeasureAnswer,
	RecordMeasure,
	RecordSeries,
	ScorecardAnswer,
} from '#lib/server/engine.ts';
import {
	agencyName,
	alertsNotCollected,
	alertsNotTrackedLine,
	alertsNotTrackedOnDates,
	frenchAgency,
} from '#lib/site/presenter.ts';
import {
	collectionGaps,
	predictionReadings,
	predictionsNotMeasured,
	publishingRows,
	publishStateText,
	stopEventCoverage,
	tripCoverageFacts,
	vehicleReportRows,
} from './agencyHealthText.ts';

const days = ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23'];
const evidence = {
	start_date: '2026-11-18',
	end_date: '2026-11-24',
	days_included: [...days, '2026-11-24'],
	days_measured: [...days, '2026-11-24'],
	days_not_measured: [],
	method_version: 'scorecard-v1',
	cleaning_versions: [12],
	query_ms: 1,
};
const answer = <T>(value: T): EngineResult<T> => ({ kind: 'answer', answer: value });
// French separates thousands with a narrow or a full non-breaking space depending on the runtime.
const spaces = <T>(value: T): T =>
	JSON.parse(JSON.stringify(value).replace(/\u202f/gu, '\u00a0')) as T;

function scorecard(
	measure: string,
	value: unknown,
	counts: Record<string, unknown>,
	dimensions: Record<string, string>,
	state = 'measured',
): ScorecardAnswer {
	return {
		state,
		state_text: { en: '', fr: '' },
		value: { [measure]: value },
		info: [{ id: measure, minimum_sample: 30 }],
		coverage_note: null,
		evidence: {
			...evidence,
			counts: { [measure]: counts },
			dimension_states: { [measure]: dimensions },
			capture_gap_days: { [measure]: [] },
			days_not_measured_reasons: {},
		},
	} as ScorecardAnswer;
}

const accessibility = (counts: Record<string, number>) =>
	answer({
		state: 'measured',
		state_text: { en: '', fr: '' },
		value: { accessible_trips: 0.7 },
		coverage_note: null,
		evidence: { ...evidence, counts },
	} as unknown as RecordMeasure);

const completeness = (occupancy: number) =>
	answer(
		scorecard(
			'vehicle_field_completeness',
			{ trip: 1, route: 1, stop: 1, current_status: 1, occupancy, position: 1 },
			{ position: { present_us: 7.2e15, reporting_us: 261_353_520_000_000 } },
			{
				trip: 'measured',
				route: 'measured',
				stop: 'measured',
				current_status: 'measured',
				occupancy: 'measured',
				position: 'measured',
			},
		),
	);

const effects = (cells: [string | null, number][]) =>
	answer({
		coverage_note: null,
		evidence,
		state: 'measured',
		state_text: { en: '', fr: '' },
		cells: cells.map(([effect, alerts]) => ({
			key: { effect },
			state: 'measured',
			state_text: { en: '', fr: '' },
			value: { alerts },
			evidence: { counts: {}, days_included: evidence.days_included },
		})),
	} as unknown as RecordSeries);

const readable = (rows: ReturnType<typeof publishingRows>, locale: 'en' | 'fr') =>
	rows.map((row) => [row.label, publishStateText(row.state, locale), row.note]);

describe('what the agency publishes', () => {
	it('says alert effects are not published when no alert states one', () => {
		const rows = publishingRows(
			{
				accessibility: accessibility({
					trips_accessible: 84_736,
					trips_not_accessible: 37_674,
					trips_no_information: 0,
					trips_not_published: 0,
					stops_accessible: 7_827,
					stops_not_accessible: 796,
					stops_no_information: 0,
					stops_not_published: 0,
				}),
				alertEffects: effects([[null, 1_602]]),
				completeness: completeness(0.999),
			},
			{ name: 'STM', frenchOf: 'de la STM' },
			'en',
		);
		expect(readable(rows, 'en')).toEqual([
			['Service alerts', 'Published', '1,602 notices'],
			['Effect of each notice', 'Not published', 'None of 1,602 notices states its effect'],
			['Wheelchair boarding at stops', 'Published', '8,623 of 8,623 stops served'],
			['Wheelchair access on trips', 'Published', '122,410 of 122,410 scheduled trips'],
			['How full each vehicle is', 'Published', 'In 99.9% of vehicle reporting time'],
		]);
	});

	it('names alerts Transit does not collect, and fields the agency leaves empty, in French', () => {
		const rows = publishingRows(
			{
				accessibility: accessibility({
					trips_accessible: 50_646,
					trips_not_accessible: 0,
					trips_no_information: 1,
					trips_not_published: 0,
					stops_accessible: 0,
					stops_not_accessible: 0,
					stops_no_information: 5_778,
					stops_not_published: 0,
				}),
				alertEffects: null,
				completeness: completeness(0),
			},
			{ name: 'OC Transpo', frenchOf: 'd’OC Transpo' },
			'fr',
		);
		expect(spaces(readable(rows, 'fr'))).toEqual(
			spaces([
				['Avis de service', 'Non suivi', 'Transit ne collecte pas encore les avis d’OC Transpo.'],
				[
					'Accès en fauteuil roulant aux arrêts',
					'Non publié',
					'Aucune information pour les 5\u202f778 arrêts desservis',
				],
				[
					'Accès en fauteuil roulant des trajets',
					'Publié',
					'50\u202f646 sur 50\u202f647 trajets prévus',
				],
				['Occupation des véhicules', 'Non publié', 'Dans aucun signalement de véhicule'],
			]),
		);
	});

	it('marks a failed answer unavailable instead of not published', () => {
		const rows = publishingRows(
			{
				accessibility: { kind: 'unreachable' },
				alertEffects: { kind: 'unreachable' },
				completeness: { kind: 'unreachable' },
			},
			{ name: 'STM', frenchOf: 'de la STM' },
			'en',
		);
		expect(rows.every(({ state }) => state === 'unavailable')).toBe(true);
		expect(publishStateText('unavailable', 'fr')).toBe('Indisponible');
	});
});

describe('the alerts sentence', () => {
	// The French forms come from each city's declaration (its download licence source line).
	const declared = {
		montreal: { name: 'STM', frenchOf: 'de la STM' },
		ottawa: { name: 'OC Transpo', frenchOf: 'd’OC Transpo' },
		gatineau: { name: 'STO', frenchOf: 'de la STO' },
	};
	it.each([
		['en', declared.ottawa, 'Not tracked: Transit does not collect OC Transpo’s notices yet.'],
		[
			'fr',
			declared.ottawa,
			'Non suivi\u00a0: Transit ne collecte pas encore les avis d’OC Transpo.',
		],
		[
			'fr',
			declared.montreal,
			'Non suivi\u00a0: Transit ne collecte pas encore les avis de la STM.',
		],
		[
			'fr',
			declared.gatineau,
			'Non suivi\u00a0: Transit ne collecte pas encore les avis de la STO.',
		],
	] as const)('reads one sentence in %s for %o', (locale, agency, line) => {
		expect(alertsNotTrackedLine(agency, locale)).toBe(line);
		expect(line.endsWith(alertsNotCollected(agency, locale))).toBe(true);
	});

	it.each([
		[declared.montreal, 'la STM', 'de la STM'],
		[declared.ottawa, 'OC Transpo', 'd’OC Transpo'],
		[declared.gatineau, 'la STO', 'de la STO'],
		[{ name: 'Le Réseau', frenchOf: 'du Réseau' }, 'le Réseau', 'du Réseau'],
		[{ name: 'Lignes', frenchOf: 'des Lignes' }, 'les Lignes', 'des Lignes'],
	])('takes the declared French forms for %o', (agency, subject, of) => {
		expect(frenchAgency(agency)).toMatchObject({ subject, of });
	});

	it('guesses no article for a city that declares none', () => {
		expect(frenchAgency({ name: 'XYZ' })).toMatchObject({ subject: 'XYZ', of: 'de XYZ' });
		expect(frenchAgency({ name: 'Ombre', frenchOf: null })).toMatchObject({
			subject: 'Ombre',
			of: 'd’Ombre',
		});
		expect(agencyName('STO', { download_licence: { source: { fr: 'de la STO' } } })).toEqual(
			declared.gatineau,
		);
		expect(agencyName('XYZ', null)).toEqual({ name: 'XYZ', frenchOf: null });
	});
});

describe('stop events with a reading', () => {
	const punctuality = {
		measure: 'punctuality',
		state: 'measured',
		state_text: { en: '', fr: '' },
		value: { on_time: 0.8 },
		coverage_note: null,
		evidence: {
			...evidence,
			share_observed: 0.6507870108739529,
			counts: { scheduled: 4_025_675, classified: 2_619_857 },
			excluded: {},
		},
	} as MeasureAnswer;

	it.each([
		[
			'en',
			'65.1%',
			'of scheduled stop events have a reading.',
			'2,619,857 of 4,025,675 scheduled stop events, 7 days',
		],
		[
			'fr',
			'65,1\u00a0%',
			'des passages prévus aux arrêts ont un relevé.',
			'2\u202f619\u202f857 passages prévus aux arrêts sur 4\u202f025\u202f675, 7 jours',
		],
	] as const)('answers with the share and its counts in %s', (locale, value, sentence, counted) => {
		expect(spaces(stopEventCoverage(punctuality, locale))).toMatchObject(
			spaces({ value, sentence, counted }),
		);
	});

	it('is absent, never 0%, when the engine gives no share or measured no day', () => {
		const missing = { ...punctuality, evidence: { ...punctuality.evidence, share_observed: null } };
		expect(stopEventCoverage(missing, 'en')).toBeNull();
		expect(stopEventCoverage({ ...punctuality, state: 'not_measured' }, 'fr')).toBeNull();
	});
});

describe('the agency scorecard in plain words', () => {
	it.each([
		['en', '87 predictions in 100 made a minute ahead were right within a minute.'],
		['fr', '87 prévisions sur 100 faites une minute à l’avance étaient justes à une minute près.'],
	] as const)('says what prediction accuracy means for a rider in %s', (locale, sentence) => {
		const predictions = scorecard(
			'prediction_error',
			{
				'1': { within_60_seconds_share: 0.8738, sample_count: 1_189_368 },
				'5': { within_60_seconds_share: 0.569, sample_count: 992_352 },
			},
			{},
			{ '1': 'measured', '5': 'measured' },
		);
		const readings = predictionReadings(predictions, locale);
		expect(readings.sentence).toBe(sentence);
		expect(readings.rows.map(({ minutes }) => minutes)).toEqual([1, 5]);
		expect(readings.checked).toBe(2_181_720);
	});

	it('gives no rider sentence when no lead time has enough arrivals', () => {
		const predictions = scorecard(
			'prediction_error',
			{ '1': { within_60_seconds_share: null, sample_count: 0 } },
			{},
			{ '1': 'too_few_to_judge' },
			'too_few_to_judge',
		);
		const readings = predictionReadings(predictions, 'en');
		expect(readings.sentence).toBeNull();
		expect(readings.rows[0].right).toBe('Too few to judge');
	});

	it('reads live trip coverage with both counts', () => {
		const coverage = scorecard(
			'live_trip_coverage',
			0.99987,
			{
				scheduled: 122_410,
				eligible: 111_974,
				appeared: 111_959,
				never_seen: 10_436,
				never_seen_share: 0.0853,
			},
			{},
		);
		expect(tripCoverageFacts(coverage, 'en').facts).toEqual([
			{
				id: 'with_live_data',
				label: 'Trips with live data',
				value: '100.0%',
				detail: '111,959 of 111,974 trips on lines seen in live data',
			},
			{
				id: 'lines_never_seen',
				label: 'Scheduled trips on lines never seen in live data',
				value: '8.5%',
				detail: '10,436 of 122,410 trips scheduled',
			},
		]);
	});

	// OC Transpo, 19 to 25 Nov: four days were capture gaps. 4,728 + 18,941 + 27,036 = 50,705
	// mixes seven days with three. One base: the three days, 18,941 + 2,179 = 21,120.
	const ottawa = (extra: Record<string, number>) => {
		const answer = scorecard(
			'live_trip_coverage',
			0.99319,
			{
				scheduled: 50_705,
				eligible: 18_941,
				appeared: 18_812,
				never_seen: 4_728,
				never_seen_share: 0.0932,
				...extra,
			},
			{},
		);
		answer.evidence.start_date = '2026-11-19';
		answer.evidence.end_date = '2026-11-25';
		answer.evidence.days_included = ['2026-11-22', '2026-11-23', '2026-11-24'];
		return answer;
	};

	it.each([
		[
			'en',
			[
				'18,812 of 18,941 trips on lines seen in live data, 3 of the 7 days',
				'2,179 of 21,120 trips scheduled, 3 of the 7 days',
			],
			'21,120 scheduled trips, 3 of the 7 days',
		],
		[
			'fr',
			[
				'18 812 sur 18 941 trajets sur les lignes vues en direct, 3 des 7 jours',
				'2 179 sur 21 120 trajets prévus, 3 des 7 jours',
			],
			'21 120 trajets prévus, 3 des 7 jours',
		],
	] as const)(
		'puts both coverage rows and the foot on the measured days (%s)',
		(locale, details, foot) => {
			const facts = tripCoverageFacts(
				ottawa({ scheduled_on_measured_days: 21_120, never_seen_on_measured_days: 2_179 }),
				locale,
			);
			const plain = (text: string | null) => text?.replace(/[\u00a0\u202f]/gu, ' ') ?? null;
			expect(facts.facts.map(({ detail }) => plain(detail))).toEqual(details);
			expect(facts.facts.map(({ value }) => plain(value))).toEqual(
				locale === 'fr' ? ['99,3 %', '10,3 %'] : ['99.3%', '10.3%'],
			);
			expect(plain(facts.sample)).toBe(foot);
		},
	);

	it('leaves out a row on another base until the engine gives the measured-day counts', () => {
		const facts = tripCoverageFacts(ottawa({}), 'en');
		expect(facts.facts.map(({ id }) => id)).toEqual(['with_live_data']);
		expect(facts.sample).toBe('18,941 scheduled trips, 3 of the 7 days');
	});

	it('says why no prediction could be checked when the feed never reports a stopped vehicle', () => {
		const none = scorecard(
			'prediction_error',
			{ '1': { within_60_seconds_share: null, sample_count: 0 } },
			{
				'1': {
					by_basis: {
						vehicle_stopped: 0,
						vehicle_nearby: 702_854,
						trip_update_reported: 0,
						trip_update_passed: 820_398,
					},
				},
			},
			{ '1': 'too_few_to_judge' },
			'too_few_to_judge',
		);
		const agency = { name: 'OC Transpo', frenchOf: 'd’OC Transpo' };
		expect(predictionsNotMeasured(none, agency, 'en')).toBe(
			'OC Transpo’s feed never reports a vehicle stopped at a stop, so no prediction could be checked against an arrival.',
		);
		expect(predictionsNotMeasured(none, agency, 'fr')).toBe(
			'Le flux d’OC Transpo ne signale jamais un véhicule arrêté à un arrêt\u00a0: aucune prévision n’a donc pu être vérifiée par rapport à une arrivée.',
		);
		const some = scorecard(
			'prediction_error',
			{},
			{ '1': { by_basis: { vehicle_stopped: 12, vehicle_nearby: 0 } } },
			{},
		);
		expect(predictionsNotMeasured(some, agency, 'en')).toBeNull();
	});

	it('reads each detail of a vehicle report as a share of reporting time', () => {
		const reports = completeness(0.999);
		if (reports.kind !== 'answer') throw new Error('fixture');
		const { rows, sample } = vehicleReportRows(reports.answer, 'fr');
		expect(rows.find(({ id }) => id === 'occupancy')).toEqual({
			id: 'occupancy',
			label: 'Occupation du véhicule',
			share: '99,9\u00a0%',
		});
		expect(spaces(sample)).toBe(spaces('72\u202f598,2\u00a0h de données des véhicules, 7 jours'));
	});
});

describe('gaps in collection', () => {
	it.each([
		['en', 'Days with a gap in collection: 24 Nov (no raw captures).'],
		['fr', 'Jours avec une lacune de collecte\u00a0: 24 nov. (aucune capture brute).'],
	] as const)('names each day and its reason in %s', (locale, sentence) => {
		const checks = scorecard('poll_success', {}, {}, {});
		checks.evidence.days_not_measured = ['2026-11-24'];
		checks.evidence.days_not_measured_reasons = { '2026-11-24': 'no_raw_captures' };
		expect(collectionGaps(checks, locale)).toBe(sentence);
	});
	it('says when no day has a gap', () => {
		expect(collectionGaps(scorecard('poll_success', {}, {}, {}), 'en')).toBe(
			'No gap in collection in these dates.',
		);
	});
});

it.each([
	['en', 'Not tracked: Transit did not collect STM’s notices on these dates.'],
	['fr', 'Non suivi\u00a0: Transit n’a pas collecté les avis de la STM à ces dates.'],
] as const)('separates dates without alerts from a city never collected in %s', (locale, line) => {
	expect(alertsNotTrackedOnDates({ name: 'STM', frenchOf: 'de la STM' }, locale)).toBe(line);
	expect(alertsNotTrackedOnDates({ name: 'STM', frenchOf: 'de la STM' }, locale)).not.toBe(
		alertsNotTrackedLine({ name: 'STM', frenchOf: 'de la STM' }, locale),
	);
});
