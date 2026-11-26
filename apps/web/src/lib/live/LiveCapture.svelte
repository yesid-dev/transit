<script lang="ts">
	import type { Snippet } from 'svelte';
	import { fetchCaptureSnapshot, type CaptureSnapshot } from './captureSnapshot.ts';
	import { livePause } from './livePause.svelte.ts';

	let {
		city,
		capture,
		children,
		pending,
	}: {
		city: string | null;
		capture: Promise<CaptureSnapshot | null>;
		children: Snippet<[CaptureSnapshot | null, number, boolean]>;
		pending: Snippet;
	} = $props();
	let refreshed = $state<{
		seed: typeof capture;
		snapshot: CaptureSnapshot | null;
		receivedAt: number;
	}>();

	// A resumed screen asks for fresh figures at once instead of waiting another 20 s.
	let resumed = false;
	$effect(() => {
		if (!city) return;
		if (livePause.paused) {
			resumed = true;
			return;
		}
		const resume = resumed;
		resumed = false;
		const currentCity = city;
		const seed = capture;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		async function refresh() {
			const snapshot = await fetchCaptureSnapshot(currentCity, controller.signal).catch(() => null);
			if (controller.signal.aborted) return;
			refreshed = { seed, snapshot, receivedAt: Date.now() };
			if (!livePause.paused) timer = setTimeout(refresh, 20_000);
		}
		void seed.then(() => {
			if (controller.signal.aborted) return;
			if (resume) void refresh();
			else timer = setTimeout(refresh, 20_000);
		});
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	});
</script>

{#await capture}
	<div class="contents" data-record-pending>
		{@render pending()}
	</div>
{:then snapshot}
	{@const latest = refreshed?.seed === capture ? refreshed : undefined}
	{@render children(
		latest ? latest.snapshot : snapshot,
		latest?.receivedAt ?? Date.now(),
		latest !== undefined,
	)}
{/await}
