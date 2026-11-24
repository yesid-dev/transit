import { defineCopy } from '#lib/i18n/copy.ts';

export const footerCopy = defineCopy({
	fr: {
		tagline:
			'Un bilan public et indépendant du service de transport livré. Pas un planificateur de trajets.',
		navAria: 'Pied de page',
		exploreLabel: 'Explorer',
		providerFallback: 'l’agence de transport',
		legalTagline: (agencyName: string) => `Analytique citoyenne pour ${agencyName}`,
		disclaimer: (agencyName: string) => `Site non officiel, sans affiliation avec ${agencyName}.`,
		auditLabel: 'Vérification',
		infoLabel: 'Information',
	},
	en: {
		tagline: 'An independent public record of the transit service delivered. Not a trip planner.',
		navAria: 'Footer',
		exploreLabel: 'Explore',
		providerFallback: 'the transit agency',
		legalTagline: (agencyName: string) => `Citizen analytics for ${agencyName}`,
		disclaimer: (agencyName: string) => `Unofficial website, not affiliated with ${agencyName}.`,
		auditLabel: 'Audit',
		infoLabel: 'Information',
	},
});
