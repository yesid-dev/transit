import { defineCopy } from '#lib/i18n/copy.ts';

export const footerCopy = defineCopy({
	fr: {
		tagline:
			'Un bilan public et indépendant du service de transport livré. Pas un planificateur de trajets.',
		navAria: 'Pied de page',
		exploreLabel: 'Explorer',
		providerFallback: 'l’agence de transport',

		disclaimer: (agencyName: string) => `Site non officiel, sans affiliation avec ${agencyName}.`,
		auditLabel: 'Vérification',
		reportsLabel: 'Rapports',
		infoLabel: 'Information',
	},
	en: {
		tagline: 'An independent public record of the transit service delivered. Not a trip planner.',
		navAria: 'Footer',
		exploreLabel: 'Explore',
		providerFallback: 'the transit agency',

		disclaimer: (agencyName: string) => `Unofficial website, not affiliated with ${agencyName}.`,
		auditLabel: 'Audit',
		reportsLabel: 'Reports',
		infoLabel: 'Information',
	},
});
