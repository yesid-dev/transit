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
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
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
	import {
		searchTransit,
		type ChromeSearchScope,
		type SearchList,
	} from '#lib/search/transitSearch.ts';
	import HeaderSearch from './HeaderSearch.svelte';
	import {
		type NavItem,
		NAV_ITEMS,
		visibleNav,
		YESID_HOUSE_LINK,
		isSurfaceActive,
	} from '#lib/content/nav.ts';
	import { navPillCopy } from '#lib/i18n/messages.ts';
	import { SiteHeader } from '@yesid/ui/layout';
	import RefreshButton from './RefreshButton.svelte';
	import { providerHref, providerHasAlerts, type PublicProvider } from '#lib/v1/providers.ts';
	import { v1Provider } from '#lib/v1/config.ts';

	interface NavPillProps {
		navigation: NavigationLifecycle;
		locale?: Locale;
		url?: URL;
		providerId?: string;
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

	const toItem = (item: NavItem) => ({
		href: localizeHref(item.href, locale, providerId),
		label: item.label[locale],
		current: isSurfaceActive(item, currentPath),
	});
	const MENU_ICONS: Record<NavItem['key'], Component<{ class?: string }>> = {
		overview: HouseIcon,
		map: MapIcon,
		lines: RouteIcon,
		stops: MapPinIcon,
		network: WaypointsIcon,
		metrics: RulerIcon,
		status: ActivityIcon,
		hotspots: FlameIcon,
		receipt: ReceiptIcon,
		repeatOffenders: RepeatIcon,
		alerts: TriangleAlertIcon,
	};
	const links = $derived(
		NAV_ITEMS.filter((item) => item.barLabel).map((item) => ({
			...toItem(item),
			label: item.barLabel![locale],
			priority: 3 as const,
		})),
	);
	const selectedProvider = $derived(providers.find((provider) => provider.id === providerId));
	const menuItems = $derived([
		...visibleNav({ alerts: selectedProvider ? providerHasAlerts(selectedProvider) : null }).map(
			(item) => ({
				...toItem(item),
				icon: MENU_ICONS[item.key],
			}),
		),
		{
			href: YESID_HOUSE_LINK.href,
			label: YESID_HOUSE_LINK.label[locale],
			external: true,
			icon: ExternalLinkIcon,
			ariaLabel: `${YESID_HOUSE_LINK.label[locale]} ${navCopy.newTab}`,
		},
	]);

	const providerText = (provider: PublicProvider) =>
		`${provider.labels[locale].city} · ${provider.labels[locale].operator}`;
	const providerLabel = $derived.by(() => {
		const provider = providers.find((candidate) => candidate.id === providerId);
		return provider ? providerText(provider) : providerId;
	});
	const providerShortLabel = $derived(
		providers.find((provider) => provider.id === providerId)?.labels[locale].operator ?? providerId,
	);

	let providerControl = $state<HTMLLabelElement>();

	// --pill-h spans the pill plus the provider row that drops below it on phones.
	$effect(() => {
		if (!providerControl || typeof ResizeObserver === 'undefined') return;
		const control = providerControl;
		const pill = control.closest<HTMLElement>('[data-testid="nav-pill"]')!;
		const root = control.ownerDocument.documentElement;
		const measure = () => {
			const box = pill.getBoundingClientRect();
			root.style.setProperty(
				'--pill-h',
				`${Math.ceil(Math.max(box.bottom, control.getBoundingClientRect().bottom) - box.top)}px`,
			);
		};
		const observer = new ResizeObserver(measure);
		observer.observe(pill.closest('[data-slot="site-header"]')!);
		measure();
		return () => {
			observer.disconnect();
			root.style.removeProperty('--pill-h');
		};
	});
</script>

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

{#snippet actions()}
	<!-- The visible label is its own element, centred in the control; the native select sits on top, transparent. -->
	<label bind:this={providerControl} class="nav-provider">
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
				<option value={provider.id}>{providerText(provider)}</option>
			{/each}
			{#if !providers.length}
				<option value={providerId}>{providerId}</option>
				{#if providerId !== v1Provider()}
					<option value={v1Provider()}>{navCopy.defaultNetwork}</option>
				{/if}
			{/if}
			{#if discoveryError}
				<option value="" disabled>{navCopy.otherNetworksUnavailable}</option>
			{/if}
		</select>
	</label>
	<RefreshButton {locale} class="nav-refresh" />
	<a
		href={localizeHref('/search', locale, providerId)}
		class="tap-press nav-compact-search"
		aria-label={searchAria}
		data-slot="nav-compact-search"
	>
		<SearchIcon size={17} strokeWidth={1.8} aria-hidden="true" />
	</a>
{/snippet}

<SiteHeader
	{navigation}
	home={localizeHref('/', locale, providerId)}
	wordmark="Transit"
	{links}
	{menuItems}
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

<style>
	:root {
		--pill-h: 72px;
	}

	/* Decision 7: the city sits on the pill's own surface, its label centred. */
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
		.nav-provider-full {
			display: none;
		}
		.nav-provider-short {
			display: block;
		}
		.nav-provider {
			--size-provider-select: calc(100cqi - 2rem);
			position: absolute;
			inset-block-start: calc(100% + 8px);
			inset-inline-start: 50%;
			transform: translateX(-50%);
			padding-inline: 1rem;
			border: 2px solid var(--border-brand);
			border-radius: var(--radius-pill);
			background: color-mix(in srgb, var(--background) 92%, transparent);
			-webkit-backdrop-filter: blur(var(--glass-blur));
			backdrop-filter: blur(var(--glass-blur));
			box-shadow: var(--shadow-nav);
		}
	}

	:global(.nav-refresh) {
		min-width: 44px;
		min-height: 44px;
	}

	.nav-compact-search {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 44px;
		height: 44px;
		padding: 0;
		color: var(--secondary-foreground);
		background: transparent;
		border-radius: var(--radius-lg);
		text-decoration: none;
		transition:
			color var(--duration-fast) var(--ease-default),
			background var(--duration-fast) var(--ease-default);
	}
	.nav-compact-search:hover {
		color: var(--primary);
		background: var(--muted);
	}
	.nav-compact-search:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 1px;
	}
	@container site-header (width >= 1024px) {
		.nav-compact-search {
			display: none;
		}
	}

	@media (--tablet-max) {
		:root {
			--pill-h: 64px;
		}
	}
	@media (max-width: 599px) {
		:root {
			--pill-h: 110px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.nav-compact-search {
			transition: none;
		}
	}
</style>
