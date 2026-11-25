const states = {
	no_live_data: { glyph: '⊘', en: 'No live data', fr: 'Aucune donnée en direct' },
	not_measured: { glyph: '□', en: 'Not measured', fr: 'Non mesuré' },
	not_published: { glyph: '□', en: 'Not published', fr: 'Non publié' },
	too_few_to_judge: { glyph: '△', en: 'Too few to judge', fr: 'Trop peu de données pour conclure' },
	unknown: { glyph: '○', en: 'Unknown', fr: 'Inconnu' },
	delay_unknown: { glyph: '○', en: 'Delay unknown', fr: 'Retard inconnu' },
	not_reporting: { glyph: '◇', en: 'Not reporting', fr: 'Aucun signal' },
	not_tracked: {
		glyph: '⊠',
		en: 'Vehicles are not tracked in this city',
		fr: 'Les véhicules ne sont pas suivis dans cette ville',
	},
} as const;

export type RecordState = keyof typeof states;

export function recordState(state: RecordState) {
	return states[state];
}

export function recordStateFor(state: string | undefined): RecordState {
	switch (state) {
		case 'no_live_data':
		case 'not_tracked':
		case 'not_measured':
		case 'not_published':
		case 'too_few_to_judge':
		case 'not_reporting':
			return state;
		default:
			return 'unknown';
	}
}
