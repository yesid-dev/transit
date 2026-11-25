<script lang="ts">
	import type { LivePresentation } from '#lib/v1/live/livePresentation.ts';
	import type { NavigationLifecycle } from '@yesid/ui/brand';
	import { setContext, type Snippet } from 'svelte';
	import { DEFAULT_LOCALE, getLocale, type Locale } from '#lib/i18n/index.ts';
	import type { SearchList } from '#lib/search/transitSearch.ts';
	import { AppFrame, AnnouncementBanner, Surface, type SurfaceRailContext } from '@yesid/ui/layout';
	import { announcement } from '#lib/site/announcement.ts';
	import { formatDateKey } from '#lib/utils/time.ts';
	import { frameClock } from '#lib/site/frameState.ts';
	import type { PublicCity, PublicProvider } from '#lib/v1/schemas/providers.ts';
	import NavPill from './NavPill.svelte';
	import { frameSurfaceRailContext, type RegisterFrameSurfaceRail } from './frameSurfaceRail.ts';
	import FrameControls from './FrameControls.svelte';
	import { frameControlsState, frameCopy } from './frameControlsState.ts';
	import ScreenTitle from '#lib/features/record/ScreenTitle.svelte';
	import StateMark from '#lib/features/record/StateMark.svelte';
	import RecordPatience from '#lib/features/record/RecordPatience.svelte';

	interface AppShellProps {
		navigation: NavigationLifecycle;
		fullViewport?: boolean;
		mapCreditHeight?: number;
		mobileControlsVisible?: boolean;
		locale?: Locale;
		url: URL;
		providerId?: string;
		provider: PublicCity | null;
		screenTitle: string;
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
		mobileControlsVisible = true,
		locale: localeProp,
		url,
		providerId,
		provider,
		screenTitle,
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
	const clock = $derived(frameClock(provider, now));
	const frame = $derived(frameControlsState(url, clock));
	let surfaceControls = $state.raw<Snippet<[SurfaceRailContext]>[]>([]);
	const registerSurfaceControls: RegisterFrameSurfaceRail = (rail) => {
		surfaceControls = [...surfaceControls, rail];
		return () => {
			surfaceControls = surfaceControls.filter((entry) => entry !== rail);
		};
	};
	setContext(frameSurfaceRailContext, registerSurfaceControls);

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
		{clock}
		{providers}
		{discoveryError}
		bind:search
		{searchList}
		{searchPresentation}
	/>
{/snippet}

{#snippet rail(context: SurfaceRailContext)}
	<FrameControls {context} {locale} {url} {clock} {frame} />
	{#if context.presentation === 'mobile'}
		{#each surfaceControls as controls (controls)}
			{@render controls(context)}
		{/each}
	{/if}
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
			mobileVisible: mobileControlsVisible,
		}}
	>
		{#if frame.waitingForYesterday && (frame.usesFrameRecord || frame.map)}
			<Surface>
				<ScreenTitle title={screenTitle} />
				<div class="flex items-baseline gap-2" data-slot="screen-state">
					<StateMark state="not_measured" {locale} hiddenLabel />
					<p data-slot="record-yesterday-pending">
						{copy.waitingForDay(
							formatDateKey(frame.waitingForYesterday, locale, false, 'day-first', 'long'),
						)}
					</p>
				</div>
			</Surface>
		{:else if fullViewport}
			{@render main()}
		{:else}
			<RecordPatience {locale} period={frame.period} scope={url.pathname + url.search}>
				{@render main()}
			</RecordPatience>
		{/if}
	</AppFrame>
</div>

<style>
	/* The paired reading rail and the page surface share the card gutter. */
	@media (min-width: 64rem) {
		.app-shell-root[data-full-viewport='false']
			:global([data-slot='app-frame']:not([data-rail-layout='compact']) > .app-frame-body) {
			--space-page-x: var(--space-card-gap);
		}
	}
	/* remove when yesid.design ships T7/T8 (v0.57.0) */
	.app-shell-root
		:global([data-rail-layout='compact'] [data-slot='site-header'] .nav-search.nav-collapsible) {
		display: none;
	}
	/* remove when yesid.design ships T7/T8 (v0.57.0) */
	.app-shell-root
		:global(
			[data-rail-layout='compact']
				[data-slot='site-header']
				[data-slot='nav-compact-search']:not([role='dialog'][aria-modal='true'] *)
		) {
		display: inline-flex;
	}
	.app-shell-root[data-full-viewport='true'] {
		--map-touch-row-bottom: calc(
			var(--map-source-clearance, 0px) +
				max(
					calc(1.625rem + env(safe-area-inset-bottom, 0px) + var(--size-tap-min)),
					calc(var(--floating-pill-clearance) + 0.5rem)
				)
		);
	}
	/* Keep transparent map chrome from blocking the map or its panels. */
	.app-shell-root[data-full-viewport='true'] :global([data-slot='app-frame-chrome']) {
		pointer-events: none;
		background: transparent;
	}
	/* remove when yesid.design ships T7/T8 (v0.57.0) */
	.app-shell-root :global([data-rail-layout='compact'] [data-slot='footer'] > .grid) {
		padding-block: var(--space-card-gap);
	}
	/* remove when yesid.design ships T7/T8 (v0.57.0) */
	.app-shell-root
		:global(
			[data-rail-layout='compact']
				[data-slot='footer']:has([data-slot='legal-footer-status'])
				> .grid
		) {
		padding-block-end: calc(var(--space-card-gap) / 2);
	}

	/* remove when yesid.design ships T7/T8 (v0.57.0) */
	@media (min-width: 1024px) {
		.app-shell-root :global([data-rail-layout='compact'] [data-slot='footer'] > .grid) {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			column-gap: var(--space-card-gap);
			padding-inline: var(--space-card-gap);
		}
		/* remove when yesid.design ships T7/T8 (v0.57.0) */
		.app-shell-root
			:global(
				[data-rail-layout='compact']
					[data-slot='footer']
					:is([data-slot='footer-link'], [data-slot='footer-group-label'])
			) {
			overflow-wrap: normal;
			word-break: normal;
		}
	}
	/* remove when yesid.design ships T7/T8 (v0.57.0) */
	@media (min-width: 1280px) {
		.app-shell-root :global([data-rail-layout='compact'] [data-slot='footer'] > .grid) {
			grid-template-columns:
				minmax(0, 1.5fr)
				repeat(var(--footer-groups), minmax(min-content, 1fr));
		}
	}
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
