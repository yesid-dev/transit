<script lang="ts">
	import type { Snippet } from 'svelte';
	import { fetchCaptureSnapshot, type CaptureSnapshot } from './captureSnapshot.ts';

	let {
		city,
		capture,
		children,
		pending,
	}: {
		city: string | null;
		capture: Promise<CaptureSnapshot | null>;
		children: Snippet<[CaptureSnapshot | null, number]>;
		pending: Snippet;
	} = $props();
	let refreshed = $state<{
		seed: typeof capture;
		snapshot: CaptureSnapshot | null;
		receivedAt: number;
	}>();

	$effect(() => {
		if (!city) return;
		const currentCity = city;
		const seed = capture;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		async function refresh() {
			const snapshot = await fetchCaptureSnapshot(currentCity, controller.signal).catch(() => null);
			if (controller.signal.aborted) return;
			refreshed = { seed, snapshot, receivedAt: Date.now() };
			timer = setTimeout(refresh, 20_000);
		}
		void seed.then(() => {
			if (!controller.signal.aborted) timer = setTimeout(refresh, 20_000);
		});
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	});
</script>

{#if refreshed?.seed === capture}
	{@render children(refreshed.snapshot, refreshed.receivedAt)}
{:else}
	{#await capture}
		{@render pending()}
	{:then snapshot}
		{@render children(snapshot, Date.now())}
	{/await}
{/if}
