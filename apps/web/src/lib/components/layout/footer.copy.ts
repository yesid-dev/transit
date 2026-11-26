import { defineCopy } from '#lib/i18n/copy.ts';
import { frenchAgency, type AgencyName } from '#lib/site/presenter.ts';

export const footerCopy = defineCopy({
	fr: {
		tagline:
			'Un bilan public et indépendant du service de transport effectué. Pas un planificateur de trajets.',
		navAria: 'Pied de page',
		exploreLabel: 'Explorer',
		providerFallback: 'la société de transport',

		disclaimer: (agency: AgencyName) =>
			`Site non officiel, sans affiliation ${frenchAgency(agency).with}.`,
		auditLabel: 'Vérification',
		reportsLabel: 'Rapports',
		infoLabel: 'Information',
	},
	en: {
		tagline: 'An independent public record of the transit service delivered. Not a trip planner.',
		navAria: 'Footer',
		exploreLabel: 'Explore',
		providerFallback: 'the transit agency',

		disclaimer: (agency: AgencyName) => `Unofficial website, not affiliated with ${agency.name}.`,
		auditLabel: 'Audit',
		reportsLabel: 'Reports',
		infoLabel: 'Information',
	},
});
