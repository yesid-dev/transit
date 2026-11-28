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
	{:else}
		{@render children()}
	{/if}
</div>

<style>
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
