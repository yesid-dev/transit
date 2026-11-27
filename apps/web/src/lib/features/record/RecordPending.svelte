<script lang="ts">
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

<!-- The words sit over the foot of the shape, so the card keeps the shape's height when they
     appear. Screens with a RecordPatience region announce once for every card. -->
<div
	class="record-pending"
	class:plain-answer={!shape}
	aria-busy="true"
	data-record-pending={busy ? undefined : ''}
	data-record-busy={busy ? '' : undefined}
>
	<RecordSkeleton shape={shape ?? 'line'} />
	<p
		class="pending-words"
		class:shown={!!words}
		role={register ? undefined : 'status'}
		data-slot="record-pending-words"
	>
		{words}
	</p>
</div>

<style>
	.record-pending {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		min-inline-size: 0;
	}
	.record-pending > :global(*) {
		grid-area: 1 / 1;
	}
	.pending-words {
		align-self: end;
		justify-self: start;
		max-inline-size: 100%;
		margin: 0;
		font-size: var(--text-small);
		color: var(--muted-foreground);
	}
	.pending-words.shown {
		padding-block: 0.125rem;
		padding-inline-end: 0.5rem;
		/* A screen that waits outside a card sets its own surface. */
		background: var(--record-pending-surface, var(--card));
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
	@media (min-width: 80rem) {
		:global([data-slot='screen-answer']) > .plain-answer {
			min-block-size: 10rem;
		}
	}
</style>
