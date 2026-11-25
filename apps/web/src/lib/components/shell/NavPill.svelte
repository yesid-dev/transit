<script lang="ts">
	import type { LivePresentation } from '#lib/v1/live/livePresentation.ts';
	import type { NavigationLifecycle } from '@yesid/ui/brand';
	import type { Component } from 'svelte';
	import HouseIcon from '@lucide/svelte/icons/house';
	import MapIcon from '@lucide/svelte/icons/map';
	import RouteIcon from '@lucide/svelte/icons/route';
	import MapPinIcon from '@lucide/svelte/icons/map-pin';
	import WaypointsIcon from '@lucide/svelte/icons/waypoints';
	import RulerIcon from '@lucide/svelte/icons/ruler';
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import FlameIcon from '@lucide/svelte/icons/flame';
	import ReceiptIcon from '@lucide/svelte/icons/receipt';
	import RepeatIcon from '@lucide/svelte/icons/repeat';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import TramFrontIcon from '@lucide/svelte/icons/tram-front';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import {
		type Locale,
		DEFAULT_LOCALE,
		PUBLISHED_LOCALES,
		delocalizePath,
		getLocale,
		localizeHref,
		localizeUrl,
	} from '#lib/i18n/index.ts';
	import { searchTransit, type SearchList } from '#lib/search/transitSearch.ts';
	import HeaderSearch from './HeaderSearch.svelte';
	import SearchSheet from './SearchSheet.svelte';
	import {
		carryFrameState,
		frameHref,
		parseFrameState,
		type FrameClock,
	} from '#lib/site/frameState.ts';
	import {
		type NavItem,
		FRAME_MENU,
		NAV_GROUPS,
		YESID_HOUSE_LINK,
		isSurfaceActive,
	} from '#lib/content/nav.ts';
	import { navPillCopy } from '#lib/i18n/messages.ts';
	import { ProductBrand } from '@yesid/ui/brand';
	import { NetworkPicker, SiteHeader } from '@yesid/ui/layout';
	import { providerHref, type PublicProvider } from '#lib/v1/providers.ts';
	import { v1Provider } from '#lib/v1/config.ts';
	import { providerDisplayNames, publishedNetwork } from '#lib/site/providerDisplay.ts';

	interface NavPillProps {
		navigation: NavigationLifecycle;
		locale?: Locale;
		url?: URL;
		providerId?: string;
		clock: FrameClock;
		providers?: PublicProvider[];
		discoveryError?: boolean;
		search?: string;
		searchList?: SearchList;
		searchPresentation?: LivePresentation | null;
		availableLocales?: readonly Locale[];
	}

	let {
		navigation,
		locale: localeProp,
		url = new URL('https://transit.local/'),
		providerId = v1Provider(url),
		clock,
		providers = [],
		discoveryError = false,
		search = $bindable(''),
		searchList = searchTransit({ surface: 'list', query: '' }, {}),
		searchPresentation,
		availableLocales = PUBLISHED_LOCALES,
	}: NavPillProps = $props();

	const ctxLocale = getLocale();
	const locale = $derived<Locale>(localeProp ?? ctxLocale ?? DEFAULT_LOCALE);
	const selectedUrl = $derived(
		new URL(localizeHref(url.pathname + url.search + url.hash, locale, providerId), url),
	);
	const currentPath = $derived(delocalizePath(url.pathname));

	const navCopy = $derived(navPillCopy[locale]);
	const searchAria = $derived(navCopy.searchAria.all);

	const hrefFor = (href: string) => {
		const localized = localizeHref(href, locale, providerId);
		if (href !== '/receipt') return carryFrameState(localized, url);
		const { period } = parseFrameState(url.searchParams, clock);
		return frameHref(new URL(localized, url), { mode: 'record', period });
	};
	const home = $derived(hrefFor('/'));
	const toItem = (item: NavItem) => ({
		href: hrefFor(item.href),
		label: item.label[locale],
		current: isSurfaceActive(item, currentPath),
	});
	const MENU_ICONS: Record<NavItem['key'], Component<{ class?: string }>> = {
		overview: HouseIcon,
		map: MapIcon,
		lines: RouteIcon,
		stops: MapPinIcon,
		vehicles: TramFrontIcon,
		download: DownloadIcon,
		network: WaypointsIcon,
		metrics: RulerIcon,
		status: ActivityIcon,
		hotspots: FlameIcon,
		receipt: ReceiptIcon,
		repeatOffenders: RepeatIcon,
		alerts: TriangleAlertIcon,
	};
	const links = $derived(
		FRAME_MENU.filter((item) => item.barLabel).map((item) => ({
			...toItem(item),
			label: item.barLabel![locale],
			priority: 3 as const,
		})),
	);
	const menuGroups = $derived(
		NAV_GROUPS.map((group) => ({
			label: group.label[locale],
			items: FRAME_MENU.filter((item) => item.group === group.key).map((item) => ({
				...toItem(item),
				icon: MENU_ICONS[item.key],
			})),
		})),
	);

	// Use the published provider names when the live catalog cannot be loaded.
	const providerNames = (provider: Pick<PublicProvider, 'id' | 'labels'>) =>
		providerDisplayNames(provider, locale, navCopy.unknownNetwork);
	const networkOptions = $derived(
		providers.flatMap((provider) => {
			const { full, short } = providerNames(provider);
			const suffix = ` · ${short}`;
			const city = full.endsWith(suffix) ? full.slice(0, -suffix.length) : '';
			return city ? [{ id: provider.id, city, name: short, shortCode: short }] : [];
		}),
	);
	const useKitNetworkPicker = $derived(
		!discoveryError &&
			networkOptions.length === providers.length &&
			networkOptions.some((network) => network.id === providerId),
	);
	const selectedProvider = $derived(
		providers.find((provider) => provider.id === providerId) ?? publishedNetwork(providerId),
	);
	const selectedNames = $derived(selectedProvider ? providerNames(selectedProvider) : undefined);
	const providerLabel = $derived(selectedNames?.full ?? navCopy.unknownNetwork);
	const providerShortLabel = $derived(selectedNames?.short ?? providerLabel);
	const defaultProvider = $derived(publishedNetwork(v1Provider()));

	let headerFrame = $state<HTMLDivElement>();

	// Scroll padding and map overlays use the measured chrome. Page content follows it in flow.
	$effect(() => {
		if (!headerFrame || typeof ResizeObserver === 'undefined') return;
		const header = headerFrame.querySelector<HTMLElement>('[data-slot="site-header"]')!;
		const doc = header.ownerDocument;
		const root = doc.documentElement;
		const measure = () => {
			const box = header.getBoundingClientRect();
			const chromeBottom = box.bottom;
			const navTop = parseFloat(getComputedStyle(header).paddingBlockStart);
			root.style.setProperty('--pill-h', `${Math.ceil(box.height - navTop)}px`);

			// Native focus can treat a link behind fixed chrome as already visible.
			// Refresh the clearance and reveal keyboard focus when the header grows or focus moves.
			const focused = doc.activeElement;
			if (
				!(focused instanceof HTMLElement) ||
				!focused.matches(':focus-visible') ||
				!focused.closest('[data-slot="footer"]')
			)
				return;
			const { top, bottom } = focused.getBoundingClientRect();
			if (top < chromeBottom || bottom > root.clientHeight) {
				focused.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
			}
		};
		const onFocusIn = (event: FocusEvent) => {
			if (event.target instanceof Element && event.target.closest('[data-slot="footer"]'))
				measure();
		};
		const observer = new ResizeObserver(measure);
		observer.observe(header);
		doc.addEventListener('focusin', onFocusIn);
		measure();
		return () => {
			observer.disconnect();
			doc.removeEventListener('focusin', onFocusIn);
			root.style.removeProperty('--pill-h');
		};
	});
