const states = {
	no_live_data: { glyph: '⊘', en: 'No live data', fr: 'Aucune donnée en direct' },
	not_measured: { glyph: '□', en: 'Not measured', fr: 'Non mesuré' },
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
