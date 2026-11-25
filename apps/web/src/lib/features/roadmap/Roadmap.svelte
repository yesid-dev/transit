<script lang="ts">
	import { Badge } from '@yesid/ui/badge';
	import InfoPage from '#lib/components/layout/InfoPage.svelte';
	import { getLocale } from '#lib/i18n/index.ts';
	import { ROADMAP_ENTRIES, roadmapCopy, roadmapTitle, roadmapLinks } from './roadmap.copy';

	const locale = getLocale();
	const copy = $derived(roadmapCopy[locale]);
</script>

<InfoPage title={roadmapTitle[locale]} titleId="roadmap-title">
	<section aria-labelledby="roadmap-introduction">
		<h2 id="roadmap-introduction">{copy.heading}</h2>
		<p>{copy.introduction}</p>
	</section>

	<section aria-labelledby="roadmap-current">
		<h2 id="roadmap-current">{copy.currentHeading}</h2>
		<ul class="list-disc">
			{#each copy.current as item (item)}
				<li>{item}</li>
			{/each}
		</ul>
		<p>{copy.entriesIntroduction}</p>
	</section>

	<section aria-labelledby="roadmap-entries">
		<h2 id="roadmap-entries">{copy.entriesHeading}</h2>
		<ol class="entries" role="list">
			{#each ROADMAP_ENTRIES as entry (entry.id)}
				<li id={entry.id}>
					<h3>{entry.title[locale]}</h3>
					<div><Badge variant="outline">{copy.states[entry.state]}</Badge></div>
					<p>{entry.description[locale]}</p>
				</li>
			{/each}
		</ol>
	</section>

	<section aria-labelledby="roadmap-contribute">
		<h2 id="roadmap-contribute">{copy.contributeHeading}</h2>
		<p>
			{copy.follow.before}<a href={roadmapLinks.code}>{copy.follow.repository}</a>{copy.follow
				.between}<a href={roadmapLinks.contact[locale]}>{copy.follow.contact}</a>{copy.follow.after}
		</p>
	</section>
</InfoPage>

<style>
	h3 {
		font-family: var(--font-heading);
		color: var(--foreground);
		line-height: 1.25;
		font-size: var(--text-reading-support);
		font-weight: 700;
	}

	.entries {
		display: grid;
		gap: 1.5rem;
		list-style: none;
	}

	.entries > li {
		display: grid;
		gap: 0.75rem;
		border-block-start: 1px solid var(--border);
		padding-block-start: 1rem;
		scroll-margin-block-start: 1rem;
	}
</style>
