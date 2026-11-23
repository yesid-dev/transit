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
	import {
		searchTransit,
		type ChromeSearchScope,
		type SearchList,
	} from '#lib/search/transitSearch.ts';
	import HeaderSearch from './HeaderSearch.svelte';
	import SearchSheet from './SearchSheet.svelte';
	import FrameControls from './FrameControls.svelte';
	import { carryFrameState, frameHref, frameToday, parseFrameState } from '#lib/site/frameState.ts';
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
	import RefreshButton from './RefreshButton.svelte';
	import { providerHref, type PublicProvider } from '#lib/v1/providers.ts';
	import { v1Provider } from '#lib/v1/config.ts';
	import { providerDisplayNames, publishedNetwork } from '#lib/site/providerDisplay.ts';

	interface NavPillProps {
		navigation: NavigationLifecycle;
		locale?: Locale;
		url?: URL;
		providerId?: string;
		timeZone?: string;
		providers?: PublicProvider[];
		discoveryError?: boolean;
		search?: string;
		searchList?: SearchList;
		searchPresentation?: LivePresentation | null;
		searchScope?: ChromeSearchScope;
		availableLocales?: readonly Locale[];
	}

	let {
		navigation,
		locale: localeProp,
		url = new URL('https://transit.local/'),
		providerId = v1Provider(url),
		timeZone,
		providers = [],
		discoveryError = false,
		search = $bindable(''),
		searchList = searchTransit({ surface: 'list', query: '' }, {}),
		searchPresentation,
		searchScope = 'all',
		availableLocales = PUBLISHED_LOCALES,
	}: NavPillProps = $props();

	const ctxLocale = getLocale();
	const locale = $derived<Locale>(localeProp ?? ctxLocale ?? DEFAULT_LOCALE);
	const selectedUrl = $derived(
		new URL(localizeHref(url.pathname + url.search + url.hash, locale, providerId), url),
	);
	const currentPath = $derived(delocalizePath(url.pathname));

	const navCopy = $derived(navPillCopy[locale]);
	const searchAria = $derived(
		navCopy.searchAria[searchScope === 'route' || searchScope === 'stop' ? searchScope : 'all'],
	);

	const hrefFor = (href: string) => {
		const localized = localizeHref(href, locale, providerId);
		if (href !== '/receipt') return carryFrameState(localized, url);
		const { period } = parseFrameState(url.searchParams, frameToday(timeZone));
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

	let scopeControls = $state<HTMLDivElement>();

	// Scroll padding and map overlays use the measured chrome. Page content follows it in flow.
	$effect(() => {
		if (!scopeControls || typeof ResizeObserver === 'undefined') return;
		const control = scopeControls;
		const pill = control.parentElement!.querySelector<HTMLElement>('[data-testid="nav-pill"]')!;
		const doc = control.ownerDocument;
		const root = doc.documentElement;
		const measure = () => {
			const box = pill.getBoundingClientRect();
			const chromeBottom = Math.max(box.bottom, control.getBoundingClientRect().bottom);
			root.style.setProperty('--pill-h', `${Math.ceil(chromeBottom - box.top)}px`);

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
		observer.observe(pill.closest('[data-slot="site-header"]')!);
		observer.observe(control);
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
		scope={searchScope}
		list={searchList}
		presentation={searchPresentation}
	/>
{/snippet}

{#snippet scope()}
	<div
		bind:this={scopeControls}
		class="nav-scope"
		data-slot="app-frame-controls"
		data-lenis-prevent
	>
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
		<FrameControls {locale} {url} {timeZone} />
	</div>
{/snippet}

{#snippet actions()}
	<RefreshButton {locale} class="nav-refresh" />
	<SearchSheet
		bind:query={search}
		{locale}
		{providerId}
		{url}
		scope={searchScope}
		list={searchList}
		presentation={searchPresentation}
		label={searchAria}
	/>
{/snippet}

<div class="frame-nav" data-slot="frame-nav">
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
		{actions}
	/>
	{@render scope()}
</div>

<style>
	/* The map and portalled overlays still need a pre-hydration inset. It never pads page content. */
	:root {
		--pill-h: 140px;
	}
	.frame-nav {
		position: sticky;
		inset-block-start: var(--announcement-height, 0px);
		z-index: var(--z-nav);
		flex: none;
		padding-block: var(--nav-top) var(--chrome-gap);
		pointer-events: none;
	}
	/* Keep the kit's dialog and pill in flow. The open menu still covers the viewport. */
	.frame-nav :global(.menu-dialog) {
		position: relative;
		inset: auto;
	}
	.frame-nav :global(.menu-dialog-active)::before {
		content: '';
		position: fixed;
		inset: 0;
		z-index: -1;
		background: inherit;
	}
	.frame-nav :global([data-slot='site-header']) {
		position: relative;
		inset-block-start: auto;
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

	.nav-scope {
		position: relative;
		inset-inline-end: calc(var(--site-header-inset-end, 0px) / 2);
		margin: 6px auto 0;
		pointer-events: auto;
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		align-items: center;
		gap: 0.25rem 0.5rem;
		inline-size: max-content;
		max-inline-size: calc(100% - 1rem - var(--site-header-inset-end, 0px));
		padding: 0.125rem 0.5rem;
		border: 2px solid var(--border-brand);
		border-radius: var(--radius-lg);
		background: var(--background);
	}

	:global([data-full-viewport='true']) .nav-scope {
		max-block-size: max(var(--size-tap-min), 20dvh);
		overflow-y: auto;
		overscroll-behavior: contain;
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

	:global(.nav-refresh) {
		min-width: 44px;
		min-height: 44px;
	}
	/* Below a 600 px header Refresh waits in the open menu, whose dialog holds the pill. */
	@container site-header (width < 600px) {
		:global(.nav-refresh:not([role='dialog'][aria-modal='true'] .nav-refresh)) {
			display: none;
		}
	}

	@media (--tablet-max) {
		:root {
			--pill-h: 118px;
		}
	}
</style>
