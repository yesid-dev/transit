import { untrack } from 'svelte';

/**
 * Keeps a page region still while its first record loads. Until `loading()` first turns false,
 * `active` is true: the region lays out a gauge (the record at its fullest published shape,
 * drawn invisibly) and `measure` records its height and width: when the region mounts, before
 * the render that swaps in the record, and on every later resize while the gauge shows (a
 * ResizeObserver's first report can come after the swap on a fresh page). From the render in which the
 * real record replaces the gauge, `minHeight` holds that height, so a shorter record leaves room
 * rather than pulling up what lies below. Only the reader ends the hold: a pointer or key press,
 * a wheel or touch scroll, or a change of the region's width (its gauge height no longer
 * applies). Events the browser fires on its own, such as a scroll or a resize while it settles
 * the page, do not. Later loads, such as another date the reader picks, keep the page's usual
 * states.
 */
export function createGaugeHold(loading: () => boolean) {
	let landed = $state(false);
	let reserve = $state(0);
	let holding = $state(true);
	let region: HTMLElement | null = null;
	let width = 0;
	const record = (box: DOMRect) => {
		reserve = box.height;
		width = box.width;
	};
	const active = $derived(!landed && loading());
	const held = $derived(!loading() && holding && reserve > 0);
	// Runs before the record replaces the gauge in the page, so the gauge is still there to measure.
	$effect.pre(() => {
		if (!loading() && untrack(() => !landed) && region) record(region.getBoundingClientRect());
	});
	$effect(() => {
		if (!loading()) landed = true;
	});
	$effect(() => {
		if (!held) return;
		const release = () => (holding = false);
		const events = ['pointerdown', 'keydown', 'wheel', 'touchmove'] as const;
		for (const type of events)
			window.addEventListener(type, release, { capture: true, passive: true });
		return () => {
			for (const type of events) window.removeEventListener(type, release, { capture: true });
		};
	});
	return {
		/** True while the first record loads: the region shows its gauge. */
		get active() {
			return active;
		},
		/** Action for the held region: records the gauge's size, and ends the hold on a new width. */
		measure(node: HTMLElement) {
			region = node;
			if (active) record(node.getBoundingClientRect());
			const observer = new ResizeObserver(() => {
				const box = node.getBoundingClientRect();
				if (active) record(box);
				else if (holding && width > 0 && box.width !== width) holding = false;
			});
			observer.observe(node);
			return {
				destroy: () => {
					observer.disconnect();
					if (region === node) region = null;
				},
			};
		},
		/** True after the first record arrived while the page still keeps the gauge's room. */
		get held() {
			return held;
		},
		get minHeight(): string | undefined {
			return held ? `${reserve}px` : undefined;
		},
	};
}

/**
 * Text of a gauge, unreadable as data: every capital becomes "M", every other letter "n" and
 * every digit "0", while spaces and punctuation stay, so the filler wraps like the text it
 * stands for. Gauges are hidden, but their HTML still reaches readers without scripts.
 */
export function gaugeFiller(text: string): string {
	return text
		.replace(/\p{Ll}/gu, 'n')
		.replace(/\p{Lu}/gu, 'M')
		.replace(/\d/g, '0');
}
