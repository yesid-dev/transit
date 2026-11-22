import { DEFAULT_SITE_ORIGIN } from './config.ts';

export function usesFinderRecord(url: URL): boolean {
	return (
		url.origin === DEFAULT_SITE_ORIGIN ||
		['frameMode', 'recordFrom', 'recordTo'].some((key) => url.searchParams.has(key))
	);
}
