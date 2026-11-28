<script lang="ts">
	import { HourGrid, type HourGridProps } from '@yesid/ui/chart';
	import { GOOD_TO_BAD_LEVELS, goodToBadStep } from './goodToBadScale';

	import ChartDetails from './chart/ChartDetails.svelte';
	import type { ChartDatumPopoverModel } from './chart/useChartDatumPopover.svelte';

	let { readings, ...props }: HourGridProps & { readings: readonly ChartDatumPopoverModel[] } =
		$props();
	// The kit's HourGrid reads these tokens for both its measured cells and legend swatches.
	const palette = GOOD_TO_BAD_LEVELS.map((level) => {
		const { fill, ink } = goodToBadStep(level);
		return `--dataviz-heatmap-neutral-${level}:${fill};--dataviz-heatmap-neutral-ink-${level}:${ink}`;
	}).join(';');
</script>

<div class="min-w-0 [&_ul[role=list]_[data-level]]:min-h-[16px]" style={palette}>
	<ChartDetails label={props.label} {readings} targets="tbody td">
		<HourGrid {...props} />
	</ChartDetails>
</div>
