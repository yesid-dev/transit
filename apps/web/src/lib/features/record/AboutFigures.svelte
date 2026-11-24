<script lang="ts">
	import { DashboardGrid } from '@yesid/ui/layout';
	import RecordCard from './RecordCard.svelte';

	let {
		title,
		fields,
		versionsLink,
	}: {
		title: string;
		fields: readonly { key: string; label: string; text: string | null }[];
		versionsLink: { href: string; label: string };
	} = $props();
</script>

<RecordCard {title}>
	<DashboardGrid gutter={false} minTile="17rem">
		{#each fields.filter(({ text }) => text) as field (field.key)}
			<dl class="min-w-0">
				<dt class="font-semibold text-muted-foreground">{field.label}</dt>
				<dd>
					{field.text}
					{#if field.key === 'versions'}
						<a
							class="inline-flex min-h-11 items-center text-primary underline"
							href={versionsLink.href}>{versionsLink.label}</a
						>
					{/if}
				</dd>
			</dl>
		{/each}
	</DashboardGrid>
</RecordCard>
