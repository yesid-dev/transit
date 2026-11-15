import { render, screen, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'vite';
import Page from './+page.svelte';

const { state, createLiveStoreSpy } = vi.hoisted(() => ({
	state: { locale: 'en' as 'en' | 'fr', city: 'Montréal' },
	createLiveStoreSpy: vi.fn(),
}));
vi.mock('#lib/i18n/index.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/i18n/index.ts')>()),
	getLocale: () => state.locale,
}));
vi.mock('#lib/nav/index.ts', async () => {
	const { routeFor } = await vi.importActual<typeof import('#lib/nav/intent.svelte.ts')>(
		'#lib/nav/intent.svelte.ts',
	);
	return { routeFor };
});
vi.mock('#lib/v1/live/store.svelte.ts', () => ({ createLiveStore: createLiveStoreSpy }));

function pageData() {
	const label = { city: state.city, operator: 'Fixture Transit' };
	return {
		provider: { id: 'fixture', labels: { en: label, fr: label }, inputs: {}, alert_links: {} },
		v1: null,
	};
}

function renderHome() {
	return render(Page, { props: { data: pageData() } });
}

// The menu's four groups, in its order and words (content/nav.ts); the home itself is left out.
type Destination = readonly [href: string, en: string, fr: string];
const groups: readonly (readonly [en: string, fr: string, links: readonly Destination[]])[] = [
	[
		'Now',
		'En ce moment',
		[
			['/map', 'Live map', 'Carte en direct'],
			['/network', 'Network health', 'Santé du réseau'],
		],
	],
	[
		'Explore',
		'Explorer',
		[
			['/lines', 'Lines', 'Lignes'],
			['/stops', 'Stops', 'Arrêts'],
		],
	],
	[
		'Rankings and reports',
		'Classements et rapports',
		[
			['/hotspots', 'Worst lines and stops', 'Pires lignes et arrêts'],
			['/repeat-offenders', 'Worst trips and buses', 'Pires trajets et bus'],
			['/receipt', 'Daily report', 'Rapport quotidien'],
			['/alerts', 'Service alerts', 'Avis de service'],
		],
	],
	[
		'About the data',
		'À propos des données',
		[
			['/metrics', 'How we measure', 'Comment on mesure'],
			['/status', 'Data health', 'Santé des données'],
			['https://yesid.dev', 'About Yesid', 'À propos de Yesid'],
		],
	],
];
const destinations = groups.flatMap(([, , links]) => links);
const nav = () =>
	screen.getByRole('navigation', {
		name: state.locale === 'fr' ? 'Tout explorer' : 'Explore everything',
	});

afterEach(() => {
	state.locale = 'en';
	state.city = 'Montréal';
	createLiveStoreSpy.mockClear();
});

