<script lang="ts">
	import SearchIcon from '@lucide/svelte/icons/search';
	import { getLocalizeHref, type Locale } from '#lib/i18n/index.ts';
	import { routeFor } from '#lib/nav/index.ts';
	import { homeSearchCopy } from './homePulse.copy';

	interface Props {
		readonly locale: Locale;
	}

	let { locale }: Props = $props();
	const localizeHref = getLocalizeHref();
	const t = $derived(homeSearchCopy[locale]);
</script>

<!-- The search itself lives in the header and on the search page; the home page only leads there. -->
<p class="home-search" data-slot="home-search">
	<a href={localizeHref(routeFor({ kind: 'search' }), locale)}>
		<SearchIcon class="home-search-icon" size={18} strokeWidth={2} aria-hidden="true" />
		<span>{t.label}</span>
	</a>
</p>

<style>
	/* The page's one primary action: a full-width button on phones, its column's width on desktop. */
	.home-search {
		display: flex;
		margin: 0;
	}
	.home-search a {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		width: 100%;
		min-height: 48px;
		padding: 0.625rem 1rem;
		color: var(--primary-foreground);
		font-weight: 700;
		text-align: center;
		text-decoration: none;
		background: var(--primary);
		border: 1px solid var(--primary);
		border-radius: var(--radius-md);
	}
	.home-search a:hover {
		background: var(--primary-hover);
		border-color: var(--primary-hover);
	}
	.home-search a:focus-visible {
		outline: 2px solid var(--accent-text);
		outline-offset: 3px;
	}
	.home-search a :global(.home-search-icon) {
		flex: none;
	}
</style>
