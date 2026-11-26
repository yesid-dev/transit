<script lang="ts">
	import type { Snippet } from 'svelte';

	/**
	 * Shows `narrow` when this frame is at most 28rem wide (the width at which the kit's DataTable
	 * rows mode starts) and `wide` otherwise. The server renders both and a container query shows the
	 * right one, so nothing moves while the page hydrates; once the width is known the hidden one is
	 * dropped, so the page holds one copy. A frame with no width yet keeps `wide`.
	 */
	let { wide, narrow }: { wide: Snippet; narrow: Snippet } = $props();
	let layout = $state<'both' | 'wide' | 'phone'>('both');
	let frame = $state<HTMLDivElement>();
	$effect(() => {
		const element = frame;
		if (!element) return;
		const measure = () => {
			const width = element.clientWidth;
			const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
			layout = width && width <= 28 * rem ? 'phone' : 'wide';
		};
		measure();
		if (typeof ResizeObserver === 'undefined') return;
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	});
</script>

<div class="phone-switch" bind:this={frame} data-layout={layout}>
	{#if layout !== 'phone'}<div class="wide">{@render wide()}</div>{/if}
	{#if layout !== 'wide'}<div class="narrow">{@render narrow()}</div>{/if}
</div>

<style>
	.phone-switch {
		container: phone-switch / inline-size;
		min-inline-size: 0;
	}
	@container phone-switch (inline-size <= 28rem) {
		.wide {
			display: none;
		}
	}
	@container phone-switch (inline-size > 28rem) {
		.narrow {
			display: none;
		}
	}
</style>
