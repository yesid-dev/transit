<script lang="ts">
	import { HourGrid, type HourGridProps } from '@yesid/ui/chart';
	import { measureRampInk, measureRamps } from './measureRamps';

	let props: HourGridProps = $props();
	// The kit's HourGrid reads these tokens for both its measured cells and legend swatches.
	const palette = measureRamps.lateShare
		.map(
			(colour, level) =>
				`--dataviz-heatmap-neutral-${level}:${colour};--dataviz-heatmap-neutral-ink-${level}:${measureRampInk[level]}`,
		)
		.join(';');
</script>

<div class="min-w-0 [&_ul[role=list]_[data-level]]:min-h-[16px]" style={palette}>
	<HourGrid {...props} />
</div>
