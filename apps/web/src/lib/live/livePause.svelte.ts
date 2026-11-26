/**
 * The visitor's "Pause live updates" choice (WCAG 2.2.2). While it is on, Live views stop their
 * timed refresh, the ticking "updated N s ago" stamps and the map's vehicle motion; the manual
 * Refresh still works. The choice lasts for the tab (sessionStorage), so it holds while the
 * visitor moves between Live screens. Storage may be blocked: the switch then still works for the
 * page in view.
 */
const STORAGE_KEY = 'transit:live-updates-paused';
const EVENT = 'transit:live-pause';

let paused = $state(false);
let restored = false;

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
		if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT));
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
		paused = false;
		restored = false;
	},
};
