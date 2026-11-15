// Type-only: plain Node (the B9 scripts) loads this file without loading @yesid/i18n-core.
import type { defineCopy } from '#lib/i18n/copy.ts';

/**
 * The approved Transit vocabulary (UX plan §5.6): one EN/FR source of names that pages adopt one
 * at a time. Labels are sentence case. Callers format numbers and dates, then pass them in. The
 * approved sentences W1 to W26, menu labels and page titles keep their own wording.
 */
const terms = {
	en: {
		record: 'Record',
		liveNow: 'Live now',
		reading: 'Reading',
		measure: 'Measure',
		line: 'Line',
		/** The owner's three bands; an unknown delay is not a band. */
		band: { onTime: 'On time', early: 'Early', late: 'Late' },
		delayUnknown: 'Delay unknown',
		trip: {
			noun: 'Trip',
			cancelled: 'Cancelled trip',
			silent: 'Silent trip',
			missing: 'Missing trip',
		},
		/** A vehicle state, never a trip state. */
		vehicle: { noun: 'Vehicle', noRecentPosition: 'No recent position' },
		/** Lines left out of rates, counts and rankings. */
		noLiveData: 'No live data',
		completeDay: 'Complete day',
		/** `shown` is `count` as the caller formatted it for this locale. */
		completeDays: (count: number, shown: string) =>
			`${shown} ${count === 1 ? 'complete day' : 'complete days'}`,
		percentagePoints: 'Percentage points',
		uncertaintyRange: 'Uncertainty range',
		/** Reported occupancy levels, not ridership. */
		crowding: 'Crowding',
		/** A position in a ranking, never "worst". */
		firstRanked: 'First-ranked',
		action: {
			openRecord: 'Open record',
			showOnMap: 'Show on map',
			seeLiveNow: 'See live now',
			seeRecord: 'See the record',
			copyLink: 'Copy link',
			downloadCsv: 'Download CSV',
			citeRecord: 'Cite this record',
			viewTable: 'View table',
		},
	},
	fr: {
		record: 'Bilan',
		liveNow: 'En direct',
		reading: 'Relevé',
		measure: 'Indicateur',
		line: 'Ligne',
		band: { onTime: 'À l’heure', early: 'En avance', late: 'En retard' },
		delayUnknown: 'Retard inconnu',
		trip: {
			noun: 'Trajet',
			cancelled: 'Trajet annulé',
			silent: 'Trajet silencieux',
			missing: 'Trajet manquant',
		},
		vehicle: { noun: 'Véhicule', noRecentPosition: 'Aucune position récente reçue' },
		noLiveData: 'Aucune donnée en direct',
		completeDay: 'Journée complète',
		// French counts 0 and 1 in the singular.
		completeDays: (count: number, shown: string) =>
			`${shown} ${count < 2 ? 'jour complet' : 'jours complets'}`,
		percentagePoints: 'Points de pourcentage',
		uncertaintyRange: 'Intervalle d’incertitude',
		crowding: 'Occupation',
		firstRanked: 'En tête du classement',
		action: {
			openRecord: 'Ouvrir le bilan',
			showOnMap: 'Voir sur la carte',
			seeLiveNow: 'Voir en direct',
			seeRecord: 'Voir le bilan',
			copyLink: 'Copier le lien',
			downloadCsv: 'Télécharger le CSV',
			citeRecord: 'Citer ce bilan',
			viewTable: 'Voir le tableau',
		},
	},
};

export const transitTerms: ReturnType<typeof defineCopy<typeof terms.fr>> = terms;

/**
 * Method-page finder only (owner decision): words that find a term but are never shown as its
 * name. Keyed like `transitTerms`.
 */
const aliases = {
	en: { trip: { silent: ['Ghost bus'], missing: ['Ghost bus'] } },
	fr: { trip: { silent: ['Bus fantôme'], missing: ['Bus fantôme'] } },
};

export const methodSearchAliases: ReturnType<typeof defineCopy<typeof aliases.fr>> = aliases;
