/**
 * Keeps a page region still while its first record loads. Until `loading()` first turns false,
 * `active` is true: the region lays out a gauge (the record at its fullest published shape,
 * drawn invisibly) and `measure` records its height. When the real record replaces the gauge,
 * `minHeight` holds that height, so a shorter record leaves room rather than pulling up what
 * lies below. The hold ends when the reader acts (a pointer or key press) or the viewport width
 * changes: the page then moves because of them, not because data arrived. Later loads, such as
 * another date the reader picks, are the reader's own and keep the page's usual states.
 */
export function createGaugeHold(loading: () => boolean) {
	let landed = $state(false);
	let reserve = $state(0);
	let holding = $state(true);
	const active = $derived(!landed && loading());
	$effect(() => {
		if (!loading()) landed = true;
	});
	$effect(() => {
		if (!landed || !holding) return;
		const width = window.innerWidth;
		const release = () => (holding = false);
		const resize = () => {
			if (window.innerWidth !== width) release();
		};
		window.addEventListener('pointerdown', release, true);
		window.addEventListener('keydown', release, true);
		window.addEventListener('resize', resize);
		return () => {
			window.removeEventListener('pointerdown', release, true);
			window.removeEventListener('keydown', release, true);
			window.removeEventListener('resize', resize);
		};
	});
	return {
		/** True while the first record loads: the region shows its gauge. */
		get active() {
			return active;
		},
		/** Action for the held region: records its height while the gauge lays it out. */
		measure(node: HTMLElement) {
			const observer = new ResizeObserver(() => {
				if (active) reserve = node.getBoundingClientRect().height;
			});
			observer.observe(node);
			return { destroy: () => observer.disconnect() };
		},
		get minHeight(): string | undefined {
			return landed && holding && reserve > 0 ? `${reserve}px` : undefined;
		},
	};
}
