import { DEFAULT_SITE_ORIGIN } from './config.ts';

export function dailyReportFrame({ origin, searchParams }: URL) {
	return (
		!searchParams.has('date') &&
		(origin === DEFAULT_SITE_ORIGIN ||
			['frameMode', 'recordFrom', 'recordTo'].some((key) => searchParams.has(key)))
	);
}
