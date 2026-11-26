/**
 * The visitor's "Pause live updates" choice (WCAG 2.2.2). While it is on, Live views stop their
 * timed refresh, the ticking "updated N s ago" stamps and the map's vehicle motion; the manual
 * Refresh still works. The choice lasts for the tab (sessionStorage), so it holds while the
 * visitor moves between Live screens. Storage may be blocked: the switch then still works for the
 * page in view.
 */
import { createSubscriber } from 'svelte/reactivity';

const STORAGE_KEY = 'transit:live-updates-paused';
const EVENT = 'transit:live-pause';

// A plain module (no runes), so pure formatters and Node tooling can import it; reading
// `paused` inside a Svelte effect or template still subscribes to changes.
let paused = false;
let restored = false;
const redraws = new Set<() => void>();
const track = createSubscriber((update) => {
	redraws.add(update);
	return () => redraws.delete(update);
});

function changed() {
	for (const redraw of redraws) redraw();
	if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT));
}

function storage(): Storage | null {
	try {
		return typeof sessionStorage === 'undefined' ? null : sessionStorage;
	} catch {
		return null;
	}
}

export const livePause = {
	/** Always false on the server and until `restore` runs after hydration. */
	get paused() {
		track();
		return paused;
	},
	set(value: boolean) {
		restored = true;
		if (paused === value) return;
		paused = value;
		try {
			if (value) storage()?.setItem(STORAGE_KEY, '1');
			else storage()?.removeItem(STORAGE_KEY);
		} catch {
			// Blocked storage keeps the choice for this page only.
		}
		changed();
	},
	/** Reads the tab's choice once, after hydration, so server and client first render agree. */
	restore() {
		if (restored) return;
		restored = true;
		let stored: boolean;
		try {
			stored = storage()?.getItem(STORAGE_KEY) === '1';
		} catch {
			stored = false;
		}
		if (stored) this.set(true);
	},
	/** Calls `listener` whenever the choice changes; returns the unsubscribe. */
	listen(listener: () => void): () => void {
		if (typeof window === 'undefined') return () => {};
		window.addEventListener(EVENT, listener);
		return () => window.removeEventListener(EVENT, listener);
	},
	/** For tests: forget the choice and the restore. */
	reset() {
		restored = false;
		if (!paused) return;
		paused = false;
		changed();
	},
};
