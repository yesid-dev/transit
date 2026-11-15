import { defineCopy } from '#lib/i18n/copy.ts';

export const footerCopy = defineCopy({
	fr: {
		navAria: 'Pied de page',
		exploreLabel: 'Explorer',
		providerFallback: 'l’agence de transport',
		tagline: (agencyName: string) => `Analytique citoyenne pour ${agencyName}`,
		disclaimer: (agencyName: string) => `Site non officiel, sans affiliation avec ${agencyName}.`,
		auditLabel: 'Vérification',
		legalLabel: 'Juridique',
	},
	en: {
		navAria: 'Footer',
		exploreLabel: 'Explore',
		providerFallback: 'the transit agency',
		tagline: (agencyName: string) => `Citizen analytics for ${agencyName}`,
		disclaimer: (agencyName: string) => `Unofficial website, not affiliated with ${agencyName}.`,
		auditLabel: 'Audit',
		legalLabel: 'Legal',
	},
});
