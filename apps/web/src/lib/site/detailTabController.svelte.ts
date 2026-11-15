import { page } from '$app/state';
import { replaceState } from '$app/navigation';
import { detailTabFromSearchParams, detailTabQueryValue, type DetailTab } from './detailTabs';
import { currentMirrorUrl, mirrorSearchParam } from './urlMirror';

export interface DetailTabController {
	get active(): DetailTab;
	set active(next: DetailTab);
	syncFromUrl(url: URL): void;
}

export function createDetailTabController(initialUrl: URL): DetailTabController {
	const seedUrl = page.shallow?.url ?? initialUrl;
	let active = $state<DetailTab>(detailTabFromSearchParams(seedUrl.searchParams));

	function syncFromUrl(url: URL): void {
		const viewUrl = page.shallow?.url ?? url;
		const next = detailTabFromSearchParams(viewUrl.searchParams);
		active = next;

		const canonicalValue = detailTabQueryValue(next);
		const values = viewUrl.searchParams.getAll('tab');
		const isCanonical =
			canonicalValue === null
				? values.length === 0
				: values.length === 1 && values[0] === canonicalValue;
		if (isCanonical) return;
		// One write for every `tab` value; the mirror compares only the first, so repeats would stay.
		const canonical = currentMirrorUrl();
		canonical.searchParams.delete('tab');
		if (canonicalValue !== null) canonical.searchParams.set('tab', canonicalValue);
		try {
			replaceState(canonical, { ...page.state });
		} catch {
			// The router may not be ready; the URL hint is best effort, as in the mirror.
		}
	}

	return {
		get active() {
			return active;
		},
		set active(next: DetailTab) {
			active = next;
			mirrorSearchParam('tab', detailTabQueryValue(next));
		},
		syncFromUrl,
	};
}
