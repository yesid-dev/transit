<script lang="ts">
	import './reliability-sections.css';

	import type { Snippet } from 'svelte';
	import { CollapsibleSection as SharedCollapsibleSection } from '@yesid/ui/brand';

	interface CollapsibleSectionProps {
		/** The section's name, as M2 writes it; the heading is the only toggle. */
		title: string;
		/** One finding in words, kept visible when the section is closed. */
		summary: string;
		dataSection: string;
		open?: boolean;
		children: Snippet;
	}
	let {
		title,
		summary,
		dataSection,
		open = $bindable(true),
		children,
	}: CollapsibleSectionProps = $props();
</script>

{#snippet summaryLine()}
	<p class="evidence-summary" data-slot="section-summary">{summary}</p>
{/snippet}

<section class="section" data-section={dataSection} aria-label={title}>
	<SharedCollapsibleSection
		{title}
		anchor={`rel-${dataSection}`}
		summary={summaryLine}
		headerVariant="article-summary"
		bind:open
	>
		{@render children()}
	</SharedCollapsibleSection>
</section>

<style>
	.section {
		width: 100%;
	}
	.evidence-summary {
		margin: 0;
		color: var(--muted-foreground);
		font-size: var(--text-small);
		text-wrap: pretty;
	}
</style>
