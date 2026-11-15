import type { Locale } from '#lib/i18n/index.ts';
import { transitTerms } from '#lib/i18n/transitTerms.copy.ts';
import { STATUS_LABELS } from '#lib/v1/enumLabels.ts';
import type { StatusCode } from '#lib/v1/schemas/index.ts';

/**
 * The map's one name for each vehicle status, shared by the legend and the Status filter so the
 * two never disagree side by side: the approved vocabulary for the bands and an unknown delay,
 * and "Severe" until the three-band switch (R4.2) retires it. Other pages keep STATUS_LABELS.
 */
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
		case 'severe':
			return STATUS_LABELS[locale].severe;
	}
}
