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
	import SearchIcon from '@lucide/svelte/icons/search';
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
		searchList = searchTransit({ query: '' }, {}),
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

	/*
	 * Choosing a city changes the page, so it never follows arrow keys alone (WCAG 3.2.2). Keys
	 * that move a closed select only preview the city; Enter switches to it, and Escape or leaving
	 * the picker keeps the current one. A pointer or the open option list switches at once.
	 */
	const PREVIEW_KEYS = new Set([
		'ArrowUp',
		'ArrowDown',
		'ArrowLeft',
		'ArrowRight',
		'Home',
		'End',
		'PageUp',
		'PageDown',
	]);
	let previewNetwork = $state<string | null>(null);
	let keyedNetwork = false;
	const shownNetwork = $derived(previewNetwork ?? providerId);
	const previewNames = $derived.by(() => {
		if (!previewNetwork) return undefined;
		const provider =
			providers.find((entry) => entry.id === previewNetwork) ?? publishedNetwork(previewNetwork);
		return provider ? providerNames(provider) : undefined;
	});
	const switchNetwork = (id: string) => location.assign(providerHref(url, id, locale));
	function chooseNetwork(id: string): void {
		if (keyedNetwork) previewNetwork = id === providerId ? null : id;
		else if (id !== providerId) switchNetwork(id);
	}
	function networkKeydown(event: KeyboardEvent): void {
		if (event.key === 'Enter' && previewNetwork) {
			event.preventDefault();
			switchNetwork(previewNetwork);
		} else if (event.key === 'Escape' && previewNetwork) {
			event.preventDefault();
			previewNetwork = null;
		}
		keyedNetwork =
			!event.altKey &&
			!event.ctrlKey &&
			!event.metaKey &&
			(PREVIEW_KEYS.has(event.key) || (event.key.length === 1 && event.key !== ' '));
	}
	function leaveNetwork(): void {
		keyedNetwork = false;
		previewNetwork = null;
	}

	let headerFrame = $state<HTMLDivElement>();
	let searchSheet = $state<ReturnType<typeof SearchSheet>>();

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
	<!-- Beside the page links (1024 to 1279 px) the field gives way to this button and the sheet. -->
	<button
		type="button"
		class="tap-press nav-compact-search"
		aria-label={searchAria}
		data-slot="nav-search-button"
		onclick={() => searchSheet?.show()}
	>
		<SearchIcon size={17} strokeWidth={1.8} aria-hidden="true" />
	</button>
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
	<span
		class="network-choice"
		data-slot="network-choice"
		onkeydowncapture={networkKeydown}
		onpointerdowncapture={() => (keyedNetwork = false)}
		onfocusout={leaveNetwork}
	>
		{#if useKitNetworkPicker}
			<NetworkPicker
				label={`${navCopy.network}${locale === 'fr' ? '\u00a0' : ''}: ${providerLabel}`}
				networks={networkOptions}
				value={shownNetwork}
				onValueChange={chooseNetwork}
			/>
		{:else}
			<label class="nav-provider">
				<span
					class="nav-provider-label nav-provider-full"
					aria-hidden="true"
					title={previewNames?.full ?? providerLabel}>{previewNames?.full ?? providerLabel}</span
				>
				<span
					class="nav-provider-label nav-provider-short"
					aria-hidden="true"
					title={previewNames?.full ?? providerLabel}
					>{previewNames?.short ?? providerShortLabel}</span
				>
				<select
					class="nav-provider-select"
					aria-label={`${navCopy.network}${locale === 'fr' ? '\u00a0' : ''}: ${providerLabel}`}
					title={providerLabel}
					value={shownNetwork}
					onchange={(event) => {
						const id = event.currentTarget.value;
						event.currentTarget.value = shownNetwork;
						chooseNetwork(id);
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
		<span class="sr-only" role="status"
			>{previewNames ? `${navCopy.networkConfirm} ${previewNames.full}.` : ''}</span
		>
	</span>
{/snippet}

{#snippet actions()}
	<SearchSheet
		bind:this={searchSheet}
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
	/* Below 1024px AppFrame measures SiteHeader directly for the transparent vacated network band. */
	@media (width < 1024px) {
		.frame-nav {
			display: contents;
		}
	}

	/* "yesid. | Transit" at every width, as on yesid.dev and in the wireframe: on phones the search
	   is an icon button, which leaves the brand its room. */
	:global(.nav-product-brand) {
		flex-shrink: 0;
		white-space: nowrap;
	}
	@container site-header (width < 432px) {
		:global(.nav-product-brand) {
			font-size: 1rem;
		}
	}
	/* Below 360px the pill tightens every split to 2px, which sets "yesid." and "Transit" against
	   their dividers. The brand keeps the phone tier's 4px (as at 390px), and the divider after it
	   gets 4px on both sides from the brand and the search button; the pill still holds every
	   control on one row at 320px. */
	@media (max-width: 359px) {
		:global(.nav-product-brand) {
			--nav-split-space: 4px;
			margin-inline-end: 2px;
		}
		:global(.nav-compact-search) {
			margin-inline-start: 2px;
		}
	}

	.network-choice {
		display: contents;
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
