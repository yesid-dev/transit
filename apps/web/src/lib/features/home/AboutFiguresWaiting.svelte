<script lang="ts">
	import { DashboardGrid } from '@yesid/ui/layout';
	import { Skeleton } from '@yesid/ui/skeleton';
	import RecordCard from '../record/RecordCard.svelte';

	type FigureLink = { href: string; label: string };

	let {
		title,
		fields,
	}: {
		title: string;
		/** The fields of AboutFigures, in its order; a field whose text comes with the answer waits. */
		fields: readonly {
			key: string;
			label: string;
			text: string | null;
			/** Lines of pulsing text while the sentence waits for the answer. */
			waiting?: boolean | number;
			link?: FigureLink;
			links?: readonly FigureLink[];
		}[];
	} = $props();
</script>

{#snippet reference(link: FigureLink)}
	<a class="inline-flex min-h-11 items-center text-primary underline" href={link.href}
		>{link.label}</a
	>
{/snippet}

<!-- About these figures while the record is on its way: the same grid as AboutFigures, its labels,
     links and every sentence that needs no answer already drawn, pulsing lines where a sentence
     waits for the answer. The screen's one live region speaks for it. -->
<RecordCard {title} interactive={fields.some(({ link, links }) => link || links?.length)}>
	<DashboardGrid gutter={false} minTile="17rem">
		{#each fields.filter(({ text, link, links, waiting }) => text || link || links?.length || waiting) as field (field.key)}
			<dl class="min-w-0">
				<dt class="font-semibold text-muted-foreground">{field.label}</dt>
				{#if field.waiting}
					{@const lines = typeof field.waiting === 'number' ? field.waiting : 2}
					<dd class="grid gap-2 pt-1" aria-busy="true" data-record-pending>
						{#each Array.from({ length: lines }, (_, line) => line) as line (line)}
							<Skeleton class={line === lines - 1 ? 'h-4 w-3/4' : 'h-4 w-full'} />
						{/each}
					</dd>
				{:else}
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
				{/if}
			</dl>
		{/each}
	</DashboardGrid>
</RecordCard>
