import type { Locale } from '#lib/i18n/index.ts';
import { transitTerms } from '#lib/i18n/transitTerms.copy.ts';
import type { StatusCode } from '#lib/v1/schemas/index.ts';

/** Shared Live map names for the legend and filters. */
export function mapStatusLabel(locale: Locale, code: StatusCode): string {
	const terms = transitTerms[locale];
	switch (code) {
		case 'early':
			return terms.band.early;
		case 'on_time':
			return terms.band.onTime;
		case 'late':
			return terms.band.late;
		case 'unknown':
			return terms.delayUnknown;
	}
}
