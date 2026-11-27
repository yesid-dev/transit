<script module lang="ts">
	import { FOOTER_INFO_NAV } from '#lib/content/nav.ts';

	export function isDataIndependentRoute(pathname: string): boolean {
		return pathname === '/download' || FOOTER_INFO_NAV.some((item) => item.href === pathname);
	}
</script>

<script lang="ts">
	import * as Collapsible from '@yesid/ui/collapsible';
	import { setPageTitleContext, resolvePageTitle } from '#lib/seo/pageTitle.ts';
	const clientTitle = setPageTitleContext();
	import { publishedNetwork } from '#lib/site/providerDisplay.ts';
	import { agencyName } from '#lib/site/presenter.ts';
	import { providerSourceAttribution } from '#lib/i18n/providerAttribution.ts';
	import { setContext } from 'svelte';
	import { mapLayerFor } from '#lib/site/mapFrame.ts';
	import {
		mapPanelOpenContext,
		mapRecordSourceDateContext,
	} from '#lib/site/mapRecordSourceDate.ts';
	import { liveSourceDate } from '#lib/live/sourceDate.ts';
	import { createLineDirectory } from '#lib/site/lineDirectory.ts';
	import { setLineDirectory } from '#lib/site/transitDisplayContext.ts';
	import { routeNameFallback } from '#lib/site/absence.ts';
	import { navPillCopy } from '#lib/i18n/messages.ts';
	import { providerHasAlerts } from '#lib/v1/providers.ts';
	import '@yesid/tokens/fonts.css';
	import '@yesid/motion/ripple.css';
	import '../app.css';

	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { createNavigationLifecycle } from '@yesid/ui/brand';
	import { updated } from '$app/state';

	import { onNavigate, beforeNavigate, afterNavigate, invalidateAll } from '$app/navigation';

	import { browser } from '$app/env';
	import { startAnalytics } from '#lib/site/analytics.ts';
	import {
		setLocaleContext,
		DEFAULT_LOCALE,
		SUPPORTED_LOCALES,
		delocalizePath,
		localizeHref,
		type Locale,
	} from '#lib/i18n/index.ts';
	import { SeoHead } from '@yesid/ui/head';
	import {
		resolveRouteSeo,
		canonicalRoutePath,
		isEphemeralPath,
		breadcrumbItemsForHead,
		resolveDatasetSeo,
		MAP_RECORD,
	} from '#lib/seo/routeSeo.ts';
	import {
		breadcrumbJsonLd,
		organizationJsonLd,
		datasetJsonLd,
		websiteJsonLd,
		type JsonLdNode,
	} from '#lib/seo/jsonld.ts';
	import { readPublicSiteConfig } from '#lib/site/config.ts';
	import { currentMirrorUrl } from '#lib/site/urlMirror.ts';
	import { errorDocumentHead } from '#lib/site/errorPage.ts';
	import { setV1Context } from '#lib/v1/boot.ts';
	import { loadSearchIndex, searchIndexList } from '#lib/search/searchIndex.ts';
	import { sitePages } from '#lib/search/sitePages.ts';
	import { createResource } from '#lib/v1/resource.svelte.ts';
	import { dataPulse } from '#lib/stores/index.ts';
	import { registerServiceWorker } from '#lib/pwa/register.ts';
	import { decideFreshnessReload } from '#lib/pwa/appVersion.ts';
	import { startVitals } from '@yesid/analytics/vitals';

	import * as env from '$app/env/public';

	import { viewTransition } from '@yesid/motion/utils/viewTransition';
	import { initGlobalRipple } from '@yesid/motion/utils/globalRipple';
	import { getLenis } from '@yesid/motion/utils/lenis';
	import { AppShell } from '#lib/components/shell/index.ts';
	import BrandCluster from '#lib/components/brand/BrandCluster.svelte';
	import { footerCopy } from '#lib/components/layout/footer.copy.ts';
	import { EdgeState } from '#lib/components/edge/index.ts';
	import { Separator } from '@yesid/ui/separator';
	import { SiteFooter, SiteRoot } from '@yesid/ui/layout';
	import { ConstructionProps } from '@yesid/ui/brand';
	import { desktop } from '@yesid/ui/state';
	import { NAV_GROUPS, visibleNav, YESID_HOUSE_LINK, mainLandmarkLabel } from '#lib/content/nav.ts';
	import { legalCopy } from '#lib/features/legal/legal.copy.ts';
	import { searchQueryState } from '#lib/search/transitSearch.ts';
	import type { LayoutData } from './$types';

	const navigation = createNavigationLifecycle({
		beforeNavigate,
		onNavigate,
		afterNavigate,
	});

	let { data, children }: { data: LayoutData; children: import('svelte').Snippet } = $props();

	const locale = $derived<Locale>(data.lang ?? DEFAULT_LOCALE);
	const lineDirectory = $derived(
		createLineDirectory(data.schedule?.routes ?? null, {
			line: (id) => routeNameFallback(id, locale),
			locale,
			nameSeparators: data.provider?.name_separators,
			patterns: data.patterns,
		}),
	);
	setLineDirectory(() => lineDirectory);
	setLocaleContext(
		() => data.lang ?? DEFAULT_LOCALE,
		() => data.providerId,
	);

	const siteConfig = readPublicSiteConfig();
	const seoPath = $derived(delocalizePath(page.url.pathname));
	const isOverviewRecord = $derived(seoPath === '/' && page.data.record != null);
	let constructionEdge = $state<HTMLElement>();
	let constructionProgress = $state(1);

	const noIndex = $derived(!siteConfig.indexing || isEphemeralPath(page.url.pathname));

	const isFullBleed = $derived(seoPath === '/map');
	const dataIndependentRoute = $derived(isDataIndependentRoute(seoPath));

	const v1 = $derived(data.v1);
	setV1Context(() => v1 ?? undefined);
	const legalRoute = $derived(FOOTER_INFO_NAV.some((item) => item.href === seoPath));
	const recordMap = $derived(
		isFullBleed && mapLayerFor(currentMirrorUrl().searchParams) !== 'live',
	);
	// The Record map is named as the record, never as the live map (WCAG 2.4.2).
	const mainLabel = $derived(recordMap ? MAP_RECORD.title : mainLandmarkLabel(seoPath));
	let mapRecordSourceDate = $state<string | null>(null);
	let mapCreditHeight = $state(0);
	let mapCreditOpen = $state(false);
	const datedMapCredit = $derived(Boolean(data.provider?.download_licence?.source_date_required));
	const mapCreditExpanded = $derived(datedMapCredit && mapCreditOpen);
	let mapPanelOpen = $state(false);
	setContext(mapPanelOpenContext, (open: boolean) => {
		mapPanelOpen = open;
	});
	setContext(mapRecordSourceDateContext, (date: string | null) => {
		mapRecordSourceDate = date;
	});
	const footerWords = $derived(footerCopy[locale]);
	const footerSeparator = ' ';
	const footerAgency = $derived(
		data.provider?.labels[locale].operator ??
			v1?.manifest.display_name ??
			publishedNetwork(data.providerId)?.labels[locale].operator ??
			footerWords.providerFallback,
	);
	const fallbackAttribution = $derived(
		v1
			? {
					provider: v1.manifest.provider,
					attribution: v1.manifest.attribution,
				}
			: undefined,
	);
	const footerAttribution = $derived(
		legalRoute
			? legalCopy[locale].footerAttribution
			: providerSourceAttribution(
					data.provider,
					locale,
					recordMap ? mapRecordSourceDate : v1 ? liveSourceDate(v1.manifest.provider) : null,
					fallbackAttribution,
				),
	);
	const footerGroups = $derived(
		[
			...NAV_GROUPS.map((group) => ({
				label: group.key === 'reports' ? footerWords.reportsLabel : group.label[locale],
				links: visibleNav({
					alerts: data.provider ? providerHasAlerts(data.provider) : null,
				}).filter((item) => item.group === group.key),
			})),
			{ label: footerWords.infoLabel, links: FOOTER_INFO_NAV, testId: 'footer-info' },
		].map((group) => ({
			...group,
			links: [
				...group.links,
				...(group.label === NAV_GROUPS[3].label[locale] ? [YESID_HOUSE_LINK] : []),
			].map((link) => ({
				href: localizeHref(link.href, locale, data.providerId),
				label: link.label[locale],
				...(link === YESID_HOUSE_LINK
					? { external: true, ariaLabel: `${link.label[locale]} ${navPillCopy[locale].newTab}` }
					: {}),
			})),
		})),
	);

	const seo = $derived(
		resolveRouteSeo(
			new URL(page.url.href),
			locale,
			!data.discoveryError && data.provider
				? {
						id: data.provider.id,
						shortName: data.provider.labels[locale].operator,
						city: data.provider.labels[locale].city,
					}
				: undefined,
		),
	);

	const seoSiteName = $derived(seo.siteName);
	const isErrorStatus = $derived((page.status ?? 200) >= 400);
	const errorHead = $derived(errorDocumentHead(page.status ?? 500, locale, page.error?.code));
	const headTitle = $derived(
		resolvePageTitle(
			isErrorStatus ? errorHead.title : null,
			$clientTitle?.(),
			page.data.seoTitle,
			seo.title,
		),
	);
	const headDescription = $derived(isErrorStatus ? errorHead.description : seo.description);
	const headSiteName = $derived(isErrorStatus ? 'Transit' : seoSiteName);

	const datasetCopy = $derived(resolveDatasetSeo(locale));
	const jsonLd = $derived.by(() => {
		if (isErrorStatus) return [];
		const nodes: JsonLdNode[] = [
			organizationJsonLd({ siteOrigin: siteConfig.siteOrigin, siteName: 'Transit' }),
			datasetJsonLd({
				siteOrigin: siteConfig.siteOrigin,
				siteName: 'Transit',
				name: datasetCopy.name,
				description: datasetCopy.description,
				locale,
			}),
		];

		const breadcrumb = breadcrumbJsonLd(
			breadcrumbItemsForHead(
				page.url.pathname,
				locale,
				siteConfig.siteOrigin,
				seo.providerId,
				page.data.seoTitle,
			),
		);

		if (breadcrumb) nodes.push(breadcrumb);
		return nodes;
	});
	const headHref = (lang: Locale) =>
		`${siteConfig.siteOrigin}${localizeHref(
			canonicalRoutePath(new URL(page.url.href)),
			lang,
			seo.providerId,
		)}`;
	const head = $derived({
		title: headTitle === headSiteName ? headTitle : `${headTitle} · ${headSiteName}`,
		description: headDescription,
		siteName: headSiteName,
		canonical: isErrorStatus ? undefined : headHref(locale),
		alternates: [
			...SUPPORTED_LOCALES.map((lang) => ({ hreflang: lang, href: headHref(lang) })),
			{ hreflang: 'x-default', href: headHref(DEFAULT_LOCALE) },
		],
		ogLocale: `${locale}_CA`,
		ogLocaleAlternates: SUPPORTED_LOCALES.filter((lang) => lang !== locale).map(
			(lang) => `${lang}_CA`,
		),
		image: {
			url: `${siteConfig.siteOrigin}${seo.imagePath}`,
			alt: seo.imageAlt,
		},
		noIndex: noIndex || isErrorStatus,
		twitter: { site: siteConfig.twitterSite, creator: siteConfig.twitterCreator },
		author: siteConfig.author,
		jsonLd: [
			websiteJsonLd({
				siteOrigin: siteConfig.siteOrigin,
				siteName: 'Transit',
				locale,
				providerId: seo.providerId,
			}),
			...jsonLd,
		],
	});
	$effect(() => dataPulse.subscribeCapture(v1?.manifest.provider ?? null));

	const edgeLayout = $derived(desktop.current ? 'desktop' : 'mobile');
	let topSearch = $state('');
	const chromeSearchEnabled = $derived(searchQueryState(topSearch) === 'ready');
	const searchIndex = createResource((signal) => loadSearchIndex(data.providerId, signal), {
		enabled: () => chromeSearchEnabled,
		key: () => data.providerId,
	});
	const searchPages = $derived(
		sitePages({
			alerts: data.provider ? providerHasAlerts(data.provider) : null,
		}),
	);
	const searchList = $derived(
		searchIndexList({ query: topSearch }, searchIndex, {
			locale,
			nameSeparators: data.provider?.name_separators,
			pages: searchPages,
		}),
	);

	// Keep smooth-scroll state aligned on new paths; SvelteKit restores history entries.
	function resetMainScroll(hash: string): void {
		const target = hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
		const lenis = getLenis();
		if (lenis) {
			lenis.resize();
			lenis.scrollTo(target ?? 0, { immediate: true, force: true });
		} else if (target) {
			target.scrollIntoView();
		} else {
			window.scrollTo({ top: 0 });
		}
	}

	onMount(() => {
		// Kit finishes wiring its router after component mount callbacks.
		const ready = setTimeout(() => {
			document.documentElement.dataset.hydrated = '';
		});
		return () => clearTimeout(ready);
	});

	onMount(() => {
		if (data.loadSnapshots && data.v1Error && !data.v1) void invalidateAll();

		if (browser && navigator.serviceWorker) {
			navigator.serviceWorker.addEventListener('message', (event) => {
				if ((event.data as { type?: string } | undefined)?.type === 'SW_KILLED') {
					location.reload();
				}
			});
		}
		void registerServiceWorker({ browser, production: import.meta.env.PROD });

		startAnalytics({
			domain: env.PUBLIC_PLAUSIBLE_DOMAIN,
			beaconToken: env.PUBLIC_CF_BEACON_TOKEN,
			providers: data.providers.map((provider) => provider.id),
			context: () => ({ locale, provider: data.providerId }),
		});
		const disposeRipple = initGlobalRipple({ exclude: '[data-ripple-exempt]' });

		const disposeVitals =
			env.PUBLIC_VITALS_ENABLED === 'true'
				? startVitals({ endpoint: '/api/vitals', load: () => import('web-vitals') })
				: () => {};
		return () => {
			disposeRipple();
			disposeVitals();
		};
	});

	onNavigate(viewTransition);

	afterNavigate(({ from, to, type, shallow }) => {
		if (shallow && type === 'goto') return;
		if (!to || type === 'enter' || type === 'popstate') return;
		if (from?.url.pathname !== to.url.pathname || from.url.hash !== to.url.hash) {
			resetMainScroll(to.url.hash);
			if (from?.url.pathname !== to.url.pathname && !to.url.hash) {
				document.getElementById('main')?.focus({ preventScroll: true });
			}
		}
	});

	beforeNavigate((navigation) => {
		if (navigation.shallow && navigation.type === 'goto') return;

		if (
			!navigation.willUnload &&
			navigation.to &&
			(navigation.to.url.searchParams.get('provider') ?? data.defaultProviderId) !== data.providerId
		) {
			navigation.cancel();
			location.assign(navigation.to.url.href);
			return;
		}
		const decision = decideFreshnessReload({
			hasNewVersion: updated.current,
			willUnload: navigation.willUnload,
			toHref: navigation.to?.url.href ?? null,
		});
		if (decision.reload && decision.href) {
			navigation.cancel();
			location.href = decision.href;
		}
	});

	function retryBoot() {
		void invalidateAll();
	}