describe('Home civic overview and directory', () => {
	it.each([
		[
			'fr',
			'Ottawa',
			'Transit est un registre public et indépendant du service d’autobus qu’Ottawa reçoit réellement.',
		],
		[
			'fr',
			'Montréal',
			'Transit est un registre public et indépendant du service d’autobus que Montréal reçoit réellement.',
		],
		[
			'en',
			'Ottawa',
			'Transit is an independent public record of the bus service Ottawa actually gets.',
		],
		[
			'en',
			'Montréal',
			'Transit is an independent public record of the bus service Montréal actually gets.',
		],
	] as const)('composes the %s lede for %s', (locale, city, sentence) => {
		state.locale = locale;
		state.city = city;
		const { container } = renderHome();
		expect(container.querySelector('[data-slot="home-audit-brief"]')).toHaveTextContent(sentence);
	});
	it.each(['en', 'fr'] as const)(
		'lists the menu’s four groups, every page once, with no filters or count in %s',
		(locale) => {
			state.locale = locale;
			renderHome();
			const sections = within(nav()).getAllByRole('region');
			expect(sections.map((section) => within(section).getByRole('heading').textContent)).toEqual(
				groups.map(([en, fr]) => (locale === 'fr' ? fr : en)),
			);
			sections.forEach((section, index) => {
				const links = within(section).getAllByRole('link');
				expect(links.map((link) => link.getAttribute('href'))).toEqual(
					groups[index]![2].map(([path]) =>
						path.startsWith('http') ? path : locale === 'fr' ? `/fr${path}` : path,
					),
				);
				groups[index]![2].forEach(([, en, fr], i) =>
					expect(links[i]).toHaveTextContent(locale === 'fr' ? fr : en),
				);
			});
			expect(within(nav()).queryByText(/^[0-9]+ destinations?$/)).toBeNull();
			expect(within(nav()).queryByRole('radio')).toBeNull();
			expect(within(nav()).queryByRole('status')).toBeNull();
			const house = within(nav()).getByRole('link', { name: /About Yesid|À propos de Yesid/ });
			expect(house).toHaveAttribute('target', '_blank');
			expect(house).toHaveAccessibleName(
				locale === 'fr' ? 'À propos de Yesid (nouvel onglet)' : 'About Yesid (opens in a new tab)',
			);
		},
	);
	it('leaves Service alerts out of the groups when the network has no alert feed', () => {
		const data = pageData();
		const { container } = render(Page, {
			props: {
				data: {
					...data,
					provider: { ...data.provider, inputs: { i3_alerts: false, service_alerts: false } },
				},
			},
		});
		expect(within(nav()).queryByRole('link', { name: 'Service alerts' })).toBeNull();
		expect(container.querySelector('a[href="/receipt"]')).not.toBeNull();
	});

	it.each(['en', 'fr'] as const)('uses the selected city in the %s heading', (locale) => {
		state.locale = locale;
		state.city = 'Ottawa';
		const { container } = renderHome();
		expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Ottawa');
		expect(container).not.toHaveTextContent('Montréal');
	});

	it('states the purpose with Search under it, then the numbers, then the groups', () => {
		const { container } = renderHome();
		expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
		expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
			'How Montréal’s transit holds up.',
		);
		expect(container.querySelector('[data-slot="home-audit-brief"]')).toHaveTextContent(
			'independent public record of the bus service Montréal actually gets',
		);
		expect(container.querySelector('.home-lede')).toHaveTextContent(
			'Transit is an independent public record of the bus service Montréal actually gets. It is not a trip planner.',
		);
		expect(screen.getByText(/It is not affiliated with Fixture Transit\./)).toBeInTheDocument();
		// The home page leads to the search page; it has no search field of its own.
		const search = screen.getByRole('link', { name: 'Search for your line or stop' });
		expect(search).toHaveAttribute('href', '/search');
		expect(screen.queryByRole('search')).toBeNull();
		expect(screen.queryByRole('searchbox')).toBeNull();
		const strip = container.querySelector('[data-slot="home-pulse"]') as HTMLElement;
		expect(
			within(strip)
				.getAllByRole('link')
				.map((link) => link.getAttribute('href')),
		).toEqual(['/network', '/map']);
		const lede = container.querySelector('.home-lede') as HTMLElement;
		expect(lede.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(search.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(strip.compareDocumentPosition(nav()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(createLiveStoreSpy).not.toHaveBeenCalled();
	});

	it('keeps the introduction to one sentence until Read more is opened', () => {
		const { container } = renderHome();
		const brief = container.querySelector('[data-slot="home-audit-brief"]') as HTMLElement;
		const more = within(brief).getByText('Read more').closest('details') as HTMLDetailsElement;
		expect(more.open).toBe(false);
		expect(more).toHaveTextContent('residents, advocates, journalists and councillors');
		expect(more).toHaveTextContent('When data is missing, we say so.');
	});

	it('says plainly that Transit is looking for contributors to extend it', () => {
		renderHome();
		const invite = screen.getByRole('region', { name: 'Help extend Transit' });
		expect(invite).toHaveTextContent('we are looking for contributors');
		for (const [name, href] of [
			[/How to contribute/, 'https://github.com/yesid-dev/transit/blob/main/CONTRIBUTING.md'],
			[/View the code/, 'https://github.com/yesid-dev/transit'],
			[/Get in touch/, 'https://yesid.dev/contact'],
		] as const)
			expect(within(invite).getByRole('link', { name })).toHaveAttribute('href', href);
		expect(invite).not.toHaveTextContent('Add your city');
		expect(
			within(invite)
				.getAllByRole('link')
				.map((link) => link.getAttribute('target')),
		).toEqual(['_blank', '_blank', '_blank']);
	});

	it('server-renders every navigation href and the civic heading without hydration', async () => {
		const server = await createServer({
			configFile: 'vite.config.ts',
			appType: 'custom',
			logLevel: 'silent',
			optimizeDeps: { noDiscovery: true },
			server: { middlewareMode: true },
		});
		try {
			const module = await server.ssrLoadModule('/src/routes/[[lang=locale]]/+page.svelte');
			const { render: renderSsr } = (await server.ssrLoadModule(
				'svelte/server',
			)) as typeof import('svelte/server');
			const context = new Map<unknown, unknown>([
				[Symbol.for('@yesid/ui/locale'), () => 'en' as const],
			]);
			const { body } = renderSsr(module.default, { context, props: { data: pageData() } });
			expect(body).toContain('How Montréal’s');
			expect(body).toContain('independent public record');
			expect(body).toContain('Search for your line or stop');
			for (const [href] of destinations) expect(body).toContain(`href="${href}"`);
			expect(body).toContain('href="/search"');
		} finally {
			await server.close();
		}
	}, 20_000);
});

it.each(['en', 'fr'] as const)(
	'home search remains a localized link, not a second input in %s',
	(locale) => {
		state.locale = locale;
		renderHome();
		expect(
			screen.getByRole('link', {
				name:
					locale === 'en' ? 'Search for your line or stop' : 'Cherchez votre ligne ou votre arrêt',
			}),
		).toHaveAttribute('href', locale === 'en' ? '/search' : '/fr/search');
		expect(screen.queryByRole('search')).toBeNull();
		expect(screen.queryByRole('searchbox')).toBeNull();
		expect(screen.queryByRole('textbox')).toBeNull();
	},
);
