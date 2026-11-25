<script lang="ts">
	import { Card } from '@yesid/ui/card';
	import { ChevronToggle, Stamp, type StampProps } from '@yesid/ui/brand';
	import * as Collapsible from '@yesid/ui/collapsible';
	import { Separator } from '@yesid/ui/separator';
	import type { Snippet } from 'svelte';

	let {
		title,
		disclosure,
		stamp,
		footer,
		children,
		expandable = false,
		open = $bindable(),
		compactPrint = false,
		fill = false,
		interactive = false,
		edge,
	}: {
		title: string;
		disclosure?: { id: string; description?: string; nested?: boolean; initiallyOpen?: boolean };
		stamp?: StampProps;
		footer?: Snippet;
		children: Snippet;
		expandable?: boolean;
		open?: boolean;
		compactPrint?: boolean;
		fill?: boolean;
		interactive?: boolean;
		compact?: boolean;
		edge?: 'brand' | 'neutral';
	} = $props();
	const id = $props.id();
	const expanded = $derived(open ?? (disclosure ? !!disclosure.initiallyOpen : true));
</script>

{#snippet cardFooter()}
	{#if footer}
		<footer
			class="relative -mx-4 flex flex-wrap gap-x-4 gap-y-2 px-4 pt-3 sm:-mx-6 sm:px-6 print:mx-0 print:px-0 print:pt-0"
		>
			<Separator variant="hand-drawn" class="absolute inset-x-0 -top-[4px] print:hidden" />
			{@render footer()}
		</footer>
	{/if}
{/snippet}

{#snippet body()}
	<div class="min-w-0" class:fill>{@render children()}</div>
	{@render cardFooter()}
{/snippet}

{#snippet header()}
	<header class="flex min-w-0 flex-wrap items-center justify-between gap-2">
		<h2 {id} class:expandable-title={expandable}>
			{#if expandable}
				<Collapsible.Trigger class="flex min-h-11 min-w-11 items-center gap-2 text-left">
					<ChevronToggle open={expanded} size="sm" />
					{title}
				</Collapsible.Trigger>
			{:else}{title}{/if}
		</h2>
		{#if stamp}<Stamp {...stamp} />{/if}
	</header>
{/snippet}

{#snippet content()}
	<article
		aria-labelledby={id}
		data-slot="record-card"
		class:nested={disclosure?.nested}
		class:expandable={expandable && !disclosure}
		class:compact-print={compactPrint}
	>
		{#if disclosure}
			{#if disclosure.nested}
				<Separator variant="hand-drawn" class="absolute inset-x-0 -top-[4px] print:hidden" />
			{/if}
			<div id={disclosure.id} class="record-disclosure" data-record-disclosure data-open={expanded}>
				<Collapsible.Root open={expanded} onOpenChange={(value) => (open = value)}>
					<Collapsible.Trigger class="grid min-h-11 w-full content-center gap-2 text-left">
						<span {id} class="disclosure-title">
							<span>{title}</span><ChevronToggle open={expanded} class="ms-auto" />
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
					<div class="disclosure min-w-0" class:fill>{@render children()}</div>
				</Collapsible.Content>
			</Collapsible.Root>
			{#if expanded}{@render cardFooter()}{/if}
		{:else}
			{@render header()}
			{@render body()}
		{/if}
	</article>
{/snippet}

<!-- Pass interactive for cards with links or controls. Put links, evidence and switches in footer. -->
{#if disclosure?.nested}
	{@render content()}
{:else}
	<Card
		{edge}
		interactive={interactive || expandable || !!disclosure}
		textSize="inherit"
		class={['min-w-0 px-4 sm:px-6', compactPrint && 'print:p-2']}
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
		gap: var(--space-card-gap);
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
	footer:not(:has(> :nth-child(2))) {
		display: none;
	}
	.disclosure {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: var(--space-card-gap);
		margin-block-start: var(--space-card-gap);
	}
	.expandable {
		container-type: inline-size;
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
