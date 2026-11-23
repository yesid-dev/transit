import { detailTabFromSearchParams } from './detailTabs.ts';

export function lineFrameView(url: URL): 'record' | 'schedule' | 'live' {
	const { searchParams } = url;

	const tab = detailTabFromSearchParams(searchParams);
	if (searchParams.get('frameMode') === 'live' || tab === 'detail') return 'live';
	return tab === 'schedule' ? 'schedule' : 'record';
}
