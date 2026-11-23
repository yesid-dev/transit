const enFr = (en, fr) => ({ en, fr });

export const networkFixtures = {
	poll_success: {
		value: { trip_updates: 0.8, vehicle_positions: null },
		dimensions: { trip_updates: 'measured', vehicle_positions: 'too_few_to_judge' },
		counts: {
			trip_updates: { attempts: 25, successful: 20 },
			vehicle_positions: { attempts: 3, successful: 2 },
		},
	},
	feed_age_at_capture: {
		value: { trip_updates: { median_seconds: 8, p90_seconds: 'over_10_minutes' } },
		dimensions: { trip_updates: 'measured' },
		counts: { trip_updates: { samples: 25 } },
	},
	feed_update_interval: {
		value: { trip_updates: { median_seconds: 24, p90_seconds: 43 } },
		dimensions: { trip_updates: 'measured' },
		counts: { trip_updates: { samples: 24 } },
	},
	live_trip_coverage: {
		value: 0.75,
		dimensions: {},
		counts: { appeared: 30, eligible: 40, never_seen: 10, scheduled: 50, never_seen_share: 0.2 },
	},
	vehicle_field_completeness: {
		value: { occupancy: null, position: 1 },
		dimensions: { occupancy: 'not_published', position: 'measured' },
		counts: { position: { present_us: 7200000000, reporting_us: 7200000000 } },
	},
	prediction_error: {
		value: {
			1: {
				sample_count: 40,
				median_signed_seconds: -5,
				p90_absolute_seconds: 60,
				within_60_seconds_share: 0.9,
			},
			3: {
				sample_count: 2,
				median_signed_seconds: null,
				p90_absolute_seconds: null,
				within_60_seconds_share: null,
			},
		},
		dimensions: { 1: 'measured', 3: 'too_few_to_judge' },
		counts: {},
	},
};

export function networkEngine(url) {
	const get = (name) => url.searchParams.get(name);
	const measure = get('measure');
	const { value, dimensions, counts } = networkFixtures[measure];
	const from = get('from');
	const to = get('to');
	if (get('group'))
		return { status: 400, body: { message: 'Scorecard measures do not support group' } };
	if (get('format') === 'csv') {
		const header = get('lang') === 'fr' ? 'Mesure,Valeur' : 'Measure,Value';
		return { csv: `${header}\n${measure},${from}\n` };
	}

	return {
		hold: measure === 'prediction_error' && from === '2026-11-19' ? 'network' : false,
		body: {
			measure,
			value: { [measure]: value },
			state: 'measured',
			state_text: enFr('Measured', 'Mesuré'),
			coverage_note: enFr(
				'Only measured days are included.',
				'Seuls les jours mesurés sont inclus.',
			),
			evidence: {
				start_date: from,
				end_date: to,
				days_measured: [from],
				days_included: [from],
				days_not_measured: from < to ? [to] : [],
				days_not_measured_reasons: from < to ? { [to]: 'no_raw_captures' } : {},
				method_version: '2',
				cleaning_versions: [9],
				query_ms: 4,
				counts: { [measure]: counts },
				dimension_states: { [measure]: dimensions },
				capture_gap_days: { [measure]: measure === 'live_trip_coverage' && from < to ? [to] : [] },
			},
			info: [{ id: measure, minimum_sample: measure === 'prediction_error' ? 30 : 20 }],
		},
	};
}
