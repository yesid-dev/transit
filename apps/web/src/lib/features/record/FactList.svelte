<script lang="ts">
	import type { Snippet } from 'svelte';

	let { children, class: className }: { children: Snippet; class?: string } = $props();
</script>

<!-- Use up to five FactRow children for different readings. Repeated records belong in a table. -->
<dl class={['facts min-w-0', className]} data-slot="fact-list">
	{@render children()}
</dl>

<style>
	.facts {
		container-type: inline-size;
	}
</style>
