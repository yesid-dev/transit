<script lang="ts">
	import type { LivePresentation } from '#lib/v1/live/livePresentation.ts';
	import type { NavigationLifecycle } from '@yesid/ui/brand';
	import type { Snippet } from 'svelte';
	import { DEFAULT_LOCALE, getLocale, type Locale } from '#lib/i18n/index.ts';
	import type { SearchList } from '#lib/search/transitSearch.ts';
	import { AppFrame, AnnouncementBanner, type SurfaceRailContext } from '@yesid/ui/layout';
	import { announcement } from '#lib/site/announcement.ts';
	import { frameToday } from '#lib/site/frameState.ts';
	import type { PublicProvider } from '#lib/v1/providers.ts';
	import NavPill from './NavPill.svelte';
	import FrameControls from './FrameControls.svelte';
	import { frameControlsState, frameCopy } from './frameControlsState.ts';
	import RecordPatience from '#lib/features/record/RecordPatience.svelte';

	interface AppShellProps {
		navigation: NavigationLifecycle;
		fullViewport?: boolean;
		mapCreditHeight?: number;
		locale?: Locale;
		url: URL;
		providerId?: string;
		timeZone?: string;
		providers?: PublicProvider[];
		discoveryError?: boolean;
		search?: string;
		searchList?: SearchList;
		searchPresentation?: LivePresentation | null;
		mainLabel?: string;
		main: Snippet;
		footer?: Snippet;
	}

	let {
		navigation,
		fullViewport = false,
		mapCreditHeight = 0,
		locale: localeProp,
		url,
		providerId,
		timeZone,
		providers,
		discoveryError,
		search = $bindable(''),
		searchList,
		searchPresentation,
		mainLabel,
		main,
		footer,
	}: AppShellProps = $props();

	const contextLocale = getLocale();
	const locale = $derived<Locale>(localeProp ?? contextLocale ?? DEFAULT_LOCALE);
	const copy = $derived(frameCopy[locale]);
	let announcementHeight = $state(0);
	let now = $state(new Date());
	const today = $derived(frameToday(timeZone, now));
	const frame = $derived(frameControlsState(url, today));

	$effect(() => {
		const root = document.documentElement;
		root.style.setProperty('--announcement-height', `${announcementHeight}px`);
		return () => root.style.removeProperty('--announcement-height');
	});
</script>

{#snippet header()}
	{#if announcement.enabled}
		<div data-slot="app-shell-chrome" bind:clientHeight={announcementHeight}>
			<AnnouncementBanner id={announcement.id} {...announcement[locale]} />
		</div>
	{/if}
	<NavPill
		{navigation}
		{locale}
		{url}
		{providerId}
		{timeZone}
		{providers}
		{discoveryError}
		bind:search
		{searchList}
		{searchPresentation}
	/>
{/snippet}

{#snippet rail(context: SurfaceRailContext)}
	<FrameControls {context} {locale} {url} {today} {frame} />
{/snippet}

<div
	class="app-shell-root circuit-grid bg-background text-foreground"
	data-full-viewport={fullViewport}
	style:--map-source-clearance={fullViewport ? `${mapCreditHeight}px` : undefined}
	data-slot="app-shell"
	onfocusin={() => (now = new Date())}
>
	<AppFrame
		{header}
		{footer}
		{fullViewport}
		{mainLabel}
		controlsRail={{
			rail,
			label: copy.controls,
			summary:
				frame.mode === 'live'
					? copy.live
					: frame.period?.preset
						? copy.presets[frame.period.preset]
						: copy.record,
			openAria: copy.open,
			closeAria: copy.close,
		}}
	>
		{#if fullViewport}
			{@render main()}
		{:else}
			<RecordPatience {locale} period={frame.period} scope={url.pathname + url.search}>
				{@render main()}
			</RecordPatience>
		{/if}
	</AppFrame>
</div>

<style>
	.app-shell-root[data-full-viewport='true'] :global([data-slot='surface-rail-mobile']) {
		--surface-rail-stack-offset: var(--map-source-clearance);
	}
	.app-shell-root:has(:global(.home-construction-floor)) {
		overflow-anchor: none;
	}
	/* Portalled search and map dialogs retain the app's stacking and safe-area tokens. */
	.app-shell-root:has(:global([data-slot='footer'] :focus-visible))
		:global([data-slot='app-frame-chrome']) {
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
</style>
