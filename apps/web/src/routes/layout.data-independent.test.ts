import { cleanup, fireEvent, render, within } from '@testing-library/svelte';
import { createRawSnippet, settled, tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KitNavigationSimulator } from '#lib/features/map/__fixtures__/KitNavigationSimulator.ts';
import type { V1Context } from '#lib/v1/boot.ts';
import type { IsoUtc } from '#lib/v1/schemas/index.ts';
import type { SearchList } from '#lib/search/transitSearch.ts';
import { navPillCopy } from '#lib/i18n/messages.ts';
import { NAV_GROUPS } from '#lib/content/nav.ts';
import { announcement } from '#lib/site/announcement.ts';
import { footerCopy } from '#lib/components/layout/footer.copy.ts';

it.each(['en', 'fr'] as const)(
	'the footer shows the four groups, then Information in %s',
	async (locale) => {
		const view = renderWithoutV1(locale === 'en' ? '/privacy' : '/fr/privacy', locale);
		const footer = view.getByTestId('footer');
		const groups = within(footer).getAllByRole('navigation');
		const labels = [
			...NAV_GROUPS.map((group) =>
				group.key === 'reports'
					? footerCopy[locale].reportsLabel
					: group.key === 'about'
						? footerCopy[locale].dataLabel
						: group.label[locale],
			),
			footerCopy[locale].infoLabel,
		];
		for (const [index, name] of labels.entries())
			expect(groups[index]).toBe(within(footer).getByRole('navigation', { name }));
		expect(groups).toHaveLength(labels.length);
		await fireEvent.click(view.getByRole('button', { name: /Open menu|Ouvrir le menu/ }));
		expect(
			within(view.getByRole('dialog', { name: navPillCopy[locale].menu })).getByRole('heading', {
				name: locale === 'en' ? 'Rankings and reports' : 'Classements et rapports',
			}),
		).toBeInTheDocument();
		expect(footer.querySelector('[data-slot="footer-hazard-edge"]')).toBeNull();
		expect(footer.querySelector('[data-slot="footer-street-edge"]')).toBeNull();
	},
);

it.each(['/', '/fr'] as const)('keeps the footer ground on %s', (path) => {
	const view = renderWithoutV1(path, path === '/' ? 'en' : 'fr');
	expect(
		view.getByTestId('footer').querySelectorAll('[data-slot="footer-hazard-edge"]'),
	).toHaveLength(1);
});

const harness = vi.hoisted(() => {
	const beforeNavigateCallbacks: Array<(navigation: unknown) => unknown> = [];
	const onNavigateCallbacks: Array<(navigation: unknown) => unknown> = [];
	const afterNavigateCallbacks: Array<(navigation: unknown) => unknown> = [];
	const runViewTransition = vi.fn(async () => {});
	return {
		setPath: (_pathname: string) => {},
		shallowUrl: (_pathname: string) => {},
		beforeNavigateCallbacks,
		onNavigateCallbacks,
		afterNavigateCallbacks,
		runViewTransition,
	};
});

vi.mock('$app/state', async () => {
	const { writable } = await import('svelte/store');
	const { createPageState } = await import('../tests/pageState.svelte.ts');
	const page = createPageState({
		url: new URL('https://transit.yesid.dev/privacy'),
		params: {},
		route: { id: '/[[lang=locale]]/privacy' },
		status: 200,
		error: null,
		data: {},
		form: null,
		state: {},
	});
	harness.setPath = (pathname: string) => {
		page.set({
			url: new URL(pathname, window.location.origin),
			params: pathname.startsWith('/fr/') ? { lang: 'fr' } : {},
			route: { id: '/[[lang=locale]]/legal' },
			status: 200,
			error: null,
			data: {},
			form: null,
			state: {},
		});
	};
	harness.shallowUrl = (pathname: string) => {
		window.history.replaceState({}, '', pathname);
		page.update((current) => ({ ...current, state: { ...current.state } }));
	};
	return { page: page.page, updated: { current: false }, navigating: writable(null) };
});

