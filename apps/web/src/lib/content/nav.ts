import { roadmapTitle } from '#lib/features/roadmap/roadmap.copy.ts';

export interface BilingualLabel {
	readonly en: string;
	readonly fr: string;
}

export interface SurfaceNavItem {
	readonly key: 'map' | 'lines' | 'stops' | 'network';
	readonly href: string;
	readonly label: BilingualLabel;
	readonly description: BilingualLabel;
	readonly activePrefixes: readonly string[];
}

export interface ExternalNavLink {
	readonly href: string;
	readonly label: BilingualLabel;
}

export interface SecondaryNavLink {
	readonly href: string;
	readonly label: BilingualLabel;
}

export interface AuditNavItem {
	readonly key: 'metrics' | 'status' | 'hotspots' | 'receipt' | 'repeatOffenders' | 'alerts';
	readonly href: string;
	readonly label: BilingualLabel;
	readonly activePrefixes: readonly string[];
}

export type NavGroupKey = 'now' | 'explore' | 'reports' | 'about';
export interface NavItem {
	readonly key:
		| 'overview'
		| 'map'
		| 'network'
		| 'lines'
		| 'stops'
		| 'vehicles'
		| 'hotspots'
		| 'repeatOffenders'
		| 'receipt'
		| 'alerts'
		| 'metrics'
		| 'status'
		| 'download';
	readonly group: NavGroupKey;
	readonly href: string;
	readonly label: BilingualLabel;
	readonly barLabel?: BilingualLabel;
	readonly activePrefixes: readonly string[];
	readonly exact?: boolean;
	readonly requires?: 'alerts';
	readonly upcoming?: string;
}
const UPCOMING = '/upcoming/';
export const NAV_GROUPS: readonly { readonly key: NavGroupKey; readonly label: BilingualLabel }[] =
	[
		{ key: 'now', label: { en: 'Now', fr: 'Maintenant' } },
		{ key: 'explore', label: { en: 'Explore', fr: 'Explorer' } },
		{ key: 'reports', label: { en: 'Rankings and reports', fr: 'Classements et rapports' } },
		{ key: 'about', label: { en: 'About the data', fr: 'À propos des données' } },
	];
export const NAV_ITEMS: readonly NavItem[] = [
	{
		key: 'overview',
		group: 'now',
		href: '/',
		label: { en: 'Overview', fr: 'Aperçu' },
		barLabel: { en: 'Overview', fr: 'Aperçu' },
		activePrefixes: ['/'],
		exact: true,
	},
	{
		key: 'map',
		group: 'now',
		href: '/map',
		label: { en: 'Live map', fr: 'Carte en direct' },
		barLabel: { en: 'Map', fr: 'Carte' },
		activePrefixes: ['/map'],
	},
	{
		key: 'network',
		group: 'now',
		href: '/network',
		label: { en: 'Network health', fr: 'Santé du réseau' },
		activePrefixes: ['/network'],
	},
	{
		key: 'lines',
		group: 'explore',
		href: '/lines',
		label: { en: 'Lines', fr: 'Lignes' },
		barLabel: { en: 'Lines', fr: 'Lignes' },
		activePrefixes: ['/lines'],
	},
	{
		key: 'stops',
		group: 'explore',
		href: '/stops',
		label: { en: 'Stops', fr: 'Arrêts' },
		barLabel: { en: 'Stops', fr: 'Arrêts' },
		activePrefixes: ['/stops', '/stop/'],
	},
	{
		key: 'vehicles',
		group: 'explore',
		href: '/vehicles',
		label: { en: 'Vehicles', fr: 'Véhicules' },
		activePrefixes: ['/vehicles', '/vehicle/'],
	},
	{
		key: 'hotspots',
		group: 'reports',
		href: '/hotspots',
		label: { en: 'Worst lines and stops', fr: 'Pires lignes et arrêts' },
		activePrefixes: ['/hotspots'],
	},
	{
		key: 'repeatOffenders',
		group: 'reports',
		href: '/repeat-offenders',
		label: { en: 'Worst trips and vehicles', fr: 'Pires voyages et véhicules' },
		activePrefixes: ['/repeat-offenders'],
	},
	{
		key: 'receipt',
		group: 'reports',
		href: '/receipt',
		label: { en: 'Daily report', fr: 'Rapport quotidien' },
		activePrefixes: ['/receipt'],
		upcoming: 'daily-report',
	},
	{
		key: 'alerts',
		group: 'reports',
		href: '/alerts',
		label: { en: 'Service alerts', fr: 'Avis de service' },
		activePrefixes: ['/alerts'],
		requires: 'alerts',
	},
	{
		key: 'metrics',
		group: 'about',
		href: '/metrics',
		label: { en: 'How we measure', fr: 'Comment on mesure' },
		activePrefixes: ['/metrics'],
		upcoming: 'how-we-measure',
	},
	{
		key: 'status',
		group: 'about',
		href: '/status',
		label: { en: 'Data health', fr: 'Santé des données' },
		activePrefixes: ['/status'],
		upcoming: 'data-health',
	},
	{
		key: 'download',
		group: 'about',
		href: UPCOMING + 'download',
		label: { en: 'Download the data', fr: 'Télécharger les données' },
		activePrefixes: [UPCOMING + 'download'],
	},
];
/** Hides an item only when its capability is known to be false. */
export function visibleNav(capabilities: { readonly alerts: boolean | null }): readonly NavItem[] {
	return NAV_ITEMS.filter((item) => item.requires !== 'alerts' || capabilities.alerts !== false);
}

