<script lang="ts">
	import { DashboardGrid } from '@yesid/ui/layout';
	import RecordCard from './RecordCard.svelte';

	type FigureLink = { href: string; label: string };

	let {
		title,
		class: className,
		fields,
		compact = false,
		compactPrint = false,
		edge,
		interactive = false,
	}: {
		title: string;
		class?: string;
		fields: readonly {
			key: string;
			label: string;
			text: string | null;
			link?: FigureLink;
			links?: readonly FigureLink[];
		}[];
		compact?: boolean;
		compactPrint?: boolean;
		edge?: 'brand' | 'neutral';
		interactive?: boolean;
	} = $props();
</script>

{#snippet reference(link: FigureLink)}
	<a class="inline-flex min-h-11 items-center text-primary underline" href={link.href}
		>{link.label}</a
	>
{/snippet}

<RecordCard
	{title}
	class={className}
	{compactPrint}
	{edge}
	interactive={interactive || fields.some(({ link, links }) => link || links?.length)}
>
	<DashboardGrid
		gutter={false}
		minTile="17rem"
		style={compact ? 'row-gap: calc(var(--space-card-gap) / 3)' : undefined}
	>
		{#each fields.filter(({ text, link, links }) => text || link || links?.length) as field (field.key)}
			<dl class="min-w-0">
				<dt class="font-semibold text-muted-foreground">{field.label}</dt>
				<dd>
					{field.text}
					{#if field.links?.length}
						<div class="flex flex-wrap gap-x-4">
							{#each field.links as link (link.href)}
								{@render reference(link)}
							{/each}
						</div>
					{:else if field.link}
						{@render reference(field.link)}
					{/if}
				</dd>
			</dl>
		{/each}
	</DashboardGrid>
</RecordCard>
