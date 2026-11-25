<script lang="ts">
	import RecordPatience from './RecordPatience.svelte';
	import RecordPending from './RecordPending.svelte';

	let { readings }: { readings: Promise<{ kind: string }>[] } = $props();
</script>

<RecordPatience locale="en" period={{ from: '2026-11-08', to: '2026-11-14' }} scope="fixture">
	{#each readings as answer (answer)}
		{#await answer}
			<RecordPending locale="en" {answer} />
		{:then result}
			<p>{result.kind}</p>
		{/await}
	{/each}
</RecordPatience>
