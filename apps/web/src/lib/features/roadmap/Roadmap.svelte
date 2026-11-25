<script lang="ts">
	import { Separator } from '@yesid/ui/separator';
	import RecordScreen from '#lib/features/record/RecordScreen.svelte';
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import { Badge } from '@yesid/ui/badge';
	import { ReadingFrame, Surface } from '@yesid/ui/layout';
	import { getLocale } from '#lib/i18n/index.ts';
	import { ROADMAP_ENTRIES, roadmapCopy, roadmapTitle, roadmapLinks } from './roadmap.copy';

	const locale = getLocale();
	const copy = $derived(roadmapCopy[locale]);
</script>

<Surface style="--space-page-x: var(--space-card-gap)">
	<ReadingFrame
		title={roadmapTitle[locale]}
		titleId="roadmap-title"
		aria-labelledby="roadmap-title"
		style="--reading-gutter: 0; padding-block: 0"
	>
		<RecordScreen>
			<div class="roadmap-content min-w-0" data-slot="screen-content">
				<RecordGroup aria-labelledby="roadmap-introduction"
					><div class="grid gap-6" data-slot="screen-answer">
						<h2 id="roadmap-introduction">{copy.heading}</h2>
						<p>{copy.introduction}</p>
					</div>
				</RecordGroup>

				<RecordGroup aria-labelledby="roadmap-current">
					<h2 id="roadmap-current">{copy.currentHeading}</h2>
					<ul class="grid list-disc gap-1 ps-5">
						{#each copy.current as item (item)}
							<li>{item}</li>
						{/each}
					</ul>
					<p>{copy.entriesIntroduction}</p>
				</RecordGroup>

				<RecordGroup aria-labelledby="roadmap-entries">
					<h2 id="roadmap-entries">{copy.entriesHeading}</h2>
					<ol class="entries" role="list">
						{#each ROADMAP_ENTRIES as entry, index (entry.id)}
							<li id={entry.id}>
								{#if index > 0}<Separator variant="hand-drawn" />{/if}
								<h3>{entry.title[locale]}</h3>
								<div><Badge variant="outline">{copy.states[entry.state]}</Badge></div>
								<p>{entry.description[locale]}</p>
							</li>
						{/each}
					</ol>
				</RecordGroup>

				<RecordGroup aria-labelledby="roadmap-contribute">
					<h2 id="roadmap-contribute">{copy.contributeHeading}</h2>
					<p>
						{copy.follow.before}<a class="text-primary underline" href={roadmapLinks.code}
							>{copy.follow.repository}</a
						>{copy.follow.between}<a
							class="text-primary underline"
							href={roadmapLinks.contact[locale]}>{copy.follow.contact}</a
						>{copy.follow.after}
					</p>
				</RecordGroup>
			</div>
		</RecordScreen>
	</ReadingFrame>
</Surface>

<style>
	.roadmap-content {
		font-size: var(--text-body);
		line-height: 1.5;
	}

	.roadmap-content :is(h2, h3, p, ul, ol) {
		margin-block: 0;
	}

	h2 {
		font-size: var(--text-heading);
		font-weight: 700;
	}

	p {
		max-inline-size: var(--measure-lede);
	}

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
		scroll-margin-block-start: 1rem;
	}
</style>
