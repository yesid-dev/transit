import { LEGAL_NAV, NAV_GROUPS, visibleNav, type NavItem } from '#lib/content/nav.ts';
import { footerCopy } from '#lib/components/layout/footer.copy.ts';
import { transitTerms } from '#lib/i18n/transitTerms.copy.ts';
import type { SitePage } from './transitSearch.ts';

type Terms = (typeof transitTerms)['en'];

/** Approved terms a page explains, so a reader finds the page by them in either language. */
const EXPLAINS: Partial<Record<NavItem['key'], (terms: Terms) => readonly string[]>> = {
	metrics: (t) => [
		t.measure,
		t.reading,
		t.band.onTime,
		t.band.early,
		t.band.late,
		t.delayUnknown,
		t.uncertaintyRange,
		t.percentagePoints,
		t.crowding,
	],
	receipt: (t) => [t.trip.cancelled, t.trip.silent, t.trip.missing, t.completeDay],
	status: (t) => [t.noLiveData],
};

/** The pages search can find: the menu's pages this network has, then the legal pages. */
export function sitePages(capabilities: { readonly alerts: boolean | null }): SitePage[] {
	const legal = { en: footerCopy.en.legalLabel, fr: footerCopy.fr.legalLabel };
	return [
		...visibleNav(capabilities).map((item) => ({
			href: item.href,
			label: item.label,
			group: NAV_GROUPS.find((group) => group.key === item.group)?.label ?? null,
			words: (['en', 'fr'] as const).flatMap((locale) => {
				const explains = EXPLAINS[item.key];
				return explains ? explains(transitTerms[locale]) : [];
			}),
		})),
		...LEGAL_NAV.map((item) => ({ href: item.href, label: item.label, group: legal, words: [] })),
	];
}
