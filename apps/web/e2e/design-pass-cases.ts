import { localizeHref } from '../src/lib/i18n/routing';

const departure = encodeURIComponent(JSON.stringify(['24', 0, '07:00:00']));

const screens = {
	overview: '/',
	'overview-live': '/?frameMode=live',
	lines: '/lines',
	'line-record': '/lines/24',
	'line-live': '/lines/24?frameMode=live',
	stops: '/stops',
	'stop-record': '/stop/S1',
	'stop-live': '/stop/S1?frameMode=live',
	vehicles: '/vehicles',
	'vehicles-live': '/vehicles?frameMode=live',
	'vehicle-record': '/vehicle/40061',
	'vehicle-live': '/vehicle/40061?frameMode=live',
	departure: '/departure/' + departure,
	hotspots: '/hotspots',
	rankings: '/repeat-offenders',
	daily: '/receipt',
	alerts: '/alerts',
	'alerts-live': '/alerts?frameMode=live',
	'network-health': '/network',
	'network-health-live': '/network?frameMode=live',
	'data-health': '/status',
	'data-health-live': '/status?frameMode=live',
	'how-we-measure': '/metrics',
	search: '/search',
	'search-query': '/search?q=24',
	'map-live': '/map?frameMode=live',
	'map-record-stops': '/map?frameMode=record&mapLayer=stops',
	'map-record-corridors': '/map?frameMode=record&mapLayer=corridors&recordLine=24',
	download: '/download',
	roadmap: '/roadmap',
	privacy: '/privacy',
	terms: '/terms',
	accessibility: '/accessibility',
	error: '/design-pass-missing-page',
} as const;

export type Screen = keyof typeof screens;

const ottawa: Screen[] = [
	'alerts',
	'alerts-live',
	'how-we-measure',
	'download',
	'departure',
	'roadmap',
	'line-live',
	'line-record',
	'lines',
	'map-live',
	'map-record-stops',
	'network-health',
	'network-health-live',
	'data-health',
	'data-health-live',
	'overview',
	'overview-live',
	'rankings',
	'stop-record',
	'vehicle-record',
	'vehicle-live',
	'vehicles',
];
const french: Screen[] = [
	'alerts',
	'alerts-live',
	'daily',
	'vehicle-record',
	'vehicle-live',
	'download',
	'departure',
	'roadmap',
	'overview',
	'overview-live',
	'line-record',
	'line-live',
	'stop-record',
	'map-live',
	'map-record-stops',
	'rankings',
	'network-health',
	'network-health-live',
	'data-health',
	'data-health-live',
	'lines',
	'how-we-measure',
];

export const designPassCases = [
	...Object.keys(screens).map((screen) => [screen as Screen, 'stm', 'en'] as const),
	...ottawa.map((screen) => [screen, 'octranspo', 'en'] as const),
	...french.map((screen) => [screen, 'stm', 'fr'] as const),
	['alerts', 'octranspo', 'fr'] as const,
	['alerts-live', 'octranspo', 'fr'] as const,
	['overview', 'octranspo', 'fr'] as const,
	['overview-live', 'octranspo', 'fr'] as const,
	['line-live', 'octranspo', 'fr'] as const,
	['stop-record', 'octranspo', 'fr'] as const,
	['how-we-measure', 'octranspo', 'fr'] as const,
	['download', 'octranspo', 'fr'] as const,
	['departure', 'octranspo', 'fr'] as const,
	['daily', 'octranspo', 'en'] as const,
	['daily', 'octranspo', 'fr'] as const,
	['vehicle-record', 'octranspo', 'fr'] as const,
	['vehicle-live', 'octranspo', 'fr'] as const,
	['roadmap', 'octranspo', 'fr'] as const,
	...(['network-health', 'network-health-live', 'data-health', 'data-health-live'] as const).map(
		(screen) => [screen, 'octranspo', 'fr'] as const,
	),
].map(([screen, provider, locale]) => {
	const url = new URL(screens[screen], 'http://fixture');
	if (provider === 'octranspo' && screen === 'vehicle-record') url.pathname = '/vehicle/1';
	const [from, to] =
		screen === 'alerts' || screen === 'alerts-live'
			? ['2026-11-17', '2026-11-23']
			: screen.startsWith('network-health')
				? ['2026-11-20', '2026-11-22']
				: screen.startsWith('data-health')
					? ['2026-10-26', '2026-11-22']
					: screen === 'daily'
				? ['2026-11-18', '2026-11-20']
				: screen === 'departure'
					? ['2026-11-16', '2026-11-20']
					: ['2026-11-08', '2026-11-14'];
	url.searchParams.set('recordFrom', from);
	url.searchParams.set('recordTo', to);
	return {
		screen,
		provider,
		locale,
		key: [screen, provider, locale].join('/'),
		href: localizeHref(url.pathname + url.search, locale, provider),
	};
});
