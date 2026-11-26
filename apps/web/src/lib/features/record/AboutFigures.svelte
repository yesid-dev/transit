<script lang="ts">
	import { DashboardGrid } from '@yesid/ui/layout';
	import RecordCard from './RecordCard.svelte';

	let {
		title,
		fields,
		compact = false,
		compactPrint = false,
		edge,
		interactive = false,
	}: {
		title: string;
		fields: readonly {
			key: string;
			label: string;
			text: string | null;
			link?: { href: string; label: string };
		}[];
		compact?: boolean;
		compactPrint?: boolean;
		edge?: 'brand' | 'neutral';
		interactive?: boolean;
	} = $props();
</script>

<RecordCard
	{title}
	{compactPrint}
	{edge}
	interactive={interactive || fields.some(({ link }) => link)}
>
	<DashboardGrid
		gutter={false}
		minTile="17rem"
		style={compact ? 'row-gap: calc(var(--space-card-gap) / 3)' : undefined}
	>
		{#each fields.filter(({ text, link }) => text || link) as field (field.key)}
			{@const link = field.link}
			<dl class="min-w-0">
				<dt class="font-semibold text-muted-foreground">{field.label}</dt>
				<dd>
					{field.text}
					{#if link}
						<a class="inline-flex min-h-11 items-center text-primary underline" href={link.href}
							>{link.label}</a
						>
					{/if}
				</dd>
			</dl>
		{/each}
	</DashboardGrid>
</RecordCard>
