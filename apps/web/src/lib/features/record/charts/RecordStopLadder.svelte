<script lang="ts">
	import { StopLadder, type StopLadderProps, type StopLadderStop } from '@yesid/ui/chart';
	import ChartDetails from '#lib/components/dataviz/chart/ChartDetails.svelte';

	let props: Omit<StopLadderProps, 'stops'> & {
		stops: readonly (StopLadderStop & { sample?: string })[];
	} = $props();
	const readings = $derived(
		props.stops.map((stop) => ({
			key: stop.id,
			heading: stop.name,
			rows: [
				{ label: props.columns.value, value: stop.state ?? stop.valueLabel },
				...(stop.sample ? [{ label: '', value: stop.sample }] : []),
			],
		})),
	);
</script>

<ChartDetails label={props.label} {readings} targets="[data-slot='stop-ladder'] li">
	<StopLadder {...props} />
</ChartDetails>
