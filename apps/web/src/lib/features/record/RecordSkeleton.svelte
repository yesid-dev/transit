<script lang="ts" module>
	import type { RecordWaiting as Waiting } from './recordWaiting.ts';
	export type { RecordSkeletonSpec, RecordWaitingShape } from './recordWaiting.ts';
	export type RecordWaiting = Waiting;
</script>

<script lang="ts">
	import { Card } from '@yesid/ui/card';
	import { Skeleton } from '@yesid/ui/skeleton';
	import { LADDER_CAP, resolveWaiting, skeletonBlockSize } from './recordWaiting.ts';

	let { shape }: { shape: RecordWaiting } = $props();
	const s = $derived(resolveWaiting(shape));
	const blockSize = $derived(skeletonBlockSize(shape));
	const range = (length: number) => Array.from({ length }, (_, index) => index);
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

{#snippet factRows(count: number, height: 'fact' | 'band')}
	{#each range(count) as row (row)}
		<div
			class={['grid grid-cols-[2fr_1fr] items-center gap-4', height === 'fact' ? 'h-11' : 'h-9']}
		>
			<Skeleton class="h-4 w-3/4" />
			<Skeleton class="h-5 w-2/3 justify-self-end" />
		</div>
	{/each}
{/snippet}

{#snippet headerRow()}
	<div class="flex h-8 items-center justify-between gap-4">
		<Skeleton class="h-3 w-24 max-w-[40%]" />
		<Skeleton class="h-3 w-16 max-w-[30%]" />
	</div>
{/snippet}

{#snippet listRows(count: number, lines: 1 | 2, lead: 'plate' | 'code' | 'none')}
	{#each range(count) as row (row)}
		<div class="list-row" class:two-lines={lines === 2} data-lead={lead}>
			{#if lead === 'plate'}<Skeleton class="h-7 w-10" />
			{:else if lead === 'code'}<Skeleton class="h-5 w-12" />{/if}
			<div class="grid min-w-0 gap-2">
				<Skeleton class="h-4 w-3/4 max-w-60" />
				{#if lines === 2}<Skeleton class="h-3 w-1/2 max-w-44" />{/if}
			</div>
			<Skeleton class="h-5 w-16 max-w-full" />
		</div>
	{/each}
{/snippet}

<!-- aria-busy here starts the kit's pulse wherever the shape is drawn; the kit stops it under
     reduced motion. The blocks stay hidden from assistive tech: the screen's one live region speaks. -->
<div
	class="waiting-shape"
	data-waiting-shape={s.shape}
	data-waiting-count={s.shape === 'table' ? s.rows : s.count}
	aria-hidden="true"
	aria-busy="true"
	style:block-size={s.shape === 'rows' ? undefined : blockSize}
>
	{#if s.shape === 'answer' || s.shape === 'reading'}
		<!-- Laid out as RecordAnswer: the statement; the stamp and what was counted on one line; an
		     answer's actions beside the statement on a desktop, with the stamp beside them when wide. -->
		<div
			class="answer-layout"
			class:with-actions={s.shape === 'answer'}
			class:short-context={!s.comparison}
		>
			<div class="answer-statement">
				<Skeleton class="h-12 w-32 max-w-full" />
				<Skeleton class="h-5 w-96 max-w-full" />
			</div>
			<div class="answer-context">
				<div class="answer-stamp"><Skeleton class="h-7 w-56 max-w-full" /></div>
				<!-- An answer carries one evidence line ("Counted: …"); versions are never on screen. -->
				<div class="answer-evidence grid gap-2">
					<Skeleton class="h-4 w-72 max-w-full" />
					{#if s.shape === 'reading'}<Skeleton class="h-4 w-60 max-w-full" />{/if}
					{#if s.comparison}<Skeleton class="mt-3 h-4 w-80 max-w-full" />{/if}
				</div>
			</div>
			{#if s.shape === 'answer'}
				<div class="answer-actions flex flex-wrap gap-2">
					{#each [1, 2, 3] as action (action)}
						<Skeleton class="h-11 w-24 max-w-full" />
					{/each}
				</div>
			{/if}
		</div>
	{:else if s.shape === 'trend'}
		<Skeleton class="h-[clamp(12rem,26vw,17rem)] w-full rounded-lg" />
		<Skeleton class="h-4 w-48 max-w-full" />
	{:else if s.shape === 'histogram'}
		<Skeleton class="min-h-0 w-full rounded-lg" />
		<div class="flex h-4 items-center justify-between gap-4">
			{#each [1, 2, 3, 4, 5] as tick (tick)}<Skeleton class="h-3 w-8" />{/each}
		</div>
	{:else if s.shape === 'table'}
		{#if s.header}{@render headerRow()}{/if}
		{#each range(s.rows) as row (row)}
			<div class="grid h-11 grid-cols-[2fr_1fr] items-center gap-4">
				<Skeleton class="h-4 w-full" />
				<Skeleton class="h-4 w-2/3 justify-self-end" />
			</div>
		{/each}
	{:else if s.shape === 'rows'}
		{#if s.header}{@render headerRow()}{/if}
		{@render listRows(s.count, s.lines, s.lead)}
	{:else if s.shape === 'listing'}
		<Skeleton class="h-12 w-32 max-w-full" />
		<Skeleton class="h-5 w-72 max-w-full" />
		<div class="grid">
			{@render headerRow()}
			{@render listRows(8, 2, 'plate')}
		</div>
	{:else if s.shape === 'bands' || s.shape === 'band-comparison'}
		<Skeleton class="h-7 w-full" />
		{@render factRows(3, 'band')}
		{#if s.shape === 'bands'}
			<div class="grid gap-2 pt-2">
				<Skeleton class="h-4 w-full" />
				<Skeleton class="h-4 w-2/3" />
			</div>
		{:else}
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
	{:else if s.shape === 'comparison-facts'}
		{@render comparisonFacts()}
	{:else if s.shape === 'trip-facts'}
		<!-- The trips card: Scheduled and the five parts that add up to it, rows touching as in FactList. -->
		{@render factRows(6, 'fact')}
	{:else if s.shape === 'facts'}
		{@render factRows(s.count, 'fact')}
	{:else if s.shape === 'grid'}
		<!-- Weekday by hour: hour labels, seven weekday rows, then the colour legend. -->
		<div class="grid-row h-8">
			<span></span>
			<Skeleton class="h-3 w-full" />
		</div>
		{#each range(7) as day (day)}
			<div class="grid-row h-[2.1875rem]">
				<Skeleton class="h-4 w-8" />
				<Skeleton class="h-7 w-full rounded-sm" />
			</div>
		{/each}
		<div class="flex h-14 flex-wrap items-end gap-4">
			<Skeleton class="h-4 w-40 max-w-full" />
			<Skeleton class="h-4 w-24 max-w-full" />
		</div>
	{:else if s.shape === 'ladder'}
		<div class="ladder">
			<Skeleton class="ladder-rail rounded-full" />
			{#each range(Math.min(s.count, LADDER_CAP)) as stop (stop)}
				<div class="ladder-row">
					<Skeleton class="size-3 rounded-full" />
					<Skeleton class="h-4 w-1/2 max-w-64" />
					<Skeleton class="h-5 w-16 max-w-full" />
				</div>
			{/each}
		</div>
		{#if s.count > LADDER_CAP}<Skeleton class="h-11 w-32 max-w-full" />{/if}
	{:else if s.shape === 'notice'}
		{#each range(s.count) as notice (notice)}
			<div class="notice">
				<Skeleton class="h-7 w-10" />
				<div class="grid min-w-0 content-start gap-2">
					<Skeleton class="h-5 w-3/4" />
					<Skeleton class="h-4 w-full" />
					<div class="flex flex-wrap gap-2 pt-2">
						{#each [1, 2, 3] as chip (chip)}<Skeleton class="h-6 w-16 rounded-full" />{/each}
					</div>
				</div>
			</div>
		{/each}
	{:else if s.shape === 'tiles'}
		<div class="tiles" data-size={s.size}>
			{#each range(s.count) as tile (tile)}
				<Card edge="neutral" textSize="inherit" class="tile min-w-0 px-4 sm:px-6">
					<div class="grid min-w-0 content-start gap-2">
						<Skeleton class="h-5 w-1/2" />
						<Skeleton class="h-4 w-full" />
						{#if s.size === 'file'}
							<Skeleton class="h-4 w-3/4" />
							<Skeleton class="h-4 w-2/3" />
							<div class="flex flex-wrap gap-2 pt-2">
								<Skeleton class="h-11 w-24" />
								<Skeleton class="h-11 w-24" />
							</div>
						{/if}
					</div>
				</Card>
			{/each}
		</div>
	{:else if s.shape === 'line'}
		<Skeleton class="h-4 w-48 max-w-full" />
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
		align-content: start;
		min-inline-size: 0;
		gap: 0.5rem;
	}
	/* Fixed-height shapes: rows touch, as in the filled tables and fact lists, so the block
	   size of the rule is the block size drawn. */
	[data-waiting-shape='trip-facts'],
	[data-waiting-shape='facts'],
	[data-waiting-shape='table'],
	[data-waiting-shape='rows'],
	[data-waiting-shape='bands'],
	[data-waiting-shape='grid'],
	[data-waiting-shape='ladder'] {
		gap: 0;
		overflow: clip;
	}
	[data-waiting-shape='histogram'] {
		grid-template-rows: minmax(0, 1fr) auto;
	}
	[data-waiting-shape='line'] {
		align-content: center;
		min-block-size: 1lh;
	}
	[data-waiting-shape='notice'] {
		gap: 0.75rem;
	}
	[data-waiting-shape='answer'],
	[data-waiting-shape='reading'] {
		gap: 0.75rem;
	}
	[data-waiting-shape='listing'] {
		min-block-size: min(42rem, calc(100dvh - var(--app-frame-header-height, 0px)));
	}
	.answer-layout,
	.answer-statement {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		min-inline-size: 0;
		gap: 0.75rem;
	}
	.list-row {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.75rem;
		block-size: var(--record-waiting-row-height, 2.4375rem);
	}
	.list-row.two-lines {
		block-size: var(--record-waiting-row-height, 3.8125rem);
	}
	.list-row[data-lead='none'] {
		grid-template-columns: minmax(0, 1fr) auto;
	}
	.grid-row {
		display: grid;
		grid-template-columns: 3rem minmax(0, 1fr);
		align-items: center;
	}
	.ladder {
		position: relative;
		display: grid;
	}
	.ladder :global(.ladder-rail) {
		position: absolute;
		inset-block: 1.5rem;
		inset-inline-start: 0.3125rem;
		inline-size: 0.125rem;
	}
	.ladder-row {
		display: grid;
		grid-template-columns: 0.75rem minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.75rem;
		block-size: 3rem;
	}
	.notice {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 0.75rem;
		block-size: 7.9375rem;
		padding-block: 0.75rem;
		overflow: clip;
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 18rem), 1fr));
		gap: var(--space-card-gap);
	}
	.tiles[data-size='file'] {
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 24rem), 1fr));
	}
	.tiles :global(.tile) {
		block-size: 5.9375rem;
		overflow: clip;
	}
	.tiles[data-size='file'] :global(.tile) {
		block-size: 13.1875rem;
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
	.answer-layout {
		gap: 0.75rem 1.5rem;
	}
	.answer-context {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.375rem 1rem;
		min-inline-size: 0;
	}
	.answer-evidence {
		flex: 1 1 8rem;
		min-inline-size: 0;
	}
	/* As RecordAnswer: beside a short context from 36rem; under a comparison line until 52rem. */
	@container (min-width: 36rem) {
		.with-actions.short-context {
			grid-template-areas: 'statement statement' 'context actions';
			grid-template-columns: minmax(0, 1fr) auto;
		}
		.with-actions.short-context > .answer-statement {
			grid-area: statement;
		}
		.with-actions.short-context > .answer-context {
			grid-area: context;
		}
		.with-actions.short-context > .answer-actions {
			grid-area: actions;
			align-self: center;
		}
	}
	@container (min-width: 52rem) {
		.with-actions {
			grid-template-areas: 'statement actions' 'context context';
		}
		.with-actions > .answer-statement {
			grid-area: statement;
		}
		.with-actions > .answer-context {
			grid-area: context;
		}
		.with-actions > .answer-actions {
			grid-area: actions;
			align-self: center;
		}
	}
	@container (min-width: 64rem) {
		.with-actions {
			grid-template-areas: 'statement stamp actions' 'evidence evidence evidence';
			grid-template-columns: minmax(0, 1fr) auto auto;
		}
		.with-actions > .answer-context {
			display: contents;
		}
		.with-actions .answer-stamp {
			grid-area: stamp;
			align-self: center;
		}
		.with-actions .answer-evidence {
			grid-area: evidence;
		}
	}
</style>
