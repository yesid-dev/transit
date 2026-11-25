<script lang="ts">
	import { onMount } from 'svelte';
	import type { Locale } from '#lib/i18n/index.ts';
	import { getRecordPatience } from './recordPatience.ts';

	let {
		locale,
		busy = false,
		answer,
	}: {
		locale: Locale;
		busy?: boolean;
		answer?: Promise<{ kind: string }>;
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

<p role={register ? undefined : 'status'}>
	{#if busy}
		{locale === 'fr' ? 'Lecture en attente.' : 'Waiting for a reading.'}
	{:else}
		{locale === 'fr' ? 'Calcul en cours…' : 'Calculating…'}
	{/if}
</p>
