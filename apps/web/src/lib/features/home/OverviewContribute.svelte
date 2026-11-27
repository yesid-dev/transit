<script lang="ts">
	import { DashboardGrid } from '@yesid/ui/layout';
	import type { Locale } from '#lib/i18n/index.ts';
	import { roadmapLinks } from '../roadmap/roadmap.copy.ts';
	import RecordCard from '../record/RecordCard.svelte';
	import { overviewCopy } from './overviewRecord.copy.ts';

	let {
		locale,
		errorHref,
		downloadHref,
	}: {
		locale: Locale;
		/** "Seen an error?" on How we measure's About Transit card, as on every screen. */
		errorHref: string;
		downloadHref: string;
	} = $props();

	const t = $derived(overviewCopy[locale]);
	const ways = $derived([
		{ key: 'error', text: t.contribute.error, href: errorHref, label: t.errorRow },
		{ key: 'cite', text: t.contribute.cite, href: downloadHref, label: t.contribute.citeLink },
		{ key: 'code', text: t.contribute.code, href: roadmapLinks.code, label: t.contribute.codeLink },
		{
			key: 'city',
			text: t.contribute.city,
			href: roadmapLinks.contact[locale],
			label: t.contribute.cityLink,
		},
	]);
</script>

<RecordCard interactive title={t.contribute.title}>
	<div class="grid gap-(--space-card-gap)" data-slot="overview-contribute">
		<p>{t.contribute.lead}</p>
		<DashboardGrid as="ul" gutter={false} minTile="22rem" class="m-0 list-none p-0" role="list">
			{#each ways as way (way.key)}
				<li class="min-w-0" data-contribute={way.key}>
					<p>{way.text}</p>
					<a class="inline-flex min-h-11 items-center text-primary underline" href={way.href}
						>{way.label}</a
					>
				</li>
			{/each}
		</DashboardGrid>
		<p>{t.contribute.thanks}</p>
	</div>
</RecordCard>
