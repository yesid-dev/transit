<script lang="ts">
	import type { Snippet } from 'svelte';
	import {
		fetchCaptureTripScope,
		type CaptureScope,
		type CaptureTripReport,
	} from './captureSnapshot.ts';

	let {
		city,
		kind,
		id,
		seed,
		now,
		refreshed,
		children,
		pending,
	}: {
		city: string;
		kind: CaptureScope['kind'];
		id: string;
		seed: Promise<CaptureTripReport | null>;
		now: number;
		refreshed: boolean;
		children: Snippet<[CaptureTripReport | null]>;
		pending?: Snippet;
	} = $props();
	let result = $state<{ clock: number; report: CaptureTripReport | null }>();
	$effect(() => {
		if (!refreshed) return;
		const clock = now;
		const controller = new AbortController();
		void fetchCaptureTripScope(city, { kind, id }, controller.signal)
			.catch(() => null)
			.then((report) => {
				if (!controller.signal.aborted) result = { clock, report };
			});
		return () => controller.abort();
	});
</script>

{#if refreshed && result && result.clock <= now}
	{@render children(result.report)}
{:else}
	{#await seed}
		{@render pending?.()}
	{:then initial}
		{@render children(initial)}
	{/await}
{/if}
