<script lang="ts">
	import { Card } from '@yesid/ui/card';
	import { ChevronToggle, Stamp, type StampProps } from '@yesid/ui/brand';
	import * as Collapsible from '@yesid/ui/collapsible';
	import { Skeleton } from '@yesid/ui/skeleton';
	import { Separator } from '@yesid/ui/separator';
	import type { Snippet } from 'svelte';
	import { readRecordPageStamp } from '#lib/site/recordPageStampContext.ts';
	import RecordSkeleton from './RecordSkeleton.svelte';
	import { skeletonBlockSize, type RecordWaiting } from './recordWaiting.ts';

	let {
		title,
		titleLevel = 2,
		class: className,
		disclosure,
		stamp,
		stampPending = false,
		showsPageStamp = false,
		links,
		evidence,
		toggle,
		children,
		expandable = false,
		open = $bindable(),
		compactPrint = false,
		fill = false,
		interactive = false,
		edge,
		waiting,
		reserve,
		stampRule = false,
	}: {
		title: string;
		titleLevel?: 2 | 3;
		class?: string;
		disclosure?: {
			id: string;
			description?: string;
			nested?: boolean;
			initiallyOpen?: boolean;
			chevronBesideTitle?: boolean;
		};
		stamp?: StampProps;
		stampPending?: boolean;
		/** Marks the card that carries the page's own Record stamp. */
		showsPageStamp?: boolean;
		links?: Snippet;
		evidence?: Snippet;
		toggle?: Snippet;
		children: Snippet;
		expandable?: boolean;
		open?: boolean;
		compactPrint?: boolean;
		fill?: boolean;
		interactive?: boolean;
		edge?: 'brand' | 'neutral';
		/** The body waits as this shape, pulsing, with the title and stamp already drawn. */
		waiting?: RecordWaiting;
		/** A body that ends in a short honest state keeps this shape's height, the state on top. */
		reserve?: RecordWaiting;
		/**
		 * The stamp sits under the title whenever the card is narrower than 560 px, so two cards of a
		 * row start their bodies at the same height (holistic pass F1.2); wider, it keeps its corner.
		 */
		stampRule?: boolean;
	} = $props();
	const reservedSize = $derived(reserve ? skeletonBlockSize(reserve) : null);
	const pageStamp = readRecordPageStamp();
	const repeatedStamp = $derived(
		!showsPageStamp && stamp?.kind === 'record' && stamp.label === pageStamp(),
	);
	const id = $props.id();
	const expanded = $derived(open ?? (disclosure ? !!disclosure.initiallyOpen : true));
</script>