export const FRAME_MENU = NAV_ITEMS.map((item) => {
	const href = item.upcoming ? UPCOMING + item.upcoming : item.href;
	return {
		...item,
		href,
		activePrefixes: item.upcoming ? [href] : item.activePrefixes,
	};
});

export function upcomingPage(path: string) {
	if (!path.startsWith(UPCOMING)) return undefined;
	return FRAME_MENU.find((item) => item.href === path);
}

const surfaceDescriptions = {
	map: { en: 'live network', fr: 'réseau en direct' },
	lines: { en: 'routes and directions', fr: 'itinéraires et directions' },
	stops: { en: 'departures and schedules', fr: 'départs et horaires' },
	network: { en: 'reliability and health', fr: 'fiabilité et santé' },
};
export const SURFACE_NAV: readonly SurfaceNavItem[] = (
	['map', 'lines', 'stops', 'network'] as const
).map((key) => ({
	...NAV_ITEMS.find((item) => item.key === key)!,
	key,
	description: surfaceDescriptions[key],
}));

export const YESID_HOUSE_LINK: ExternalNavLink = {
	href: 'https://yesid.dev',
	label: { en: 'About Yesid', fr: 'À propos de Yesid' },
};

export const AUDIT_NAV: readonly AuditNavItem[] = (
	['metrics', 'status', 'hotspots', 'receipt', 'repeatOffenders', 'alerts'] as const
).map((key) => ({ ...NAV_ITEMS.find((item) => item.key === key)!, key }));

export const FOOTER_INFO_NAV: readonly SecondaryNavLink[] = [
	{
		href: '/privacy',
		label: { en: 'Privacy', fr: 'Confidentialité' },
	},
	{
		href: '/terms',
		label: { en: 'Terms', fr: 'Conditions d’utilisation' },
	},
	{
		href: '/accessibility',
		label: { en: 'Accessibility', fr: 'Accessibilité' },
	},
	{ href: '/roadmap', label: roadmapTitle },
] as const;

export const SECONDARY_NAV: readonly SecondaryNavLink[] = [...AUDIT_NAV, ...FOOTER_INFO_NAV].map(
	(item) => ({
		href: item.href,
		label: item.label,
	}),
);

export function isSurfaceActive(
	item: { readonly activePrefixes: readonly string[]; readonly exact?: boolean },
	currentPath: string,
): boolean {
	if (item.exact) return item.activePrefixes.includes(currentPath);
	return item.activePrefixes.some((prefix) => {
		const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
		return currentPath === base || currentPath.startsWith(`${base}/`);
	});
}

export const SEARCH_LABEL: BilingualLabel = { en: 'Search', fr: 'Recherche' };
export function mainLandmarkLabel(currentPath: string): BilingualLabel | null {
	if (currentPath === '/search') return SEARCH_LABEL;
	return (
		upcomingPage(currentPath)?.label ??
		NAV_ITEMS.find((item) => isSurfaceActive(item, currentPath))?.label ??
		FOOTER_INFO_NAV.find((item) => item.href === currentPath)?.label ??
		null
	);
}