</script>

<svelte:head>
	{#if !head.noIndex}
		<meta name="robots" content="max-image-preview:large" />
	{/if}
</svelte:head>

<SiteRoot lang={locale}>
	<SeoHead {...head} />

	<AppShell
		{navigation}
		fullViewport={isFullBleed}
		{mapCreditHeight}
		mobileControlsVisible={!isFullBleed || !mapPanelOpen}
		{locale}
		url={currentMirrorUrl(new URL(page.url.href))}
		providerId={data.providerId}
		provider={data.provider}
		providers={data.providers}
		discoveryError={data.discoveryError}
		bind:search={topSearch}
		{searchList}
		mainLabel={mainLabel?.[locale]}
		errorPage={isErrorStatus}
	>
		{#snippet main()}
			<div
				id="main-flow"
				style:overflow-anchor={seoPath === '/' && !isOverviewRecord ? 'none' : undefined}
				style:--expanded-map-credit={mapCreditExpanded ? `${mapCreditHeight}px` : undefined}
				style:--map-source-clearance={mapCreditExpanded ? '0px' : undefined}
				style:--map-touch-row-bottom={mapCreditExpanded
					? 'var(--map-touch-controls-clearance)'
					: undefined}
				class="flex w-full flex-col {isFullBleed ? 'map-flow overflow-hidden' : 'page-flow'}"
			>
				{#if data.loadSnapshots && !v1 && !dataIndependentRoute}
					<div class="mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-4 p-6">
						<p>{data.provider?.labels[locale].city ?? data.providerId}</p>
						<EdgeState
							variant="error-v1"
							lang={locale}
							layout={edgeLayout}
							onRetry={retryBoot}
							class="w-full"
						/>
					</div>
				{:else}
					{@render children?.()}
				{/if}
			</div>
		{/snippet}
		{#snippet footer()}
			{#if isFullBleed}
				<footer
					class="map-source-footer bg-card px-3 py-2 text-center text-xs text-muted-foreground"
					class:dated-map-credit={datedMapCredit}
					data-slot="map-source-footer"
					bind:clientHeight={mapCreditHeight}
				>
					<Separator decorative class="absolute inset-x-0 top-0" />
					{#snippet fullCredit()}
						{#if footerAttribution}<span data-slot="source-credit">{footerAttribution}</span
							>{footerSeparator}{/if}
						<span class="footer-disclaimer" data-slot="agency-disclaimer"
							>{footerWords.disclaimer(agencyName(footerAgency, data.provider))}</span
						>
					{/snippet}
					{#if datedMapCredit}
						<Collapsible.Root bind:open={mapCreditOpen}>
							<Collapsible.Trigger class="min-h-11 underline">
								{locale === 'fr' ? 'Source des données' : 'Data source'}
							</Collapsible.Trigger>
							<Collapsible.Content>{@render fullCredit()}</Collapsible.Content>
						</Collapsible.Root>
					{:else}
						{@render fullCredit()}
					{/if}
				</footer>
			{:else}
				{#if seoPath === '/' && !isOverviewRecord}
					{#key page.url.pathname}
						<div bind:this={constructionEdge} class="construction-anchor" aria-hidden="true"></div>
						<div class="home-construction-floor" style="--ground-progress:{constructionProgress}">
							<ConstructionProps
								layout="spread"
								floodlight
								revealAt={constructionEdge}
								bind:progress={constructionProgress}
							/>
						</div>
					{/key}
				{/if}
				{#snippet legalStatus()}
					<p class="m-0 text-center sm:text-left" data-slot="legal-footer-status">
						<span>{footerAttribution}</span>{footerSeparator}
						<span class="footer-disclaimer" data-slot="agency-disclaimer"
							>{footerWords.disclaimer(agencyName(footerAgency, data.provider))}</span
						>
					</p>
				{/snippet}
				<SiteFooter
					edge="hazard"
					tagline={footerWords.tagline}
					groups={footerGroups}
					statusStart={legalRoute ? legalStatus : undefined}
				>
					{#snippet brand()}
						<BrandCluster productHref={localizeHref('/', locale, data.providerId)} />
						{#if !legalRoute}
							<p class="mt-2 text-xs text-muted-foreground">
								{#if footerAttribution}
									<span data-slot="source-credit">
										{#if data.provider?.download_licence?.source_date_required && data.recordSourceDate}
											{#await data.recordSourceDate}
												{footerAttribution}
											{:then date}
												{providerSourceAttribution(
													data.provider,
													locale,
													date,
													fallbackAttribution,
												)}
											{/await}
										{:else}
											{footerAttribution}
										{/if}
									</span>{footerSeparator}
								{/if}
								<span class="footer-disclaimer" data-slot="agency-disclaimer"
									>{footerWords.disclaimer(agencyName(footerAgency, data.provider))}</span
								>
							</p>
						{/if}
					{/snippet}
				</SiteFooter>
			{/if}
		{/snippet}
	</AppShell>
</SiteRoot>

<style>
	/* The map camera uses viewport coordinates independently of the reading frame. */
	.map-flow {
		position: fixed;
		inset: 0;
		inset-block-end: var(--expanded-map-credit, 0px);
		--chrome-offset: calc(
			var(--app-frame-chrome-height, var(--nav-clearance)) + var(--app-frame-paired, 0) * 1rem
		);
		--app-left-rail-offset: calc(var(--app-frame-paired, 0) * (min(17rem, 36vw) + 1rem));
	}
	.map-source-footer {
		position: fixed;
		inset-inline: 0;
		inset-block-end: 0;
		z-index: var(--z-content);
		pointer-events: none;
	}
	.dated-map-credit {
		max-block-size: 35dvh;
		overflow: auto;
		pointer-events: auto;
	}
	@media (min-width: 1024px) {
		.page-flow {
			--space-page-x: var(--space-card-gap);
			--detail-column-gap: var(--space-card-gap);
			--layout-control-rail-width: min(16rem, 25%);
		}
	}
	.home-construction-floor {
		position: relative;
		height: calc(240px * var(--ground-progress, 1));
		flex-shrink: 0;
		overflow: clip;
	}
	.construction-anchor {
		height: 0;
		width: 1px;
		flex-shrink: 0;
		pointer-events: none;
	}
	@media (--tablet-max) {
		.home-construction-floor {
			height: calc(100px * var(--ground-progress, 1));
		}
	}
	.footer-disclaimer {
		color: var(--secondary-foreground);
	}
</style>