vi.mock('$app/navigation', () => ({
	goto: vi.fn(),
	invalidateAll: vi.fn(),
	onNavigate: vi.fn((callback: (navigation: unknown) => unknown) => {
		harness.onNavigateCallbacks.push(callback);
	}),
	beforeNavigate: vi.fn((callback: (navigation: unknown) => unknown) => {
		harness.beforeNavigateCallbacks.push(callback);
	}),
	afterNavigate: vi.fn((callback: (navigation: unknown) => unknown) => {
		harness.afterNavigateCallbacks.push(callback);
	}),
}));
vi.mock('@yesid/motion/utils/lenis', () => ({
	getLenis: () => null,
	initLenis: () => {},
	destroyLenis: () => {},
}));
vi.mock('$app/env', () => ({ browser: false }));
vi.mock('$app/env/public', async () => ({
	...(await import('./../tests/publicEnv.ts')).PUBLIC_ENV,
	...{},
}));

vi.mock('#lib/components/edge/index.ts', async () => ({
	EdgeState: (await import('./__fixtures__/RootLayoutEdgeStateStub.svelte')).default,
}));
vi.mock('#lib/seo/routeSeo.ts', async (importOriginal) => ({
	// canonicalRoutePath stays real so the layout head uses the delocalized
	// pathname of the route under test.
	...(await importOriginal<typeof import('#lib/seo/routeSeo.ts')>()),
	resolveRouteSeo: () => ({
		title: 'Legal',
		description: 'Legal document description.',
		siteName: 'Transit',
		imagePath: '/og/en.png',
		imageAlt: 'Transit',
	}),
	isEphemeralPath: () => false,
	breadcrumbItemsForHead: () => [],
	resolveDatasetSeo: () => ({ name: 'Dataset', description: 'Dataset description.' }),
}));
vi.mock('#lib/seo/jsonld.ts', () => ({
	websiteJsonLd: () => ({}),
	breadcrumbJsonLd: () => null,
	organizationJsonLd: () => ({}),
	datasetJsonLd: () => ({}),
}));
vi.mock('#lib/site/config.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/site/config.ts')>()),
	readPublicSiteConfig: () => ({
		siteOrigin: 'https://transit.yesid.dev',
		indexing: false,
		siteName: 'Transit',
	}),
}));
vi.mock('#lib/site/errorPage.ts', () => ({
	errorDocumentHead: () => ({ title: 'Error', description: 'Error' }),
}));
vi.mock('#lib/v1/boot.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/v1/boot.ts')>()),
	bootV1: vi.fn(),
}));
vi.mock('#lib/v1/repositories/static.ts', () => ({
	getRoute: vi.fn(),
	getRoutesIndex: vi.fn(),
	getStop: vi.fn(),
	getStopsIndex: vi.fn(),
	getStopsIndexSlim: vi.fn(),
}));
vi.mock('#lib/v1/resource.svelte.ts', () => ({
	createResource: () => ({ data: null, error: null, loading: false, settled: false }),
}));
vi.mock('#lib/stores/index.ts', () => ({
	dataRefresh: {
		epoch: 0,
		run: vi.fn(),
		refreshing: false,
		ageSeconds: null,
	},
	dataPulse: { subscribeCapture: vi.fn(() => vi.fn()) },
	motionMode: { current: 'raw', isSmooth: false, toggle: vi.fn() },
}));
vi.mock('#lib/pwa/register.ts', () => ({ registerServiceWorker: vi.fn() }));
vi.mock('#lib/pwa/appVersion.ts', () => ({
	decideFreshnessReload: () => ({ reload: false, href: null }),
}));
vi.mock('@yesid/analytics/vitals', () => ({ startVitals: () => vi.fn() }));
vi.mock('@yesid/motion/utils/viewTransition', () => ({
	viewTransition: harness.runViewTransition,
}));
vi.mock('@yesid/ui/state', async (importOriginal) => ({
	...(await importOriginal<typeof import('@yesid/ui/state')>()),
	clock: {
		serverNow: Date.parse('2026-08-03T00:00:00Z'),
		serverNowContinuousMs: () => Date.parse('2026-08-03T00:00:00Z'),
		subscribe: vi.fn(() => vi.fn()),
	},
	desktop: { current: true },
}));
const headerList = vi.hoisted(() => ({ current: null as SearchList | null }));
vi.mock('#lib/search/transitSearch.ts', async (importOriginal) => {
	const real = await importOriginal<typeof import('#lib/search/transitSearch.ts')>();
	return {
		...real,
		searchTransit: (...args: Parameters<typeof real.searchTransit>) =>
			headerList.current ?? real.searchTransit(...args),
	};
});

