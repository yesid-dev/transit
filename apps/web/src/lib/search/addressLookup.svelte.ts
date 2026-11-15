import type { Locale } from '#lib/i18n/index.ts';
import type { GeocodeSuggestion } from '#lib/geocode/types.ts';
import { canSearchAddresses } from './transitSearch.ts';

export interface AddressAnswer {
	readonly query: string;
	readonly state: 'loading' | 'done' | 'failed';
	readonly found: readonly GeocodeSuggestion[];
}

/** What the address row says: an offer, a lookup under way, nothing found, or unavailable. */
export type AddressRowState = 'ask' | 'loading' | 'none' | 'failed';

/**
 * Addresses are sent only when the reader asks, once, for the text in the field at that moment.
 * An answer only counts for the text it was asked for; a newer request ignores a late answer.
 */
export function createAddressLookup(where: () => { providerId: string; locale: Locale }) {
	let answer = $state<AddressAnswer | null>(null);
	return {
		/** The answer for exactly this text, or null when it was not asked. */
		for(query: string): AddressAnswer | null {
			return answer?.query === query ? answer : null;
		},
		/** The address row for this text; null when there is none (not a place, or addresses found). */
		row(query: string): AddressRowState | null {
			const asked = this.for(query);
			if (!canSearchAddresses(query) || (asked?.state === 'done' && asked.found.length > 0))
				return null;
			if (!asked) return 'ask';
			return asked.state === 'done' ? 'none' : asked.state;
		},
		async ask(query: string): Promise<void> {
			const { providerId, locale } = where();
			const settle = (state: AddressAnswer['state'], found: GeocodeSuggestion[] = []) => {
				if (answer?.query === query) answer = { query, state, found };
			};
			answer = { query, state: 'loading', found: [] };
			try {
				const response = await fetch(
					`/api/geocode?provider=${encodeURIComponent(providerId)}&lang=${locale}&q=${encodeURIComponent(query)}&suggest=1&limit=2`,
				);
				if (!response.ok) return settle('failed');
				const payload = (await response.json()) as { results?: GeocodeSuggestion[] };
				settle('done', payload.results ?? []);
			} catch {
				settle('failed');
			}
		},
	};
}
