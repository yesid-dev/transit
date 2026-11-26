<script lang="ts">
	import type { CaptureSnapshot } from './captureSnapshot.ts';
	import LiveCapture from './LiveCapture.svelte';

	let { capture }: { capture: Promise<CaptureSnapshot | null> } = $props();
</script>

<LiveCapture city="stm" {capture}>
	{#snippet pending()}<p>pending</p>{/snippet}
	{#snippet children(_snapshot, _now, refreshed)}<p>{refreshed ? 'refreshed' : 'seed'}</p>{/snippet}
</LiveCapture>