import RootLayout from './+layout.svelte';
import { searchTransit } from '#lib/search/transitSearch.ts';
import RootLayoutMapRouteHarness from './__fixtures__/RootLayoutMapRouteHarness.svelte';

const children = createRawSnippet(() => ({
	render: () => '<article data-testid="legal-child">Legal child</article>',
}));

function loadedV1(lang: 'en' | 'fr'): V1Context {
	return {
		lang,
		labels: {},
		manifest: {
			provider: 'fixture',
			display_name: 'Fixture Transit',
			bbox: [-74, 45, -73, 46],
			attribution: 'Fixture attribution',
			dataset_version: 'fixture-v1',
			labels: {},
			files: { live: { generated_utc: '2026-08-03T00:00:00Z' as IsoUtc, source_lag_s: 0 } },
			surfaces: [],
		},
	};
}

function renderRoot(pathname: string, lang: 'en' | 'fr', v1: V1Context | null) {
	harness.beforeNavigateCallbacks.length = 0;
	harness.onNavigateCallbacks.length = 0;
	harness.afterNavigateCallbacks.length = 0;
	harness.runViewTransition.mockClear();
	harness.setPath(pathname);
	const data = {
		lang,
		v1,
		v1Error: v1 === null,
		loadSnapshots: pathname.includes('/map') || pathname === '/network',
		schedule: null,
		serverBoot: v1 ? ('succeeded' as const) : ('failed' as const),
		providerId: v1?.manifest.provider ?? 'stm',
		defaultProviderId: 'stm',
		provider: null,
		providers: [],
		discoveryError: false,
		redirectHref: null,
	};
	if (v1 && /^\/(?:fr\/)?map$/u.test(pathname)) {
		return render(RootLayoutMapRouteHarness, { props: { data } });
	}
	return render(RootLayout, {
		props: {
			data,
			children,
		},
	});
}

function renderWithoutV1(pathname: string, lang: 'en' | 'fr') {
	return renderRoot(pathname, lang, null);
}

function expectInfoDestinationsAbsent(
	surface: HTMLElement,
	infoLabel: string,
	links: readonly (readonly [label: string, href: string])[],
): void {
	const scoped = within(surface);
	expect(scoped.queryByRole('group', { name: infoLabel })).not.toBeInTheDocument();
	for (const [label, href] of links) {
		expect(scoped.queryByRole('link', { name: label })).not.toBeInTheDocument();
		const candidates = [...surface.querySelectorAll(`a[href="${href}"]`)];
		expect(candidates.filter((link) => !link.closest('[data-slot="announcement-banner"]'))).toEqual(
			[],
		);
	}
}

afterEach(() => {
	cleanup();
	document.body.style.removeProperty('overflow');
	document.body.style.removeProperty('pointer-events');
});

