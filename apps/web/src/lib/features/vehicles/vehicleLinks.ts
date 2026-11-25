import { localizeHref, type Locale } from '#lib/i18n/index.ts';
import { carryFrameState } from '#lib/site/frameState.ts';

export function vehicleHref(path: string, url: URL, locale: Locale, city: string) {
	return carryFrameState(localizeHref(path, locale, city), url);
}

export function vehicleLiveHref(id: string, source: URL, locale: Locale, city?: string) {
	const target = new URL(
		carryFrameState(localizeHref(`/vehicle/${encodeURIComponent(id)}`, locale, city), source),
		source,
	);
	target.searchParams.set('frameMode', 'live');
	return target.pathname + target.search;
}
