<script lang="ts">
	import { Skeleton } from '@yesid/ui/skeleton';
	import { onMount } from 'svelte';
	import type { Locale } from '#lib/i18n/index.ts';
	import { getRecordPatience } from './recordPatience.ts';
	import { cardWaitingWords, STILL_CALCULATING_MS, type RecordWaiting } from './recordWaiting.ts';
	import RecordSkeleton from './RecordSkeleton.svelte';

	let {
		locale,
		busy = false,
		answer,
		shape,
	}: {
		locale: Locale;
		busy?: boolean;
		answer?: Promise<{ kind: string }>;
		/** The final shape of the card body. Without one, one pulsing text line. */
		shape?: RecordWaiting;
	} = $props();
	const register = getRecordPatience();
	let late = $state(false);
	onMount(() => {
		const timer = setTimeout(() => (late = true), STILL_CALCULATING_MS);
		return () => clearTimeout(timer);
	});
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
	// Waiting, slow and busy share one skeleton; only these words change.
	const words = $derived(
		busy ? cardWaitingWords.busy[locale] : late ? cardWaitingWords.still[locale] : '',
	);
</script>

<!-- The shape, then a foot line kept for the words from the first frame, so nothing moves when
     they appear and they never cover a bar. Without a shape the foot line pulses until the words
     take its place. Screens with a RecordPatience region announce once for every card. -->
<div
	class="record-pending"
	class:plain-answer={!shape}
	aria-busy="true"
	data-record-pending={busy ? undefined : ''}
	data-record-busy={busy ? '' : undefined}
>
	{#if shape}<RecordSkeleton {shape} />{/if}
	<div
		class="pending-words"
		role={register ? undefined : 'status'}
		data-slot="record-pending-words"
	>
		{#if words}{words}{:else if !shape}<Skeleton class="h-4 w-48 max-w-full" />{/if}
	</div>
</div>

<style>
	.record-pending {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		align-content: start;
		/* pendingFootRem.gap */
		gap: 0.5rem;
		min-inline-size: 0;
	}
	.pending-words {
		display: flex;
		align-items: center;
		/* pendingFootRem.wide: one line of small text */
		min-block-size: 1.375rem;
		max-inline-size: var(--measure-body);
		margin: 0;
		font-size: var(--text-small);
		line-height: 1.375rem;
		color: var(--muted-foreground);
	}
	/* pendingFootRem.phone: the busy sentence takes two lines on a phone. */
	@media (max-width: 39.999rem) {
		.pending-words {
			min-block-size: 2.75rem;
		}
	}
	/* Older answer slots participate before they opt into a specific skeleton. */
	:global([data-slot='screen-answer']) > .plain-answer {
		min-block-size: 15rem;
	}
	@media (max-width: 39.999rem) {
		:global([data-slot='screen-answer']) > .plain-answer {
			min-block-size: 18.5rem;
		}
	}
	/* On a desktop an answer is two rows: the figure with its stamp and actions, then one context line. */
	@media (min-width: 80rem) {
		:global([data-slot='screen-answer']) > .plain-answer {
			min-block-size: 7rem;
		}
	}
</style>
