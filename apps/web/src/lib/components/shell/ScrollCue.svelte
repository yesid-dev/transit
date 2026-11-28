<!--
  A soft fade at the bottom of a scrolling panel (the controls rail, the phone Controls sheet) while
  more of it is out of sight below, so a control past the edge is never hidden without a cue
  (closing audit G3-M5). It sticks to the panel's bottom edge, takes no room, and goes once the end
  is in view.
-->
<script lang="ts">
	let cue = $state<HTMLElement>();
	let more = $state(false);

	function scroller(from: HTMLElement) {
		for (let el = from.parentElement; el; el = el.parentElement) {
			const { overflowY } = getComputedStyle(el);
			if (overflowY === 'auto' || overflowY === 'scroll') return el;
		}
		return null;
	}

	$effect(() => {
		const panel = cue && scroller(cue);
		if (!panel) return;
		const update = () => {
			more = panel.scrollTop + panel.clientHeight < panel.scrollHeight - 1;
		};
		update();
		panel.addEventListener('scroll', update, { passive: true });
		const resize = new ResizeObserver(update);
		resize.observe(panel);
		for (const child of panel.children) resize.observe(child);
		return () => {
			panel.removeEventListener('scroll', update);
			resize.disconnect();
		};
	});
</script>

<div
	bind:this={cue}
	class="scroll-cue"
	data-slot="scroll-cue"
	data-more={more || undefined}
	aria-hidden="true"
></div>

<style>
	.scroll-cue {
		position: sticky;
		inset-block-end: 0;
		block-size: 2rem;
		/* It adds no height: it takes back its own size and the rail's gap before it. */
		margin-block-start: calc(-2rem - var(--surface-rail-gap, 0px));
		pointer-events: none;
		opacity: 0;
		background: linear-gradient(to bottom, transparent, var(--background));
	}
	.scroll-cue[data-more] {
		opacity: 1;
	}
</style>
