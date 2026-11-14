<script lang="ts">
	import type { LiveStore } from '#lib/v1/live/store.svelte.ts';
	import { outOfServiceCount, vehicleServiceCopy } from '#lib/v1/live/vehicleService.ts';
	import type { Locale } from '#lib/i18n/index.ts';
	let { live, locale }: { live: LiveStore | null; locale: Locale } = $props();
	const count = $derived(live?.vehicles ? outOfServiceCount(live.vehicles.vehicles) : null);
</script>

<!-- Unknown until the vehicles snapshot loads: show nothing rather than a bare dash or a zero. -->
{#if count !== null}
	<p>{vehicleServiceCopy[locale].count} {count}</p>
{/if}
