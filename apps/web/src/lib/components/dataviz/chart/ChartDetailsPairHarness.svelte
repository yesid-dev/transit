<script lang="ts">
	import ChartDetails from './ChartDetails.svelte';

	const readings = (name: string) =>
		[0, 1].map((index) => ({
			key: `${name}-${index}`,
			heading: `${name} ${index}`,
			rows: [{ label: 'Share', value: `${index}%` }],
		}));
</script>

{#each ['Upper', 'Lower'] as name (name)}
	<ChartDetails label={name} readings={readings(name)}>
		<svg role="img" aria-label={name}>
			<rect data-chart-datum="0" width="4" height="4" />
			<rect data-chart-datum="1" x="8" width="4" height="4" />
		</svg>
	</ChartDetails>
{/each}
