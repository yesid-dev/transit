<script lang="ts">
	import type { LivePresentation } from '#lib/v1/live/livePresentation.ts';
	import type { NavigationLifecycle } from '@yesid/ui/brand';
	import { setContext, type Snippet } from 'svelte';
	import { DEFAULT_LOCALE, getLocale, type Locale } from '#lib/i18n/index.ts';
	import type { SearchList } from '#lib/search/transitSearch.ts';
	import { AppFrame, AnnouncementBanner, type SurfaceRailContext } from '@yesid/ui/layout';
	import { announcement } from '#lib/site/announcement.ts';
	import { clockOnFocus, frameClock } from '#lib/site/frameState.ts';
	import type { PublicCity, PublicProvider } from '#lib/v1/schemas/providers.ts';
	import NavPill from './NavPill.svelte';
	import { frameSurfaceRailContext, type RegisterFrameSurfaceRail } from './frameSurfaceRail.ts';
	import {
		mapControlsVisibilityContext,
		type RegisterMapControlsVisibility,
	} from './mapControlsVisibility.ts';
	import FrameControls, {
		FrameControlsContentContext,
		FrameControlsExtensionContext,
		type FrameControlsExtension,
	} from './FrameControls.svelte';
	import {
		frameControlsState,
		frameCopy,
		recordStartNotice,
		recordEndNotice,
	} from './frameControlsState.ts';
	import { provideRecordPeriodNotice } from '#lib/site/recordPeriodNoticeContext.ts';
	import RecordPatience from '#lib/features/record/RecordPatience.svelte';

	interface AppShellProps {
		navigation: NavigationLifecycle;
		fullViewport?: boolean;
		mapCreditHeight?: number;
		locale?: Locale;
		url: URL;
		providerId?: string;
		provider: PublicCity | null;
		providers?: PublicProvider[];
		discoveryError?: boolean;
		search?: string;
		searchList?: SearchList;
		searchPresentation?: LivePresentation | null;
		mainLabel?: string;
		errorPage?: boolean;
		main: Snippet;
		footer?: Snippet;
		desktopControlsFallback?: Snippet;
	}

	let {
		navigation,
		fullViewport = false,
		mapCreditHeight = 0,
		locale: localeProp,
		url,
		providerId,
		provider,
		providers,
		discoveryError,
		search = $bindable(''),
		searchList,
		searchPresentation,
		mainLabel,
		errorPage = false,
		main,
		footer,
		desktopControlsFallback,
	}: AppShellProps = $props();

	const contextLocale = getLocale();
	const locale = $derived<Locale>(localeProp ?? contextLocale ?? DEFAULT_LOCALE);
	const copy = $derived(frameCopy[locale]);
	let announcementHeight = $state(0);
	let shellWidth = $state(0);
	let remWidth = $state(0);
	let now = $state(new Date());
	const clock = $derived(frameClock(provider, now));
	const frame = $derived(frameControlsState(url, clock, errorPage));
	const compactMap = $derived(fullViewport && remWidth > 0 && shellWidth < 64 * remWidth);
	let mapControlsVisibility = $state.raw<() => boolean>();
	const registerMapControlsVisibility: RegisterMapControlsVisibility = (visible) => {
		mapControlsVisibility = visible;
		return () => {
			if (mapControlsVisibility === visible) mapControlsVisibility = undefined;
		};
	};
	setContext(mapControlsVisibilityContext, registerMapControlsVisibility);
	const mapControlsVisible = $derived(mapControlsVisibility?.() ?? false);
	provideRecordPeriodNotice(
		() =>
			recordStartNotice(frame.beforeRecord, locale) ?? recordEndNotice(frame.afterRecord, locale),
	);
	let surfaceControls = $state.raw<
		{ rail: Snippet<[SurfaceRailContext]>; desktopPlacement?: 'before-frame' }[]
	>([]);
	const registerSurfaceControls: RegisterFrameSurfaceRail = (rail, desktopPlacement) => {
		const entry = { rail, desktopPlacement };
		surfaceControls = [...surfaceControls, entry];
		return () => {
			surfaceControls = surfaceControls.filter((control) => control !== entry);
		};
	};
	setContext(frameSurfaceRailContext, registerSurfaceControls);
	setContext(FrameControlsContentContext, railContents);
	let controlsExtension = $state.raw<FrameControlsExtension>();
	setContext(FrameControlsExtensionContext, (extension: FrameControlsExtension) => {
		controlsExtension = extension;
		return () => {
			if (controlsExtension === extension) controlsExtension = undefined;
		};
	});

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

