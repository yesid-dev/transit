<script lang="ts">
	import { MetricDisplay } from '@yesid/ui/brand';

	let {
		value,
		sentence,
		stacked = false,
	}: {
		value: string;
		sentence: string;
		stacked?: boolean;
	} = $props();
	const sentenceId = $props.id();
</script>

<section class="map-answer" class:stacked data-slot="screen-answer" aria-labelledby={sentenceId}>
	<MetricDisplay {value} label="" size="lg" />
	<p id={sentenceId}>{sentence}</p>
</section>

<style>
	.map-answer {
		display: flex;
		flex-wrap: wrap;
		align-items: start;
		gap: calc(var(--spacing) * 2) calc(var(--spacing) * 3);
	}
	.map-answer.stacked {
		display: grid;
	}
	p {
		margin: 0;
		flex: 1 1 8rem;
		min-width: 0;
		font-size: var(--text-body);
	}
</style>
