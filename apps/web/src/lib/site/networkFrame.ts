import { DEFAULT_SITE_ORIGIN } from './config.ts';

export function networkRecordView({ origin, searchParams }: URL): boolean {
	return (
		searchParams.get('frameMode') !== 'live' &&
		(origin === DEFAULT_SITE_ORIGIN ||
			['frameMode', 'recordFrom', 'recordTo'].some((key) => searchParams.has(key)))
	);
}
