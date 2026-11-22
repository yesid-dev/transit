<script lang="ts">
	import type { LivePresentation } from '#lib/v1/live/livePresentation.ts';
	import type { NavigationLifecycle } from '@yesid/ui/brand';
	import type { Snippet } from 'svelte';
	import { cn } from '#lib/utils/index.ts';
	import { type Locale, DEFAULT_LOCALE, getLocale } from '#lib/i18n/index.ts';
	import type { ChromeSearchScope, SearchList } from '#lib/search/transitSearch.ts';
	import NavPill from './NavPill.svelte';
	import type { PublicProvider } from '#lib/v1/providers.ts';

	interface AppShellProps {
		navigation: NavigationLifecycle;
		fullViewport?: boolean;
		locale?: Locale;
		url?: URL;
		providerId?: string;
		providers?: PublicProvider[];
		discoveryError?: boolean;
		search?: string;
		searchList?: SearchList;
		searchPresentation?: LivePresentation | null;
		searchScope?: ChromeSearchScope;

		main?: Snippet;

		class?: string;
	}

	let {
		navigation,
		fullViewport = false,
		locale: localeProp,
		url,
		providerId,
		providers,
		discoveryError,
		search = $bindable(''),
		searchList,
		searchPresentation,
		searchScope = 'all',
		main,
		class: className,
	}: AppShellProps = $props();

	const ctxLocale = getLocale();
	const locale = $derived<Locale>(localeProp ?? ctxLocale ?? DEFAULT_LOCALE);
	let announcementHeight = $state(0);
	$effect(() => {
		// The phone drawers are portalled outside the shell.
		const root = document.documentElement;
		root.style.setProperty('--announcement-height', `${announcementHeight}px`);

		// Native focus may have scrolled before the measured chrome became sticky.
		const focused = document.activeElement;
		if (
			announcementHeight > 0 &&
			!fullViewport &&
			focused instanceof HTMLElement &&
			focused.matches(':focus-visible') &&
			focused.closest('[data-slot="app-shell-row"]')
		) {
			const clearance = parseFloat(getComputedStyle(root).scrollPaddingTop);
			const { top, bottom } = focused.getBoundingClientRect();
			if (top < clearance && bottom > 0) {
				focused.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
			}
		}
		return () => root.style.removeProperty('--announcement-height');
	});
</script>

<div
	class={cn(
		'app-shell-root circuit-grid flex w-full flex-col bg-background text-foreground',
		fullViewport ? 'h-dvh overflow-hidden' : 'min-h-dvh',
		className,
	)}
	data-full-viewport={fullViewport}
	data-slot="app-shell"
>
	<div
		class="app-shell-chrome"
		data-slot="app-shell-chrome"
		data-announcement-measured={announcementHeight > 0 || undefined}
		bind:clientHeight={announcementHeight}
	>
		<NavPill
			{navigation}
			{locale}
			{url}
			{providerId}
			{providers}
			{discoveryError}
			bind:search
			{searchList}
			{searchPresentation}
			{searchScope}
		/>
	</div>

	<div class="app-shell-row min-h-0 flex-1" data-slot="app-shell-row">
		<div class="app-shell-main relative min-w-0 flex-1 bg-transparent" data-slot="map-stage">
			{#if main}{@render main()}{/if}
		</div>
	</div>
</div>

<style>
	.app-shell-root {
		position: relative;
	}

	.app-shell-chrome {
		position: fixed;
		inset-block-start: 0;
		inset-inline: 0;
		z-index: var(--z-nav);
	}

	/* Only the banner occupies space in the chrome. Keep it in flow so the map starts below it
	   from the first paint and automatically reclaims the space when the banner is hidden. */
	.app-shell-chrome:has(:global([data-slot='announcement-banner'])) {
		position: sticky;
		flex: none;
	}

	/* Before hydration, browser focus scrolling cannot reserve the banner's measured height. */
	:global(html:not([data-announcement-dismissed]))
		.app-shell-chrome:not([data-announcement-measured]):has(
			:global([data-slot='announcement-banner']:not([hidden]))
		) {
		position: relative;
	}

	.app-shell-row {
		position: relative;
	}

	:global(.app-shell-root:has([data-slot='footer'][data-in-view='true']))
		:global(
			:is([data-slot='surface-rail-mobile'], [data-testid='toc-pill']):not(:focus-within):not(
					:has([aria-expanded='true'])
				)
		) {
		opacity: 0;
		pointer-events: none;
	}

	.app-shell-root[data-full-viewport='true'] .app-shell-row {
		overflow: hidden;
	}

	.app-shell-root[data-full-viewport='true'] .app-shell-main {
		overflow: hidden;
		position: absolute;
		inset: 0;
	}
</style>
