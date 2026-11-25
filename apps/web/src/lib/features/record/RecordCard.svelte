<script lang="ts">
	import { Card } from '@yesid/ui/card';
	import { Stamp, type StampProps } from '@yesid/ui/brand';
	import * as Collapsible from '@yesid/ui/collapsible';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import type { Snippet } from 'svelte';

	let {
		title,
		disclosure,
		stamp,
		footer,
		children,
		expandable = false,
		open = $bindable(true),
	}: {
		title: string;
		disclosure?: { id: string; description?: string; nested?: boolean };
		stamp?: StampProps;
		footer?: Snippet;
		children: Snippet;
		expandable?: boolean;
		open?: boolean;
	} = $props();
	const id = $props.id();
</script>

{#snippet cardFooter()}
	{#if footer}<footer class="flex flex-wrap gap-x-4 gap-y-2">{@render footer()}</footer>{/if}
{/snippet}

{#snippet body()}
	<div class="min-w-0">{@render children()}</div>
	{@render cardFooter()}
{/snippet}

{#snippet header()}
	<header class="flex min-w-0 flex-wrap items-center justify-between gap-2">
		<h2 {id} class:expandable-title={expandable}>
			{#if expandable}
				<Collapsible.Trigger class="flex min-h-11 min-w-11 items-center gap-2 text-left">
					<ChevronDown class={open ? '' : '-rotate-90'} size={16} aria-hidden="true" />
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
	>
		{#if disclosure}
			<details id={disclosure.id} class="record-disclosure" data-record-disclosure>
				<summary>
					<span {id} class="disclosure-title">
						<span class="disclosure-arrow" aria-hidden="true">▸</span>{title}
					</span>
					{#if disclosure.description}<span class="disclosure-description">
							{disclosure.description}
						</span>{/if}
				</summary>
				<div class="min-w-0 pt-3">{@render children()}</div>
			</details>
			{@render cardFooter()}
		{:else if expandable}
			<Collapsible.Root bind:open>
				{@render header()}
				<Collapsible.Content><div class="disclosure">{@render body()}</div></Collapsible.Content>
			</Collapsible.Root>
		{:else}
			{@render header()}
			{@render body()}
		{/if}
	</article>
{/snippet}

{#if disclosure?.nested}
	{@render content()}
{:else}
	<Card
		edge="neutral"
		textSize="inherit"
		class={disclosure ? 'min-w-0 px-2 sm:px-6' : 'min-w-0 px-4 sm:px-6'}
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
	.record-disclosure {
		scroll-margin-block-start: var(--space-page-x);
	}
	summary {
		display: grid;
		align-content: center;
		gap: calc(var(--space-card-gap) / 2);
		min-block-size: max(44px, var(--size-tap-min));
		cursor: pointer;
		list-style: none;
	}
	summary::-webkit-details-marker {
		display: none;
	}
	summary:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
	.disclosure-title {
		display: block;
	}
	.disclosure-arrow {
		float: inline-end;
		margin-inline-start: calc(var(--space-card-gap) / 2);
		color: var(--muted-foreground);
	}
	details[open] > summary .disclosure-arrow {
		transform: rotate(90deg);
	}
	.disclosure-description {
		max-inline-size: var(--measure-body);
	}
	.nested {
		border-block-start: 1px solid var(--border);
		padding-block-start: calc(var(--space-card-gap) / 2);
	}
	.nested .disclosure-title {
		font-size: inherit;
	}
	footer {
		margin-block-start: auto;
	}
	footer:empty {
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
</style>