</script>

{#snippet brand()}
	<ProductBrand
		product="Transit"
		href={home}
		houseHref={YESID_HOUSE_LINK.href}
		houseExternal
		houseLabel={`yesid. ${navCopy.newTab}`}
		class="nav-product-brand"
	/>
{/snippet}

{#snippet searchField()}
	<HeaderSearch
		bind:query={search}
		{locale}
		{providerId}
		{url}
		list={searchList}
		presentation={searchPresentation}
	/>
{/snippet}

{#snippet network()}
	<!-- The visible label is its own element, centred in the control; the native select sits on top, transparent. -->
	{#if useKitNetworkPicker}
		<NetworkPicker
			label={`${navCopy.network}: ${providerLabel}`}
			networks={networkOptions}
			value={providerId}
			onValueChange={(id) => location.assign(providerHref(url, id, locale))}
		/>
	{:else}
		<label class="nav-provider">
			<span class="nav-provider-label nav-provider-full" aria-hidden="true" title={providerLabel}
				>{providerLabel}</span
			>
			<span class="nav-provider-label nav-provider-short" aria-hidden="true" title={providerLabel}
				>{providerShortLabel}</span
			>
			<select
				class="nav-provider-select"
				aria-label={`${navCopy.network}: ${providerLabel}`}
				title={providerLabel}
				value={providerId}
				onchange={(event) => {
					const href = providerHref(url, event.currentTarget.value, locale);
					event.currentTarget.value = providerId;
					location.assign(href);
				}}
			>
				{#each providers as provider (provider.id)}
					<option value={provider.id}>{providerNames(provider).full}</option>
				{/each}
				{#if !providers.length}
					<option value={providerId}>{providerLabel}</option>
					{#if providerId !== v1Provider()}
						<option value={v1Provider()}>
							{defaultProvider ? providerNames(defaultProvider).full : navCopy.defaultNetwork}
						</option>
					{/if}
				{/if}
				{#if discoveryError}
					<option value="" disabled>{navCopy.otherNetworksUnavailable}</option>
				{/if}
			</select>
		</label>
	{/if}
{/snippet}

{#snippet actions()}
	<SearchSheet
		bind:query={search}
		{locale}
		{providerId}
		{url}
		list={searchList}
		presentation={searchPresentation}
		label={searchAria}
	/>
{/snippet}

<div bind:this={headerFrame} class="frame-nav" data-slot="frame-nav">
	<SiteHeader
		{navigation}
		{home}
		{brand}
		{links}
		linkTiers={{ priority3: 1280 }}
		{menuGroups}
		labels={navCopy}
		language={{
			locale,
			locales: availableLocales,
			href: (next) => localizeUrl(selectedUrl, next as Locale),
			label: navCopy.language,
			names: navCopy.names,
			reload: true,
		}}
		search={searchField}
		{network}
		{actions}
	/>
</div>

<style>
	/* The map and portalled overlays still need a pre-hydration inset. It never pads page content. */
	:root {
		--pill-h: 140px;
	}
	.frame-nav {
		padding-block-end: var(--chrome-gap);
		pointer-events: none;
	}

	/* The full brand leaves too little room for French search and the controls at 414px.
	   Keep the product name on phones. The house link is in the menu. */
	:global(.nav-product-brand) {
		flex-shrink: 0;
		white-space: nowrap;
	}
	@container site-header (width < 432px) {
		:global(.nav-product-brand) {
			font-size: 1rem;
		}
		:global(.nav-product-brand > [data-slot='wordmark']),
		:global(.nav-product-brand > [aria-hidden='true']) {
			display: none;
		}
	}

	.nav-provider {
		--size-provider-select: 12.5rem;
		position: relative;
		display: inline-grid;
		place-items: center;
		max-width: var(--size-provider-select);
		min-height: 44px;
		padding-inline: 0.75rem;
		border-radius: var(--radius-sm);
		color: var(--foreground);
	}
	.nav-provider-label {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		pointer-events: none;
	}
	.nav-provider-select {
		min-block-size: var(--size-tap-min);
		position: absolute;
		inset-inline: 0;
		inset-block-start: 50%;
		transform: translateY(-50%);
		width: 100%;
		opacity: 0;
		font: inherit;
		cursor: pointer;
	}
	.nav-provider-short {
		display: none;
	}
	.nav-provider-select option {
		background: var(--background);
		color: var(--foreground);
	}
	.nav-provider:has(:focus-visible) {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
	@container site-header (width < 600px) {
		/* Larger text can use a second row without shrinking any control's target. */
		:global(.nav-pill) {
			max-width: calc(100cqi - 8px);
			flex-wrap: wrap;
			justify-content: center;
		}
	}
	@media (width < 600px) {
		.nav-provider-full {
			display: none;
		}
		.nav-provider-short {
			display: block;
		}
		.nav-provider {
			max-width: 100%;
			padding-inline: 0.5rem;
		}
	}
</style>
