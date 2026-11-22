import { localizeHref, type Locale } from '#lib/i18n/index.ts';
import { carryFrameState } from '#lib/site/frameState.ts';

export function vehicleHref(path: string, url: URL, locale: Locale, city: string) {
	return carryFrameState(localizeHref(path, locale, city), url);
}
