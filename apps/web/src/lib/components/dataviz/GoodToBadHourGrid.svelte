<script lang="ts">
	import { HourGrid, type HourGridProps } from '@yesid/ui/chart';
	import { GOOD_TO_BAD_LEVELS, goodToBadStep } from './goodToBadScale';

	import ChartDetails from './chart/ChartDetails.svelte';
	import type { ChartDatumPopoverModel } from './chart/useChartDatumPopover.svelte';

	let {
		readings,
		scrollCue,
		...props
	}: HourGridProps & {
		readings: readonly ChartDatumPopoverModel[];
		/** Said under the grid only while it is wider than its card and scrolls sideways. */
		scrollCue?: string;
	} = $props();
	// The kit's HourGrid reads these tokens for both its measured cells and legend swatches.
	const palette = GOOD_TO_BAD_LEVELS.map((level) => {
		const { fill, ink } = goodToBadStep(level);
		return `--dataviz-heatmap-neutral-${level}:${fill};--dataviz-heatmap-neutral-ink-${level}:${ink}`;
	}).join(';');
	let scrolls = $state(false);

	function measureScroll(root: HTMLElement) {
		if (typeof ResizeObserver === 'undefined') return;
		const check = () => {
			const table = root.querySelector('table');
			const frame = table?.parentElement;
			scrolls = Boolean(frame && frame.scrollWidth > frame.clientWidth + 1);
		};
		const observer = new ResizeObserver(check);
		observer.observe(root);
		check();
		return () => observer.disconnect();
	}
</script>

<div
	class="good-to-bad-grid min-w-0 [&_ul[role=list]_[data-level]]:min-h-[16px]"
	style={palette}
	{@attach measureScroll}
>
	<ChartDetails label={props.label} {readings} targets="tbody td">
		<HourGrid {...props} />
	</ChartDetails>
	{#if scrollCue && scrolls}
		<p class="mt-2 text-small text-muted-foreground" data-slot="grid-scroll-cue">{scrollCue}</p>
	{/if}
</div>