describe('root layout data-independent legal routes', () => {
	it('resets the window on a new path but preserves query and history navigation', () => {
		renderWithoutV1('/privacy', 'en');
		const scrollTo = vi.spyOn(window, 'scrollTo');
		const navigate = (from: string, to: string, type = 'link') => {
			for (const callback of harness.afterNavigateCallbacks) {
				callback({ from: { url: new URL(from) }, to: { url: new URL(to) }, type });
			}
		};

		navigate('https://transit.yesid.dev/privacy', 'https://transit.yesid.dev/privacy?provider=stm');
		expect(scrollTo).not.toHaveBeenCalled();
		navigate('https://transit.yesid.dev/terms', 'https://transit.yesid.dev/privacy', 'popstate');
		expect(scrollTo).not.toHaveBeenCalled();

		navigate('https://transit.yesid.dev/privacy', 'https://transit.yesid.dev/terms');
		expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
		scrollTo.mockRestore();
	});

	it.each(['en', 'fr'] as const)(
		'preserves shallow filters in the %s language link',
		async (locale) => {
			const path = `${locale === 'fr' ? '/fr' : ''}/alerts`;
			const { getByRole, container } = renderWithoutV1(path, locale);
			await fireEvent.click(getByRole('button', { name: /Open menu|Ouvrir le menu/ }));
			for (const severity of ['watch', 'critical', '']) {
				const query = `?provider=stm&route=144&stop=52458&from=2026-09-21&to=2026-09-21${severity ? `&severity=${severity}` : ''}#alerts`;
				harness.shallowUrl(path + query);
				await tick();
				const links = container.querySelectorAll('[data-testid="language-toggle"]');
				expect(links).toHaveLength(1);
				for (const link of links)
					expect(link).toHaveAttribute('href', `${locale === 'en' ? '/fr' : ''}/alerts${query}`);
			}
		},
	);

	it('does not geocode a submitted header search while provider boot is unavailable', async () => {
		const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"results":[]}'));
		try {
			const { getByRole } = renderWithoutV1('/network?provider=octranspo', 'en');
			await fireEvent.input(getByRole('combobox', { name: 'Search the network' }), {
				target: { value: 'Bank Street' },
			});
			await fireEvent.submit(getByRole('search'));
			await settled();
			expect(request).not.toHaveBeenCalled();
		} finally {
			request.mockRestore();
		}
	});
	it('uses a fresh document when a navigation changes provider', () => {
		renderWithoutV1('/network?provider=stm', 'en');
		const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
		const cancel = vi.fn();
		const href = 'https://transit.yesid.dev/network?provider=octranspo';
		harness.beforeNavigateCallbacks.at(-1)?.({
			willUnload: false,
			to: { url: new URL(href) },
			cancel,
		});
		expect(cancel).toHaveBeenCalledOnce();
		expect(assign).toHaveBeenCalledWith(href);
		assign.mockRestore();
	});
	it.each([
		['/privacy', 'en', 'Open-source and third-party rights are identified'],
		['/fr/terms', 'fr', 'Les droits liés au code ouvert et au contenu tiers sont indiqués'],
		['/roadmap', 'en', 'Open-source and third-party rights are identified'],
		['/fr/roadmap', 'fr', 'Les droits liés au code ouvert et au contenu tiers sont indiqués'],
	] as const)(
		'renders %s with v1=null and a static legal footer attribution',
		(pathname, lang, attribution) => {
			const { getByTestId, queryByTestId } = renderWithoutV1(pathname, lang);

			expect(getByTestId('legal-child')).toBeInTheDocument();
			expect(queryByTestId('root-layout-edge-state')).not.toBeInTheDocument();
			expect(getByTestId('footer')).toHaveTextContent(attribution);
		},
	);

	it('keeps the v1 outage state on data-dependent routes', () => {
		const { getByTestId, queryByTestId } = renderWithoutV1('/network', 'en');

		expect(getByTestId('root-layout-edge-state')).toBeInTheDocument();
		expect(queryByTestId('legal-child')).not.toBeInTheDocument();
		expect(getByTestId('footer')).not.toHaveTextContent(
			'Open-source and third-party rights are identified',
		);
	});

	it.each([
		{
			pathname: '/map',
			lang: 'en' as const,
			loaded: true,
			footer: false,
			openMenu: 'Open menu',
			infoLabel: 'Information',
			links: [
				['Privacy', '/privacy'],
				['Terms', '/terms'],
				['Roadmap', '/roadmap'],
			] as const,
		},
		{
			pathname: '/fr/map',
			lang: 'fr' as const,
			loaded: true,
			footer: false,
			openMenu: 'Ouvrir le menu',
			infoLabel: 'Information',
			links: [
				['Confidentialité', '/fr/privacy'],
				['Conditions d’utilisation', '/fr/terms'],
				['Feuille de route', '/fr/roadmap'],
			] as const,
		},
		{
			pathname: '/privacy',
			lang: 'en' as const,
			loaded: false,
			footer: true,
			openMenu: 'Open menu',
			infoLabel: 'Information',
			links: [
				['Privacy', '/privacy'],
				['Terms', '/terms'],
				['Roadmap', '/roadmap'],
			] as const,
		},
		{
			pathname: '/fr/privacy',
			lang: 'fr' as const,
			loaded: false,
			footer: true,
			openMenu: 'Ouvrir le menu',
			infoLabel: 'Information',
			links: [
				['Confidentialité', '/fr/privacy'],
				['Conditions d’utilisation', '/fr/terms'],
				['Feuille de route', '/fr/roadmap'],
			] as const,
		},
		{
			pathname: '/lines',
			lang: 'en' as const,
			loaded: true,
			footer: true,
			openMenu: 'Open menu',
			infoLabel: 'Information',
			links: [
				['Privacy', '/privacy'],
				['Terms', '/terms'],
				['Roadmap', '/roadmap'],
			] as const,
		},
		{
			pathname: '/fr/lines',
			lang: 'fr' as const,
			loaded: true,
			footer: true,
			openMenu: 'Ouvrir le menu',
			infoLabel: 'Information',
			links: [
				['Confidentialité', '/fr/privacy'],
				['Conditions d’utilisation', '/fr/terms'],
				['Feuille de route', '/fr/roadmap'],
			] as const,
		},
	])(
		'keeps the announcement and footer links out of the menu for $pathname',
		async ({ pathname, lang, loaded, footer, openMenu, infoLabel, links }) => {
			const view = renderRoot(pathname, lang, loaded ? loadedV1(lang) : null);
			expect(view.container.querySelector('[data-slot="app-shell"]')).toBeInTheDocument();
			const banner = view.container.querySelector<HTMLElement>('[data-slot="announcement-banner"]');
			if (announcement.enabled && banner) {
				expect(
					within(banner).getByRole('link', { name: announcement[lang].message }),
				).toHaveAttribute('href', announcement[lang].href);
			}
			expect(Boolean(banner)).toBe(announcement.enabled);
			if (loaded) {
				expect(
					footer
						? view.getByTestId('legal-child')
						: view.container.querySelector('.map-progressive'),
				).toBeInTheDocument();
				expect(view.queryByTestId('root-layout-edge-state')).not.toBeInTheDocument();
			}

			if (footer) {
				const infoFooter = within(view.getByTestId('footer')).getByRole('navigation', {
					name: infoLabel,
				});
				for (const [label, href] of links) {
					expect(within(infoFooter).getByRole('link', { name: label })).toHaveAttribute(
						'href',
						`${href}?provider=${loaded ? 'fixture' : 'stm'}`,
					);
				}
			} else {
				expect(view.queryByTestId('footer')).not.toBeInTheDocument();
				expectInfoDestinationsAbsent(view.container, infoLabel, links);
			}

			await fireEvent.click(view.getByRole('button', { name: openMenu }));
			const menu = view.getByRole('dialog', { name: navPillCopy[lang].menu });
			expect(menu).toBeInTheDocument();
			expectInfoDestinationsAbsent(menu, infoLabel, links);

			const chromeSurfaces = [
				...view.container.querySelectorAll<HTMLElement>('header'),
				view.container.querySelector<HTMLElement>('[data-slot="app-shell-chrome"]'),
			].filter((surface): surface is HTMLElement => surface !== null);
			expect(chromeSurfaces.length).toBeGreaterThan(0);
			for (const surface of chromeSurfaces) {
				expectInfoDestinationsAbsent(surface, infoLabel, links);
			}
		},
	);

	it.each([
		['ordinary map exit', '/map', '/lines'],
		['accepted target normalized at commit', '/map/', '/map'],
		['localized accepted target normalized at commit', '/fr/map/', '/fr/map'],
	] as const)(
		'delegates %s to the ordinary View Transition path',
		async (_shape, fromPath, toPath) => {
			renderWithoutV1(fromPath, fromPath.startsWith('/fr/') ? 'fr' : 'en');
			const navigation = {
				from: { url: new URL(`https://transit.yesid.dev${fromPath}`) },
				to: { url: new URL(`https://transit.yesid.dev${toPath}`) },
				willUnload: false,
				complete: Promise.resolve(),
			};

			const blocker = harness.onNavigateCallbacks.at(-1)?.(navigation);

			expect(harness.runViewTransition).toHaveBeenCalledOnce();
			expect(harness.runViewTransition).toHaveBeenCalledWith(navigation);
			await expect(blocker).resolves.toBeUndefined();
		},
	);

	it('commits the root shell from a locked map to a rendered document', async () => {
		const view = renderWithoutV1('/map', 'en');
		const frame = view.container.querySelector<HTMLElement>('[data-slot="app-frame"]');
		expect(frame).toHaveClass('full-viewport');
		expect(view.container.querySelector('#main-flow')).toHaveClass('map-flow');
		const simulator = new KitNavigationSimulator({
			publishPage: (href) => harness.setPath(new URL(href).pathname),
			publishNavigating: () => {},
			settled,
			tick,
			activeElement: () => document.activeElement,
			bodyElement: () => document.body,
			resetFocus: () => document.body.focus(),
		});
		simulator.setPageUrl('https://transit.yesid.dev/map');
		for (const callback of harness.onNavigateCallbacks) {
			simulator.onNavigate(callback);
		}
		const accepted = simulator.startNavigation('https://transit.yesid.dev/privacy');

		await simulator.commitNavigation('https://transit.yesid.dev/privacy');
		await expect(accepted.navigation.complete).resolves.toBeUndefined();

		expect(view.container.querySelector('#page-scroller')).toBeNull();
		expect(frame).not.toHaveClass('full-viewport');
		expect(view.container.querySelector('#main-flow')).toHaveClass('page-flow');
		expect(view.getByTestId('legal-child')).toBeInTheDocument();
		expect(harness.runViewTransition).toHaveBeenCalledWith(accepted.navigation);
	});
});

it('a header result keeps the tab and period the reader sees, not the ones first requested', async () => {
	headerList.current = searchTransit(
		{ query: '1' },
		{ routes: [{ id: '1-373', short: '1', long: 'Confederation', type: 1 }], stops: [] },
	);
	try {
		const view = renderWithoutV1('/lines/24?tab=reliability&grain=month&from=2026-11-01', 'en');
		// The record view mirrors its corrected state shallowly: page.url keeps the old query.
		harness.shallowUrl('/lines/24?tab=schedule&grain=range&from=2026-11-02&to=2026-11-08');
		await fireEvent.input(view.getByRole('combobox', { name: 'Search the network' }), {
			target: { value: '1' },
		});
		const row = view.getByRole('option', { name: 'Line 1 · Confederation Métro' });
		const href = new URL(row.getAttribute('href')!, 'https://transit.local');
		expect(href.pathname).toBe('/lines/1-373');
		expect(['tab', 'grain', 'from', 'to'].map((key) => href.searchParams.get(key))).toEqual([
			'schedule',
			'range',
			'2026-11-02',
			'2026-11-08',
		]);
	} finally {
		headerList.current = null;
		window.history.replaceState({}, '', '/');
	}
});
