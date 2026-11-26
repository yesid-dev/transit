import { detailTabFromSearchParams } from './detailTabs.ts';

export function stopFrameView({ searchParams }: URL): 'record' | 'live' {
	const tab = detailTabFromSearchParams(searchParams);
	return searchParams.get('frameMode') === 'live' || tab === 'detail' ? 'live' : 'record';
}

export function stopViewHref(url: URL, view: 'record' | 'live'): URL {
	const target = new URL(url);
	target.hash = '';
	target.searchParams.set('frameMode', view);
	target.searchParams.delete('tab');
	return target;
}
