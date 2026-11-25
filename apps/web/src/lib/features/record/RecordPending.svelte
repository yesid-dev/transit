<script lang="ts">
	import { onMount } from 'svelte';
	import type { Locale } from '#lib/i18n/index.ts';
	import { getRecordPatience } from './recordPatience.ts';
	import RecordSkeleton, { type RecordWaitingShape } from './RecordSkeleton.svelte';

	let {
		locale,
		busy = false,
		answer,
		shape,
	}: {
		locale: Locale;
		busy?: boolean;
		answer?: Promise<{ kind: string }>;
		shape?: RecordWaitingShape;
	} = $props();
	const register = getRecordPatience();
	onMount(() => {
		const release = register?.(busy);
		if (!release) return;
		let done = false;
		function finish(success?: boolean) {
			if (done) return;
			done = true;
			release?.(success);
		}
		void answer?.then(
			(result) => finish(result.kind === 'answer'),
			() => finish(false),
		);
		// An await block may unmount before the promise's other listeners have run.
		return () => queueMicrotask(finish);
	});
</script>

<div
	class={shape && !busy ? 'grid min-w-0 gap-2' : 'contents'}
	class:plain-answer={!shape && !busy}
	data-record-pending={busy ? undefined : ''}
>
	{#if shape && !busy}<RecordSkeleton {shape} />{/if}
	<p role={register ? undefined : 'status'}>
		{#if busy}
			{locale === 'fr' ? 'Lecture en attente.' : 'Waiting for a reading.'}
		{:else}
			{locale === 'fr' ? 'Calcul en cours…' : 'Calculating…'}
		{/if}
	</p>
</div>

<style>
	/* Older answer slots participate before they opt into a specific skeleton. */
	:global([data-slot='screen-answer']) > .plain-answer {
		display: block;
		min-block-size: 15rem;
	}
	@media (max-width: 39.999rem) {
		:global([data-slot='screen-answer']) > .plain-answer {
			min-block-size: 18.5rem;
		}
	}
	@media (min-width: 80rem) {
		:global([data-slot='screen-answer']) > .plain-answer {
			min-block-size: 10rem;
		}
	}
</style>
