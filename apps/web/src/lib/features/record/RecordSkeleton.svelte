<script lang="ts" module>
	export type RecordWaitingShape =
		| 'answer'
		| 'reading'
		| 'facts'
		| 'bands'
		| 'band-comparison'
		| 'comparison-facts'
		| 'trend'
		| 'table'
		| 'card'
		| 'listing';
</script>

<script lang="ts">
	import { Skeleton } from '@yesid/ui/skeleton';

	let { shape }: { shape: RecordWaitingShape } = $props();
</script>

{#snippet comparisonFacts()}
	{#each [1, 2] as row (row)}
		<div class="grid min-h-20 grid-cols-[2fr_1fr] items-center gap-4">
			<div class="grid min-w-0 gap-2">
				<Skeleton class="h-4 w-full" />
				<Skeleton class="h-4 w-3/4" />
			</div>
			<Skeleton class="h-5 w-16 max-w-full justify-self-end" />
		</div>
	{/each}
{/snippet}

<div class="waiting-shape" data-waiting-shape={shape} aria-hidden="true">
	{#if shape === 'answer' || shape === 'reading'}
		<div class="answer-reading">
			<div class="answer-statement">
				<Skeleton class="h-12 w-32 max-w-full" />
				<Skeleton class="h-5 w-96 max-w-full" />
			</div>
			<Skeleton class="h-7 w-56 max-w-full" />
			<!-- An answer carries one evidence line ("Counted: …"); versions are never on screen. -->
			<div class="grid gap-2">
				<Skeleton class="h-4 w-72 max-w-full" />
				{#if shape === 'reading'}<Skeleton class="h-4 w-60 max-w-full" />{/if}
			</div>
		</div>
		{#if shape === 'answer'}
			<div class="flex flex-wrap gap-2">
				{#each [1, 2, 3] as action (action)}
					<Skeleton class="h-11 w-24 max-w-full" />
				{/each}
			</div>
		{/if}
	{:else if shape === 'trend'}
		<Skeleton class="h-[clamp(12rem,26vw,17rem)] w-full rounded-lg" />
		<Skeleton class="h-4 w-48 max-w-full" />
	{:else if shape === 'table' || shape === 'listing'}
		{#if shape === 'listing'}
			<Skeleton class="h-12 w-32 max-w-full" />
			<Skeleton class="h-5 w-72 max-w-full" />
		{/if}
		<Skeleton class="h-8 w-full" />
		{#each Array.from({ length: shape === 'listing' ? 8 : 4 }, (_, row) => row) as row (row)}
			<div class="grid h-11 grid-cols-[2fr_1fr] items-center gap-4">
				<Skeleton class="h-4 w-full" />
				<Skeleton class="h-4 w-2/3 justify-self-end" />
			</div>
		{/each}
	{:else if shape === 'bands' || shape === 'band-comparison'}
		<Skeleton class="h-7 w-full" />
		{#each [1, 2, 3] as row (row)}
			<div class="grid h-9 grid-cols-[2fr_1fr] items-center gap-4">
				<Skeleton class="h-4 w-3/4" />
				<Skeleton class="h-4 w-2/3 justify-self-end" />
			</div>
		{/each}
		{#if shape === 'band-comparison'}
			<div class="mt-3 grid min-w-0 gap-2">
				<Skeleton class="h-4 w-full" />
				<Skeleton class="h-4 w-3/4" />
				<Skeleton class="mt-2 h-5 w-64 max-w-full" />
				{@render comparisonFacts()}
				<div class="flex flex-wrap justify-between gap-2 pt-4">
					<Skeleton class="h-4 w-48 max-w-full" />
					<Skeleton class="h-4 w-32 max-w-full" />
				</div>
			</div>
		{/if}
	{:else if shape === 'comparison-facts'}
		{@render comparisonFacts()}
	{:else if shape === 'facts'}
		{#each [1, 2, 3] as row (row)}
			<div class="grid h-11 grid-cols-[2fr_1fr] items-center gap-4">
				<Skeleton class="h-4 w-3/4" />
				<Skeleton class="h-5 w-2/3 justify-self-end" />
			</div>
		{/each}
	{:else}
		<Skeleton class="h-8 w-40 max-w-full" />
		<Skeleton class="h-5 w-full" />
		<Skeleton class="h-5 w-3/4" />
	{/if}
</div>

<style>
	.waiting-shape {
		container-type: inline-size;
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		min-inline-size: 0;
		gap: 0.5rem;
	}
	[data-waiting-shape='answer'],
	[data-waiting-shape='reading'] {
		gap: 0.75rem;
	}
	[data-waiting-shape='listing'] {
		align-content: start;
		min-block-size: min(42rem, calc(100dvh - var(--app-frame-header-height, 0px)));
	}
	.answer-reading,
	.answer-statement {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		min-inline-size: 0;
		gap: 0.75rem;
	}
	@media (min-width: 40rem) {
		@container (min-width: 26rem) {
			.answer-statement {
				display: flex;
				align-items: end;
				gap: 1rem;
			}
		}
	}
	@media (min-width: 80rem) {
		[data-waiting-shape='answer'] {
			grid-template-columns: minmax(0, 1fr) auto;
		}
	}
</style>
