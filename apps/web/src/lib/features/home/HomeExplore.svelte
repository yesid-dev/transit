<script lang="ts">
	import { getLocalizeHref, type Locale } from '#lib/i18n/index.ts';
	import { navPillCopy } from '#lib/i18n/messages.ts';
	import type { Snippet } from 'svelte';
	import HomeSearch from './HomeSearch.svelte';
	import { homeGroups, type HomeCopy, type HomeEntry } from './home.copy';

	const localizeHref = getLocalizeHref();

	interface Props {
		readonly locale: Locale;
		readonly alertsAvailable?: boolean;
		readonly copy: HomeCopy;
		/** The record, live and ranking cards, between the introduction and the groups. */
		readonly pulse?: Snippet;
	}

	let { locale, copy: t, alertsAvailable = true, pulse }: Props = $props();

	const groups = $derived(homeGroups(alertsAvailable));
	const href = (entry: HomeEntry) =>
		entry.external ? entry.href : localizeHref(entry.href, locale);
</script>

<section class="home-explore" data-slot="home-explore" aria-labelledby="home-explore-title">
	<!-- Leads: the headline, one purpose sentence and the Search button under it (UX plan §6.1). -->
	<header class="home-intro" data-slot="home-audit-brief">
		<h1 id="home-explore-title">{t.headline} <span>{t.headlineAccent}</span></h1>
		<p class="home-lede">{t.auditBody} {t.notPlanner}</p>
		<div class="home-intro-search"><HomeSearch {locale} /></div>
		<details class="home-more" data-slot="home-more">
			<summary
				><span class="home-more-closed">{t.readMore}</span><span class="home-more-open"
					>{t.readLess}</span
				><span class="home-more-mark" aria-hidden="true">+</span></summary
			>
			<p>{t.auditMore}</p>
			<p>{t.audience}</p>
			<p>{t.cadence}</p>
		</details>
	</header>
	{@render pulse?.()}
	<!-- The menu's four groups, every page once, with what it answers: no filters, no count. -->
	<nav class="home-groups" data-slot="home-groups" aria-labelledby="home-groups-title">
		<h2 id="home-groups-title">{t.exploreNav}</h2>
		<div class="groups">
			{#each groups as group (group.key)}
				<section class="group" aria-labelledby={`home-group-${group.key}`}>
					<h3 id={`home-group-${group.key}`}>{group.label[locale]}</h3>
					<ul>
						{#each group.entries as entry (entry.href)}
							<li class="group-item">
								{#if entry.external}
									<a class="group-link" href={href(entry)} target="_blank" rel="noopener noreferrer"
										>{entry.title[locale]}<span aria-hidden="true"> ↗</span><span class="sr-only">
											{navPillCopy[locale].newTab}</span
										></a
									>
								{:else}
									<a class="group-link" href={href(entry)}>{entry.title[locale]}</a>
								{/if}
								{#if entry.desc}<span class="group-desc">{entry.desc[locale]}</span>{/if}
							</li>
						{/each}
					</ul>
				</section>
			{/each}
		</div>
	</nav>
</section>

<style>
	.home-explore {
		display: flex;
		flex-direction: column;
		gap: clamp(1.75rem, 4vw, 3rem);
		width: 100%;
		padding-bottom: 2rem;
	}
	/* Phones: headline, purpose, Search, Read more. Desktop: Search in the right third (8 + 4). */
	.home-intro {
		display: grid;
		grid-template-areas:
			'title'
			'lede'
			'search'
			'more';
		gap: 1rem;
	}
	.home-intro h1 {
		grid-area: title;
		margin: 0;
		font-family: var(--font-heading);
		font-size: clamp(1.75rem, 1.25rem + 2vw, 2.5rem);
		font-weight: 800;
		line-height: 1.1;
		letter-spacing: var(--tracking-tight);
		text-wrap: balance;
	}
	.home-intro h1 span {
		color: var(--primary);
	}
	.home-lede {
		grid-area: lede;
		max-width: var(--measure-body);
		margin: 0;
		font-size: var(--text-body);
		line-height: 1.6;
		color: var(--secondary-foreground);
		text-wrap: pretty;
	}
	.home-intro-search {
		grid-area: search;
		min-width: 0;
	}
	.home-more {
		grid-area: more;
		max-width: var(--measure-body);
	}
	.home-more summary {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 44px;
		color: var(--primary);
		font-family: var(--font-mono);
		font-size: var(--text-small);
		cursor: pointer;
		list-style: none;
	}
	.home-more summary::-webkit-details-marker {
		display: none;
	}
	.home-more summary:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: 4px;
	}
	.home-more-open,
	.home-more[open] .home-more-closed {
		display: none;
	}
	.home-more[open] .home-more-open {
		display: inline;
	}
	.home-more[open] .home-more-mark {
		transform: rotate(45deg);
	}
	.home-more p {
		margin: 0.5rem 0 0;
		line-height: 1.7;
		color: var(--secondary-foreground);
	}
	@media (--desktop-min) {
		.home-intro {
			grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
			grid-template-areas:
				'title .'
				'lede search'
				'more .';
			column-gap: 1.5rem;
			align-items: end;
		}
	}
	.home-groups h2 {
		margin: 0 0 1rem;
		font-family: var(--font-heading);
		font-size: var(--text-heading);
		font-weight: 800;
		letter-spacing: var(--tracking-tight);
	}
	.groups {
		display: grid;
		gap: 1.5rem;
	}
	.group {
		min-width: 0;
	}
	.group h3 {
		margin: 0;
		padding-bottom: 0.5rem;
		font-size: var(--text-small);
		font-weight: 600;
		color: var(--muted-foreground);
		border-bottom: 1px solid var(--border);
	}
	.group ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}
	/* The whole item is its link's target; the title stays the link's text. */
	.group-item {
		position: relative;
		display: grid;
		gap: 0.125rem;
		min-height: 44px;
		padding-block: 0.75rem;
		border-bottom: 1px solid var(--border-subtle);
	}
	.group-link {
		width: fit-content;
		color: var(--foreground);
		font-weight: 600;
		text-decoration: none;
		border-radius: var(--radius-sm);
	}
	.group-link::after {
		content: '';
		position: absolute;
		inset: 0;
	}
	.group-item:hover .group-link {
		color: var(--primary);
		text-decoration: underline;
		text-underline-offset: 0.2em;
	}
	.group-link:focus-visible {
		outline: 2px solid var(--primary);
		outline-offset: 2px;
	}
	.group-desc {
		color: var(--muted-foreground);
		font-size: var(--text-small);
		line-height: 1.5;
	}
	@media (--tablet-min) {
		.groups {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			column-gap: 2rem;
		}
	}
	@media (--desktop-min) {
		.groups {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
	}
</style>
