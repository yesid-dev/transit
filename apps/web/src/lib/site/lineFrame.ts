import { DEFAULT_SITE_ORIGIN } from './config.ts';
import { detailTabFromSearchParams } from './detailTabs.ts';

export function lineFrameView(url: URL): 'record' | 'schedule' | 'live' | null {
	const { origin, searchParams } = url;
	const framed =
		origin === DEFAULT_SITE_ORIGIN ||
		['frameMode', 'recordFrom', 'recordTo'].some((key) => searchParams.has(key));
	if (!framed) return null;

	const tab = detailTabFromSearchParams(searchParams);
	if (searchParams.get('frameMode') === 'live' || tab === 'detail') return 'live';
	return tab === 'schedule' ? 'schedule' : 'record';
}
