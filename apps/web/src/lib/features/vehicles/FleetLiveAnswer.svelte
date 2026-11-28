<script lang="ts">
	import { Skeleton } from '@yesid/ui/skeleton';
	import type { Snippet } from 'svelte';
	import type { Locale } from '#lib/i18n/index.ts';
	import RecordPending from '../record/RecordPending.svelte';

	let {
		locale,
		pending,
		withAction = false,
		embedded = false,
		children,
	}: {
		locale: Locale;
		pending: boolean;
		withAction?: boolean;
		embedded?: boolean;
		children: Snippet;
	} = $props();
</script>

<div
	class="live-answer"
	class:with-action={withAction}
	class:embedded-ready={embedded && !pending}
	class:embedded-pending={embedded && pending}
	data-slot={embedded ? undefined : 'screen-answer'}
>
	{#if pending}
		<RecordPending {locale}>
			{#snippet skeleton()}
				<div class="live-reading-shape" data-waiting-shape="reading" aria-hidden="true">
					<Skeleton class="h-8 w-24 max-w-full" />
					<Skeleton class="h-4 w-64 max-w-full" />
					<Skeleton class="h-4 w-32 max-w-full" />
					{#if withAction}<Skeleton class="h-11 w-28 max-w-full min-[80rem]:h-7" />{/if}
				</div>
			{/snippet}
		</RecordPending>
		{#if embedded}
			<!-- The stamp and action columns of the title row, kept from the first frame. -->
			<span class="live-stamp-shape" aria-hidden="true"><Skeleton class="h-7 w-full" /></span>
			{#if withAction}<span class="live-action-shape" aria-hidden="true"
					><Skeleton class="h-11 w-full" /></span
				>{/if}
		{/if}
	{:else}
		{@render children()}
	{/if}
</div>

<style>
	.live-stamp-shape,
	.live-action-shape {
		display: none;
	}
	@container listing-screen (min-width: 64rem) {
		.embedded-ready,
		.embedded-pending {
			display: contents;
		}
		/* The reading waits in the statement rows; the title row keeps the stamp and action
		   columns, so the title and its subtitle do not move when the list arrives. */
		.embedded-pending > :global(.record-pending) {
			grid-column: 1 / -1;
			grid-row: 2 / -1;
			grid-template-columns: max-content minmax(0, 1fr);
			align-items: center;
			/* The figure and its sentence on one line, as the answer draws them. */
			min-block-size: 3rem;
		}
		.embedded-pending .live-reading-shape {
			min-block-size: 0;
		}
		.live-stamp-shape,
		.live-action-shape {
			display: block;
			grid-row: 1;
			align-self: center;
		}
		.live-stamp-shape {
			grid-column: 2;
			inline-size: 14.5rem;
		}
		.live-action-shape {
			grid-column: 3;
			inline-size: 9.5rem;
		}
	}

	.live-answer {
		/* Title and summary, with the live stamp on its own line on a phone. */
		--answer-height: 8.3125rem;
		--waiting-foot: 3.25rem;
		min-block-size: var(--answer-height);
	}
	.with-action {
		--answer-height: 11.8125rem;
	}
	.live-reading-shape {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-block-size: calc(var(--answer-height) - var(--waiting-foot));
	}
	@media (width >= 40rem) {
		.live-answer {
			--waiting-foot: 1.875rem;
		}
	}
	@media (width >= 80rem) {
		.live-answer {
			--answer-height: 4.3125rem;
		}
		.live-reading-shape {
			flex-direction: row;
			align-items: center;
			gap: 1rem;
		}
	}
</style>
