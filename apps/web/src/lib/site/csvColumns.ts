import methodNames from '#lib/features/record/methodNames.json';

type Lang = 'en' | 'fr';

/** The columns the site adds to every downloaded CSV. */
export const csvHeaders = {
	measureId: { en: 'Measure ID', fr: 'Identifiant de la mesure' },
	source: { en: 'Data source and licence', fr: 'Source des données et licence' },
	licenceUrl: { en: 'Licence URL', fr: 'Adresse de la licence' },
};

// The engine names its columns in the language asked for.
export const engineColumns = {
	measure: ['Measure', 'Mesure'],
	value: ['Value', 'Valeur'],
	unit: ['Unit', 'Unité'],
	state: ['State', 'État'],
} as const;

const names: Record<string, readonly string[] | undefined> = methodNames;

/** A measure's name in the reader's language; its ID when the registry has no name for it. */
export function measureLabel(id: string, lang: Lang) {
	return names[id]?.[lang === 'fr' ? 1 : 0] ?? id;
}

/** A downloaded file's header, from the engine's: Measure ID before Measure, source and licence last. */
export function spreadsheetColumns(columns: readonly string[], lang: Lang) {
	const out = [...columns];
	const measure = out.findIndex((name) =>
		(engineColumns.measure as readonly string[]).includes(name),
	);
	if (measure >= 0) out.splice(measure, 0, csvHeaders.measureId[lang]);
	return [...out, csvHeaders.source[lang], csvHeaders.licenceUrl[lang]];
}
