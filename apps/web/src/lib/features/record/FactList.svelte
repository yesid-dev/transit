<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		children,
		class: className,
		leading = true,
	}: { children: Snippet; class?: string; leading?: boolean } = $props();
</script>

<!-- Use up to five FactRow children for different readings. Repeated records belong in a table. -->
<dl
	class={['facts min-w-0', className]}
	data-slot="fact-list"
	style:--fact-leading={leading ? undefined : 'none'}
>
	{@render children()}
</dl>

<style>
	.facts {
		container: fact-list / inline-size;
	}
</style>
