<script lang="ts">
	import { DashboardGrid } from '@yesid/ui/layout';
	import { Skeleton } from '@yesid/ui/skeleton';
	import RecordCard from '../record/RecordCard.svelte';

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
			link?: { href: string; label: string };
		}[];
	} = $props();
</script>

<!-- About these figures while the record is on its way: the same grid as AboutFigures, its labels
     and every sentence that needs no answer already drawn, pulsing lines where a sentence waits
     for the answer. The screen's one live region speaks for it. -->
<RecordCard {title} interactive={fields.some(({ link }) => link)}>
	<DashboardGrid gutter={false} minTile="17rem">
		{#each fields.filter(({ text, link, waiting }) => text || link || waiting) as field (field.key)}
			{@const link = field.link}
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
						{#if link}
							<a class="inline-flex min-h-11 items-center text-primary underline" href={link.href}
								>{link.label}</a
							>
						{/if}
					</dd>
				{/if}
			</dl>
		{/each}
	</DashboardGrid>
</RecordCard>
