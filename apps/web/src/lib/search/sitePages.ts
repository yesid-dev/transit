import { FOOTER_INFO_NAV, visibleNav, type NavItem } from '#lib/content/nav.ts';
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

/** The pages search can find: the menu's pages this network has, then the footer information pages. */
export function sitePages(capabilities: { readonly alerts: boolean | null }): SitePage[] {
	return [
		...visibleNav(capabilities).map((item) => ({
			href: item.href,
			label: item.label,
			words: (['en', 'fr'] as const).flatMap((locale) => {
				const explains = EXPLAINS[item.key];
				return explains ? explains(transitTerms[locale]) : [];
			}),
		})),
		...FOOTER_INFO_NAV.map((item) => ({
			href: item.href,
			label: item.label,
			words: [],
		})),
	];
}
