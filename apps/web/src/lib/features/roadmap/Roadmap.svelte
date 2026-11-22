<script lang="ts">
	import { Badge } from '@yesid/ui/badge';
	import { getLocale } from '#lib/i18n/index.ts';
	import { HOME_INVITE_LINKS } from '#lib/features/home/homePulse.copy.ts';
	import { ROADMAP_ENTRIES, roadmapCopy, roadmapTitle } from './roadmap.copy';

	const locale = getLocale();
	const copy = $derived(roadmapCopy[locale]);
</script>

<article class="roadmap" aria-labelledby="roadmap-heading">
	<header>
		<p class="roadmap-title">{roadmapTitle[locale]}</p>
		<h1 id="roadmap-heading">{copy.heading}</h1>
		<p>{copy.introduction}</p>
	</header>

	<section aria-labelledby="roadmap-current">
		<h2 id="roadmap-current">{copy.currentHeading}</h2>
		<ul>
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
			{copy.follow.before}<a href={HOME_INVITE_LINKS.code}>{copy.follow.repository}</a>{copy.follow
				.between}<a href={HOME_INVITE_LINKS.contact[locale]}>{copy.follow.contact}</a>{copy.follow
				.after}
		</p>
	</section>
</article>

<style>
	.roadmap {
		display: grid;
		gap: 2.5rem;
		width: min(100% - 2rem, 52rem);
		margin-inline: auto;
		padding-block: 4rem 6rem;
		font-size: var(--text-reading);
		color: var(--secondary-foreground);
		line-height: 1.7;
	}

	header,
	section,
	.entries > li {
		display: grid;
		gap: 0.75rem;
	}

	.roadmap-title {
		font-weight: 700;
		color: var(--primary);
	}

	h1,
	h2,
	h3 {
		font-family: var(--font-heading);
		color: var(--foreground);
		line-height: 1.25;
	}

	h1 {
		font-size: var(--text-display);
	}

	h2 {
		font-size: var(--text-reading-heading);
	}

	h3 {
		font-size: var(--text-reading-support);
		font-weight: 700;
	}

	p,
	ul {
		max-width: var(--measure-lede);
	}

	ul {
		list-style: disc;
		padding-inline-start: 1.25em;
	}

	.entries {
		display: grid;
		gap: 1.5rem;
		list-style: none;
	}

	.entries > li {
		border-block-start: 1px solid var(--border);
		padding-block-start: 1rem;
		scroll-margin-block-start: calc(var(--chrome-offset, 0px) + 1rem);
	}

	@media (--desktop-min) {
		.roadmap {
			font-size: var(--text-reading-desktop);
		}

		h2 {
			font-size: var(--text-reading-heading-desktop);
		}
	}
</style>
