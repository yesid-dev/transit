<script lang="ts">
	import type { CaptureSnapshot } from './captureSnapshot.ts';
	import LiveCapture from './LiveCapture.svelte';

	let { city, capture }: { city: string; capture: Promise<CaptureSnapshot | null> } = $props();
</script>

<LiveCapture {city} {capture}>
	{#snippet pending()}<p>pending</p>{/snippet}
	{#snippet children(_snapshot, _now, refreshed)}<p>{refreshed ? 'refreshed' : 'seed'}</p>{/snippet}
</LiveCapture>
