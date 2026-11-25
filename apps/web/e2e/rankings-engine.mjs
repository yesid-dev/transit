export function rankingsEngine(url) {
	const get = (key) => url.searchParams.get(key);
	const kind = get('kind');
	const measure = get('measure');
	const from = get('from');
	const vehicle = kind === 'vehicle';
	const reporting = measure === 'vehicle_reporting_gaps_per_100_hours';
	if (vehicle && !reporting) {
		return { status: 400, body: { message: 'Vehicle rankings require reporting gaps' } };
	}
	const wait = measure === 'excess_wait_time';
	const early = measure === 'early';
	const median = measure === 'median_delay';
	const floorGated = kind === 'departure' && from === get('to');
	const ids = { line: '24', stop: 'S1', departure: '["24",0,"07:15:00"]', vehicle: 'V01' };
	if (get('format') === 'csv') {
		const header = get('lang') === 'fr' ? 'Rang,Type,Identifiant' : 'Rank,Kind,ID';
		return { csv: `${header}\n1,${kind},${JSON.stringify(ids[kind])}\n` };
	}
	const classes = kind === 'line' ? ['3:frequent', '3:regular'] : [];
	const serviceClass = kind === 'line' ? (get('class') ?? '3:frequent') : null;
	const entry = {
		id: ids[kind],
		classes: kind === 'line' ? [serviceClass === 'all' ? '3:regular' : serviceClass] : [],
		...(kind === 'departure' ? { line: '24', direction: 0, departure: '07:15:00' } : {}),
		sample: reporting ? 20.5 : 100,
		counts: reporting
			? { reporting_gaps: 5 }
			: wait
				? {
						observed_headways: 100,
						observed_trip_pairs: 24,
						frequent_headways: 250,
						covered_scheduled_headways: 85,
					}
				: {
						early: 4,
						scheduled: 250,
						classified: 100,
						on_time: 48,
						late: 48,
						vehicle_stopped: 50,
						trip_update_passed: 50,
					},
		...(!vehicle ? { share_observed: 0.4, low_coverage: true } : {}),
	};
	const notTracked = vehicle && from === '2026-11-10';
	const paged = kind === 'line' && from === '2026-10-28';
	const method = wait
		? 'matched_headways'
		: reporting
			? 'vehicle_reporting_uncertainty_unknown'
			: median
				? 'histogram_half_bin'
				: 'wilson_95';
	return {
		hold: from === '2026-11-09' ? 'rankings' : false,
		body: {
			kind,
			measure,
			class: serviceClass,
			available_classes: classes,
			ranked_count: notTracked || floorGated ? 0 : paged ? 21 : 1,
			rows:
				notTracked || floorGated
					? []
					: Array.from({ length: paged ? 21 : 1 }, (_, index) => ({
							...entry,
							id: index === 0 ? entry.id : `L${index + 1}`,
							rank: index + 1,
							...(!reporting && !median && !wait ? { ranking_bound: 0.58 } : {}),
							value: wait ? 42.5 : early ? 0.04 : reporting ? 24.39 : median ? 30 : 0.48,
							range: {
								method,
								lower: wait || reporting ? null : early ? 0.02 : median ? 27.5 : 0.38,
								upper: wait || reporting ? null : early ? 0.1 : median ? 32.5 : 0.58,
							},
						})),
			excluded: notTracked
				? []
				: [
						{
							...entry,
							id: 'excluded',
							sample: 2,
							reason: 'too_few_to_judge',
							reason_text: { en: 'Too few to judge', fr: 'Trop peu pour juger' },
						},
					],
			...(notTracked
				? { state: 'not_tracked', state_text: { en: 'Not tracked', fr: 'Non suivi' } }
				: {}),
			coverage_note: null,
			range_notes: {
				wilson_95: { en: '95% Wilson interval.', fr: 'Intervalle de Wilson à 95 %.' },
				histogram_half_bin: { en: 'Histogram estimate.', fr: 'Estimation par histogramme.' },
				vehicle_reporting_uncertainty_unknown: {
					en: 'The uncertainty of this rate is unknown.',
					fr: 'L’incertitude du taux est inconnue.',
				},
			},
			info: [
				{
					minimum_sample: 30,
					ranking_floors: {
						departure: { observed_service_dates: 5, classified: 30 },
						line: wait
							? { observed_headways: 50, observed_trip_pairs: 20 }
							: { observed_trips: 20, classified: 100 },
					},
					...(vehicle ? { ranking_minimum_sample: 10 } : {}),
					text: {
						en: { definition: 'Calculated from the observed service.' },
						fr: { definition: 'Calculé à partir du service observé.' },
					},
				},
			],
			evidence: {
				start_date: from,
				end_date: get('to'),
				days_included: [from],
				days_measured: notTracked ? [] : [from],
				days_not_measured: [],
				method_version: 'rankings-fixture-v1',
				cleaning_versions: [8],
				query_ms: 4,
			},
		},
	};
}

export function rankingReferenceFixture(url) {
	const q = url.searchParams;
	const from = q.get('from');
	const measure = q.get('measure');
	if (!['2026-10-27', '2026-10-28'].includes(from) || q.has('group') || !measure) return null;
	const value = { on_time: 0.8, late: 0.2, early: 0.06, median_delay: 25, excess_wait_time: 35 }[
		measure
	];
	return {
		body: {
			measure,
			state: value == null ? 'not_measured' : 'measured',
			state_text:
				value == null ? { en: 'Not measured', fr: 'Non mesuré' } : { en: 'Measured', fr: 'Mesuré' },
			value: { [measure]: value ?? null },
			coverage_note: null,
			evidence: {
				start_date: from,
				end_date: q.get('to'),
				days_included: [from],
				days_measured: value == null ? [] : [from],
				days_not_measured: value == null ? [from] : [],
				method_version: from === '2026-10-28' ? 'old-fixture-v0' : 'rankings-fixture-v1',
				cleaning_versions: [8],
				query_ms: 2,
				counts: { classified: 250 },
				share_observed: 0.4,
			},
		},
	};
}
