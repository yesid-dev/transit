/**
 * Keeps a page region still while its first record loads. Until `loading()` first turns false,
 * `active` is true: the region lays out a gauge (the record at its fullest published shape,
 * drawn invisibly) and `measure` records its height. When the real record replaces the gauge,
 * `minHeight` holds that height, so a shorter record leaves room rather than pulling up what
 * lies below. The hold ends when the reader acts (a pointer or key press, or a scroll) or the
 * viewport width changes: the page then moves because of them, not because data arrived. Later
 * loads, such as another date the reader picks, are the reader's own and keep the page's usual
 * states.
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
		window.addEventListener('scroll', release, { passive: true });
		return () => {
			window.removeEventListener('pointerdown', release, true);
			window.removeEventListener('keydown', release, true);
			window.removeEventListener('resize', resize);
			window.removeEventListener('scroll', release);
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
		/** True after the first record arrived while the page still keeps the gauge's room. */
		get held() {
			return landed && holding && reserve > 0;
		},
		get minHeight(): string | undefined {
			return this.held ? `${reserve}px` : undefined;
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