{#snippet railContents(context: SurfaceRailContext)}
	{@const desktop = context.presentation === 'desktop'}
	{#if desktopControlsFallback && !surfaceControls.some(({ desktopPlacement }) => desktopPlacement === 'before-frame')}
		<div class="desktop-controls-fallback">
			{@render desktopControlsFallback()}
		</div>
	{/if}
	{#if desktop}
		{#each surfaceControls as { rail, desktopPlacement } (rail)}
			{#if desktopPlacement === 'before-frame'}{@render rail(context)}{/if}
		{/each}
	{/if}
	<FrameControls {context} {locale} {url} {clock} {frame} extension={controlsExtension} />
	{#if desktop}
		{@render controlsExtension?.after?.()}
	{/if}
	{#each surfaceControls as { rail, desktopPlacement } (rail)}
		{#if !desktop || desktopPlacement !== 'before-frame'}{@render rail(context)}{/if}
	{/each}
{/snippet}

{#snippet rail(context: SurfaceRailContext)}
	{#if fullViewport}
		<div
			class="map-rail [&>*]:[min-inline-size:0]"
			class:desktop={context.presentation === 'desktop'}
			data-lenis-prevent
			data-ripple-exempt
			data-map-rail-visible={mapControlsVisible}
			aria-hidden={mapControlsVisible ? undefined : true}
			inert={!mapControlsVisible}
		>
			{@render railContents(context)}
		</div>
	{:else}
		{@render railContents(context)}
	{/if}
{/snippet}

{#snippet streamingFooter()}
	<div class="streaming-footer">{@render footer?.()}</div>
{/snippet}

<div
	class="app-shell-root circuit-grid bg-background text-foreground"
	data-full-viewport={fullViewport}
	style:--map-source-clearance={fullViewport ? `${mapCreditHeight}px` : undefined}
	data-slot="app-shell"
	bind:clientWidth={shellWidth}
	onfocusin={() => (now = clockOnFocus(provider, now))}
>
	{#if fullViewport}
		<span aria-hidden="true" class="invisible absolute w-[1rem]" bind:clientWidth={remWidth}></span>
	{/if}
	<AppFrame
		{header}
		footer={footer && !fullViewport ? streamingFooter : footer}
		{fullViewport}
		{mainLabel}
		controlsRail={frame.showRail && !compactMap
			? {
					rail,
					label: copy.controls,
					summary: controlsExtension?.hideSummary?.()
						? undefined
						: frame.mode === 'live'
							? copy.live
							: frame.period?.preset
								? copy.presets[frame.period.preset]
								: copy.record,
					openAria: copy.open,
					closeAria: copy.close,
					mobileVisible: !fullViewport,
				}
			: undefined}
	>
		{#if fullViewport}
			{@render main()}
		{:else}
			<div class="streaming-main">
				<RecordPatience {locale} period={frame.period} scope={url.pathname + url.search}>
					{@render main()}
				</RecordPatience>
			</div>
		{/if}
	</AppFrame>
</div>

<style>
	.desktop-controls-fallback {
		/* AppFrame's CSS chooses the rail layout before its client measurement. */
		display: var(--app-frame-rail-display, none);
		flex-direction: column;
	}
	.desktop-controls-fallback:empty {
		display: none;
	}
	/* The content slot inherits AppFrame's measured header height (including its SSR fallback). */
	.streaming-main:has(:global([data-record-pending])) {
		min-block-size: calc(100dvh - var(--app-frame-header-height) + var(--space-card-gap));
	}
	/* Bound the hidden paint even if a reading below the viewport is still pending. */
	.app-shell-root:has(.streaming-main :global([data-record-pending])) .streaming-footer {
		animation: reveal-streaming-footer 10s step-end;
	}
	@keyframes reveal-streaming-footer {
		from {
			visibility: hidden;
		}
		to {
			visibility: visible;
		}
	}
	@media print {
		.streaming-main:has(:global([data-record-pending])) {
			min-block-size: 0;
		}
	}
	/* The paired reading rail and the page surface share the card gutter. */
	@media (min-width: 64rem) {
		.app-shell-root[data-full-viewport='false']
			:global([data-slot='app-frame']:not([data-rail-layout='compact']) > .app-frame-body) {
			--space-page-x: var(--space-card-gap);
		}
	}
	.app-shell-root[data-full-viewport='true'] {
		--map-touch-controls-clearance: max(
			calc(1.625rem + env(safe-area-inset-bottom, 0px) + var(--size-tap-min)),
			calc(var(--floating-pill-clearance) + 0.5rem)
		);
		--map-touch-row-bottom: calc(
			var(--map-source-clearance, 0px) + var(--map-touch-controls-clearance)
		);
	}
	.map-rail {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		grid-auto-rows: max-content;
		min-inline-size: 0;
		gap: 1rem;
		transition: opacity var(--duration-normal) var(--ease-out);
	}
	.map-rail[data-map-rail-visible='false'] {
		visibility: hidden;
		opacity: 0;
	}
	@media (prefers-reduced-motion: reduce) {
		.map-rail {
			transition: none;
		}
	}
	.map-rail.desktop {
		max-block-size: max(
			0px,
			calc(
				100dvh - var(--app-frame-chrome-height, var(--nav-clearance)) -
					var(--map-source-clearance, 0px) - 2rem
			)
		);
		overflow-y: auto;
		overscroll-behavior: contain;
	}
	.map-rail.desktop:has(:global([data-record-legend])) {
		gap: 0.75rem;
	}
	.app-shell-root[data-full-viewport='true'] :global([data-slot='surface-rail-mobile']) {
		--surface-rail-stack-offset: var(--map-source-clearance);
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
