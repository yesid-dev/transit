import { DEFAULT_SITE_ORIGIN } from './config.ts';
import { detailTabFromSearchParams } from './detailTabs.ts';

export function stopFrameView({ origin, searchParams }: URL): 'record' | 'live' | null {
	const framed =
		origin === DEFAULT_SITE_ORIGIN ||
		['frameMode', 'recordFrom', 'recordTo'].some((key) => searchParams.has(key));
	if (!framed) return null;

	const tab = detailTabFromSearchParams(searchParams);
	if (tab === 'schedule') return null;
	return searchParams.get('frameMode') === 'live' || tab === 'detail' ? 'live' : 'record';
}

export function stopViewHref(url: URL, view: 'record' | 'live'): URL {
	const target = new URL(url);
	target.hash = '';
	target.searchParams.set('frameMode', view);
	target.searchParams.delete('tab');
	if (view === 'live') target.searchParams.set('tab', 'detail');
	return target;
}
