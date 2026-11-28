import type { Attachment } from 'svelte/attachments';

type Size = 'clientWidth' | 'clientHeight';
type Listener = () => void;

// One observer for every measured element, as Svelte's own size bindings share one.
const listeners = new WeakMap<Element, Set<Listener>>();
let observer: ResizeObserver | undefined;

function shared() {
	return (observer ??= new ResizeObserver((entries) => {
		for (const entry of entries)
			for (const listener of listeners.get(entry.target) ?? []) listener();
	}));
}

/**
 * Reports an element's `clientWidth` or `clientHeight`, like `bind:clientWidth`, but only from
 * the resize observer. The observer runs after layout and before paint, so reading the size there
 * costs no extra layout, and the first painted frame already has it. `bind:` also reads the size
 * while the page hydrates, which makes the browser lay out the page early, once per binding.
 */
export function observedSize(size: Size, set: (value: number) => void): Attachment<HTMLElement> {
	return (element) => {
		if (typeof ResizeObserver === 'undefined') {
			set(element[size]);
			return;
		}
		const listener = () => set(element[size]);
		const own = listeners.get(element) ?? new Set();
		own.add(listener);
		listeners.set(element, own);
		shared().observe(element, { box: 'border-box' });
		return () => {
			own.delete(listener);
			if (own.size) return;
			listeners.delete(element);
			observer?.unobserve(element);
		};
	};
}
