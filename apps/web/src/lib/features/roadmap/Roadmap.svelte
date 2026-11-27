<script lang="ts">
	import { page } from '$app/state';
	import { Separator } from '@yesid/ui/separator';
	import RecordScreen from '#lib/features/record/RecordScreen.svelte';
	import RecordGroup from '#lib/features/record/RecordGroup.svelte';
	import { ReadingFrame, Surface } from '@yesid/ui/layout';
	import { getLocale, localizeHref } from '#lib/i18n/index.ts';
	import { NAV_ITEMS, SEARCH_LABEL } from '#lib/content/nav.ts';
	import {
		ROADMAP_ENTRIES,
		ROADMAP_STATES,
		roadmapCopy,
		roadmapTitle,
		roadmapLinks,
		type RoadmapScreen,
	} from './roadmap.copy';

	const locale = getLocale();
	const copy = $derived(roadmapCopy[locale]);
	const provider = $derived(
		typeof page.data.providerId === 'string' ? page.data.providerId : undefined,
	);

	function screenLink(key: RoadmapScreen) {
		const item =
			key === 'search'
				? { href: '/search', label: SEARCH_LABEL }
				: NAV_ITEMS.find((entry) => entry.key === key)!;
		return { href: localizeHref(item.href, locale, provider), label: item.label[locale] };
	}
</script>

<Surface style="--space-page-x: var(--space-card-gap)">
	<ReadingFrame
		title={roadmapTitle[locale]}
		titleId="roadmap-title"
		aria-labelledby="roadmap-title"
		style="--reading-gutter: 0; --reading-measure: var(--transit-measure-listing); padding-block: 0"
	>
		<RecordScreen>
			<div class="roadmap-content min-w-0" data-slot="screen-content">
				<RecordGroup><p data-slot="screen-answer">{copy.introduction}</p></RecordGroup>

				{#each ROADMAP_STATES as state (state)}
					<RecordGroup aria-labelledby={`roadmap-${state}`}>
						<h2 id={`roadmap-${state}`}>{copy.states[state]}</h2>
						<ol class="entries" role="list">
							{#each ROADMAP_ENTRIES.filter((entry) => entry.state === state) as entry, index (entry.id)}
								<li id={entry.id}>
									{#if index > 0}<Separator variant="hand-drawn" />{/if}
									<h3>{entry.title[locale]}</h3>
									<p>{entry.description[locale]}</p>
									{#if entry.screens}
										<ul class="screens" role="list" aria-label={copy.screensLabel}>
											{#each entry.screens.map(screenLink) as link (link.href)}
												<li>
													<a
														class="text-primary inline-flex min-h-11 min-w-11 items-center underline"
														href={link.href}>{link.label}</a
													>
												</li>
											{/each}
										</ul>
									{/if}
								</li>
							{/each}
						</ol>
					</RecordGroup>
				{/each}

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
		padding: 0;
	}

	.entries > li {
		display: grid;
		gap: 0.75rem;
		scroll-margin-block-start: 1rem;
	}

	.screens {
		display: flex;
		flex-wrap: wrap;
		column-gap: 1.25rem;
		list-style: none;
		padding: 0;
	}
</style>
