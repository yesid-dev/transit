import { page } from '$app/state';
import { goto, replaceState } from '$app/navigation';

export function currentMirrorUrl(stateUrl = new URL(page.url.href)): URL {
	// Shallow navigation changes page.state while page.url can stay unchanged.
	void page.state;
	if (typeof window === 'undefined') return new URL(stateUrl);
	const browserUrl = new URL(window.location.href);
	return browserUrl.origin === stateUrl.origin && browserUrl.pathname === stateUrl.pathname
		? browserUrl
		: new URL(stateUrl);
}

export function mirrorSearchParam(
	key: string,
	value: string | null,
	options?: { navigate: boolean },
): void {
	mirrorSearchParams({ [key]: value }, options);
}

export function mirrorSearchParams(
	params: Record<string, string | null>,
	options?: { navigate: boolean },
): void {
	if (typeof window === 'undefined') return;
	const url = currentMirrorUrl();
	let changed = false;
	for (const [key, value] of Object.entries(params)) {
		const current = url.searchParams.get(key);
		if (value === null) {
			if (current !== null) {
				url.searchParams.delete(key);
				changed = true;
			}
		} else if (current !== value) {
			url.searchParams.set(key, value);
			changed = true;
		}
	}
	if (!changed) return;
	try {
		if (options?.navigate) {
			// Shallow replaceState retains the old router pageUrl on cross-page Back.
			void goto(url, { replace: true, reset: false, state: { ...page.state } });
		} else replaceState(url, { ...page.state });
	} catch {
		// The router may not be ready; the URL hint is best effort.
	}
}
