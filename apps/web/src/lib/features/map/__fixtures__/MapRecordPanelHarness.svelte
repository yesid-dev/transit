<script lang="ts">
	import type { ComponentProps } from 'svelte';
	import MapRecordPanel from '../MapRecordPanel.svelte';

	let props: Omit<ComponentProps<typeof MapRecordPanel>, 'children'> = $props();
</script>

<MapRecordPanel {...props}>
	{#snippet children(content, headline)}
		<p data-testid="record-headline">{headline ?? ''}</p>
		{@render content?.(undefined)}
	{/snippet}
</MapRecordPanel>
