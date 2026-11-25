import type { NetworkFile } from '#lib/v1/schemas/network.ts';
import type { Locale } from '#lib/i18n/index.ts';
import { tally } from '../record/recordText';

/**
 * What the live network snapshot reports right now.
 */
export interface LivePulse {
	/** Vehicles reporting a position in the live feed; null when the file's count is not whole. */
	readonly reporting: number | null;
	/** Trips scheduled now with no vehicle reporting; null when the file's count is not whole. */
	readonly silent: number | null;
	/** Localized count and denominator when the live answer supplies both. */
	readonly silentReading?: string;
}

function wholeCount(value: number | null | undefined): number | null {
	return value != null && Number.isSafeInteger(value) && value >= 0 ? value + 0 : null;
}

export function selectLivePulse(net: NetworkFile | null, locale?: Locale): LivePulse | null {
	if (!net) return null;
	const silent = wholeCount(net.non_responding);
	const scheduled = wholeCount(net.scheduled_now);
	const pulse = { reporting: wholeCount(net.vehicles_in_service), silent };
	if (locale == null || scheduled == null || silent == null || silent > scheduled) return pulse;
	const n = tally(silent, locale);
	const total = tally(scheduled, locale);
	const silentReading =
		locale === 'fr'
			? `${n} sur ${total} ${scheduled === 1 ? 'trajet prévu' : 'trajets prévus'} en ce moment`
			: `${n} of ${total} ${scheduled === 1 ? 'trip' : 'trips'} scheduled now`;
	return { ...pulse, silentReading };
}