{#snippet cardFooter()}
	{#if links || evidence || toggle}
		<footer
			class="relative -mx-4 flex flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-3 sm:-mx-6 sm:px-6 print:mx-0 print:px-0 print:pt-0"
		>
			<Separator decorative class="absolute inset-x-0 top-0 print:hidden" />
			{#if links}
				<div
					class="foot-part flex min-w-0 basis-full flex-wrap gap-x-4 gap-y-2"
					data-slot="record-foot-links"
				>
					{@render links()}
				</div>
			{/if}
			{#if evidence}
				<div class="foot-part min-w-0 grow basis-64" data-slot="record-foot-evidence">
					{@render evidence()}
				</div>
			{/if}
			{#if toggle}
				<div class="foot-part max-w-full shrink-0" data-slot="record-foot-toggle">
					{@render toggle()}
				</div>
			{/if}
		</footer>
	{/if}
{/snippet}

{#snippet body()}
	<div
		class="min-w-0"
		class:fill
		data-slot="record-card-body"
		data-record-pending={waiting ? '' : undefined}
		aria-busy={waiting ? 'true' : undefined}
		style:min-block-size={reservedSize}
	>
		{#if waiting}<RecordSkeleton shape={waiting} />{/if}
		{@render children()}
	</div>
	{@render cardFooter()}
{/snippet}

{#snippet header()}
	<header class="flex min-w-0 flex-wrap items-center justify-between gap-2">
		<svelte:element this={titleLevel === 2 ? 'h2' : 'h3'} {id} class:expandable-title={expandable}>
			{#if expandable}
				<!-- No wrap: a long title wraps beside its chevron, never under it on a phone. -->
				<Collapsible.Trigger class="flex min-h-11 min-w-11 items-center gap-2 text-left">
					<ChevronToggle open={expanded} size="sm" class="shrink-0" />
					<span class="[overflow-wrap:normal]">{title}</span>
				</Collapsible.Trigger>
			{:else}{title}{/if}
		</svelte:element>
		{#if stamp && !repeatedStamp}<Stamp
				{...stamp}
			/>{:else if stampPending && !repeatedStamp}<Skeleton class="h-7 w-36 max-w-full" />{/if}
	</header>
{/snippet}

{#snippet content()}
	<article
		aria-labelledby={id}
		data-slot="record-card"
		class="gap-4"
		class:nested={disclosure?.nested}
		class:expandable={expandable && !disclosure}
		class:compact-print={compactPrint}
		class:stamp-rule={stampRule}
	>
		{#if disclosure}
			{#if disclosure.nested}
				<Separator decorative class="absolute inset-x-0 top-0 print:hidden" />
			{/if}
			<div id={disclosure.id} class="record-disclosure" data-record-disclosure data-open={expanded}>
				<Collapsible.Root open={expanded} onOpenChange={(value) => (open = value)}>
					<Collapsible.Trigger class="grid min-h-11 w-full content-center gap-2 text-left">
						<span {id} class="disclosure-title" class:beside-title={disclosure.chevronBesideTitle}>
							<span>{title}</span><ChevronToggle open={expanded} class="ms-auto shrink-0" />
						</span>
						{#if disclosure.description}<span class="disclosure-description">
								{disclosure.description}
							</span>{/if}
					</Collapsible.Trigger>
					<Collapsible.Content>
						<div class="min-w-0 pt-3">{@render children()}</div>
					</Collapsible.Content>
				</Collapsible.Root>
			</div>
			{@render cardFooter()}
		{:else if expandable}
			<Collapsible.Root open={expanded} onOpenChange={(value) => (open = value)}>
				{@render header()}
				<Collapsible.Content>
					<div
						class="disclosure mt-4 min-w-0 gap-4"
						class:fill
						data-slot="record-disclosure-content"
					>
						{@render children()}
					</div>
				</Collapsible.Content>
			</Collapsible.Root>
			{#if expanded}{@render cardFooter()}{/if}
		{:else}
			{@render header()}
			{@render body()}
		{/if}
	</article>
{/snippet}

<!-- Pass interactive for cards with links or controls. Use links, evidence and toggle for the card foot. -->
{#if disclosure?.nested}
	{@render content()}
{:else}
	<Card
		{edge}
		interactive={interactive || expandable || !!disclosure}
		textSize="inherit"
		class={['min-w-0 px-4 sm:px-6', compactPrint && 'print:p-2', className]}
		spread
	>
		{@render content()}
	</Card>
{/if}

<style>
	article {
		display: flex;
		flex: 1;
		flex-direction: column;
		min-inline-size: 0;
	}
	h2,
	.disclosure-title {
		margin: 0;
		font-size: var(--text-subheading);
		font-weight: 600;
	}
	.fill {
		display: flex;
		flex: 1;
		flex-direction: column;
	}
	.record-disclosure {
		scroll-margin-block-start: var(--space-page-x);
	}
	.disclosure-title {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: calc(var(--space-card-gap) / 2);
		overflow-wrap: normal;
	}
	.disclosure-title.beside-title {
		flex-wrap: nowrap;
		align-items: flex-start;
	}
	.disclosure-title.beside-title > span:first-child {
		min-inline-size: 0;
	}
	.disclosure-description {
		display: grid;
		max-inline-size: var(--measure-body);
	}
	.nested {
		position: relative;
		padding-block-start: calc(var(--space-card-gap) / 2);
	}
	.nested .disclosure-title {
		font-size: inherit;
	}
	footer {
		margin-block-start: auto;
	}
	.foot-part:empty,
	footer:not(:has(> .foot-part:not(:empty))) {
		display: none;
	}
	.disclosure {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
	}
	.expandable {
		container-type: inline-size;
	}
	.stamp-rule {
		container-type: inline-size;
	}
	/* 32rem of content is a 560 px card with its 24 px sides. */
	@container (inline-size < 32rem) {
		.stamp-rule > header {
			flex-direction: column;
			align-items: flex-start;
		}
	}
	@container (inline-size < 9rem) {
		.expandable-title {
			font-size: var(--text-small);
		}
	}
	@media print {
		.compact-print {
			gap: calc(var(--space-card-gap) / 3);
		}
	}
</style>
