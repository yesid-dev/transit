import type { Locale } from '#lib/i18n/config.ts';
import type { PublicProvider } from '#lib/v1/providers.ts';
import { providers as publishedNetworks } from '../../../static/og/manifest.json';

export const publishedNetwork = (id: string) =>
	publishedNetworks.find((provider) => provider.id === id);

export function providerDisplayNames(
	provider: Pick<PublicProvider, 'id' | 'labels'> | null | undefined,
	locale: Locale,
	fallback: string,
) {
	if (!provider) return { full: fallback, short: fallback, operatorCity: fallback };
	const { id, labels } = provider;
	const label = labels[locale];
	const published = publishedNetwork(id)?.labels[locale];
	const city = label.city === id ? published?.city : label.city;
	const operator = label.operator === id ? published?.operator : label.operator;
	const short = operator ?? city ?? fallback;
	const both = city && operator && city !== operator;
	return {
		full: both ? `${city} · ${operator}` : short,
		short,
		operatorCity: both ? `${operator}, ${city}` : short,
	};
}
