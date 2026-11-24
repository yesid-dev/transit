import { SvelteMap } from 'svelte/reactivity';

const activeCaptures = new SvelteMap<() => string | null, string>();

export function registerLiveSourceDate(city: string, read: () => string | null): () => void {
	activeCaptures.set(read, city);
	return () => activeCaptures.delete(read);
}

export function liveSourceDate(city: string): string | null {
	let latest: string | null = null;
	for (const [read, provider] of activeCaptures) {
		if (provider !== city) continue;
		const date = read();
		if (date && (!latest || date > latest)) latest = date;
	}
	return latest;
}
