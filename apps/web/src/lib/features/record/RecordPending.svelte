<script lang="ts">
	import { onMount } from 'svelte';
	import type { Locale } from '#lib/i18n/index.ts';

	const PATIENCE_DELAY_MS = 3_000;
	let { locale }: { locale: Locale } = $props();
	let slow = $state(false);

	onMount(() => {
		const timer = setTimeout(() => (slow = true), PATIENCE_DELAY_MS);
		return () => clearTimeout(timer);
	});
</script>

<p role="status">
	{#if slow}
		{locale === 'fr'
			? 'Le calcul est toujours en cours. Vous pouvez attendre ou revenir plus tard.'
			: 'Still working on this. You can wait or come back later.'}
	{:else}
		{locale === 'fr' ? 'Calcul en cours…' : 'Calculating…'}
	{/if}
</p>
