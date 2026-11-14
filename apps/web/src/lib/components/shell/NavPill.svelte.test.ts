import { fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { createMemoryLiveReader } from '#lib/v1/live/__fixtures__/reader.ts';
import { createLiveStore, type LiveStore } from '#lib/v1/live/store.svelte.ts';
import { livePresentation } from '#lib/v1/live/livePresentation.ts';
import { ManifestSchema } from '#lib/v1/schemas/index.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchTransit } from '#lib/search/transitSearch.ts';
import type { Vehicle } from '#lib/v1/schemas/index.ts';
import NavPill from './__fixtures__/NavPillHarness.svelte';
import { createNavigationRouter } from './__fixtures__/navigationRouter';
import catalog from '../../../../e2e/providers.json';
import { PublicProviderCatalogSchema } from '#lib/v1/providers.ts';
import { NAV_ITEMS } from '#lib/content/nav.ts';
import { navPillCopy } from '#lib/i18n/messages.ts';

it.each(['en', 'fr'] as const)('gates alert navigation by capability in %s', async (locale) => {
	const base = PublicProviderCatalogSchema.parse(catalog).providers[0];
	const provider = {
		...base,
		id: 'made-up',
		inputs: { ...base.inputs, i3_alerts: false, service_alerts: false },
	};
	for (const providers of [[provider], []]) {
		const view = render(NavPill, { props: { locale, providerId: provider.id, providers } });
		await fireEvent.click(view.getByRole('button', { name: navPillCopy[locale].openMenu }));
		const alert = within(view.getByRole('dialog')).queryByRole('link', {
			name: (name) => name === NAV_ITEMS.find((item) => item.key === 'alerts')!.label[locale],
		});
		expect(Boolean(alert)).toBe(providers.length === 0);
		view.unmount();
	}
});

vi.mock('$app/env/public', async () => ({
	...(await import('./../../../tests/publicEnv.ts')).PUBLIC_ENV,
	...{},
}));
vi.mock('$app/navigation', () => ({
	beforeNavigate: vi.fn(),
	onNavigate: vi.fn(),
	afterNavigate: vi.fn(),
}));

afterEach(() => vi.restoreAllMocks());

for (const locale of ['en', 'fr'] as const)
	for (const provider of PublicProviderCatalogSchema.parse(catalog).providers)
		it(`keeps ${provider.id} phone label and full ${locale} identity available`, () => {
			const { city, operator } = provider.labels[locale];
			const fullName = `${city} · ${operator}`;
			const view = render(NavPill, {
				props: { locale, providerId: provider.id, providers: [provider] },
			});
			const picker = view.getByRole('combobox', { name: new RegExp(fullName) });
			expect(picker).toHaveAttribute('title', fullName);
			expect(within(picker).getByRole('option', { selected: true })).toHaveTextContent(fullName);
			expect(within(picker.parentElement!).getByText(operator, { exact: true })).toHaveAttribute(
				'title',
				fullName,
			);
		});

it.each([
	['en', 'Other networks unavailable'],
	['fr', 'Autres réseaux indisponibles'],
] as const)('explains discovery failure in the %s picker', (locale, label) => {
	const view = render(NavPill, { props: { locale, discoveryError: true } });
	expect(view.getByRole('option', { name: label })).toBeDisabled();
});

it('does not suggest an outage when discovery succeeded', () => {
	const view = render(NavPill, { props: { locale: 'en' } });
	expect(view.queryByRole('option', { name: 'Other networks unavailable' })).toBeNull();
});

describe('NavPill navigation lifecycle integration', () => {
	it.each([false, true])('uses the Kit 3 fallback with redirect=%s', async (redirected) => {
		const adapter = createNavigationRouter();
		const view = render(NavPill, { props: { adapter, locale: 'en' } });
		await fireEvent.click(view.getByRole('button', { name: 'Open menu' }));
		const language = view.getByTestId('language-toggle');
		expect(language).toHaveAttribute('data-sveltekit-reload', 'true');
		// Model a router-accepted native start. Real reload links depart the document instead.
		const event = new MouseEvent('click', { bubbles: true });
		Object.defineProperty(event, 'target', { value: language });
		const start = {
			type: 'link' as const,
			to: { url: new URL('https://transit.local/fr/old') },
			event,
		};
		await adapter.navigate(
			start,
			redirected
				? { type: 'link', to: { url: new URL('https://transit.local/fr/metrics') } }
				: start,
		);
		await tick();
		if (!redirected) {
			expect(view.getByRole('dialog')).toBeInTheDocument();
			expect(language).toHaveFocus();
			await fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
			await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
		} else {
			await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
			expect(language).not.toHaveFocus();
		}
	});
});

describe('NavPill — search', () => {
	it.each([
		['en', 'Your searches are sent to our server and the Government of Canada Geo.ca service.'],
		[
			'fr',
			'Vos recherches sont envoyées à notre serveur et au service Géo.ca du gouvernement du Canada.',
		],
	] as const)(
		'renders the %s chrome collection notice beside the search input',
		(locale, notice) => {
			const { getByRole } = render(NavPill, { props: { locale } });
			const search = getByRole('search');
			const nodes = within(search).getAllByText(notice);
			expect(nodes).toHaveLength(2);
			const target = nodes.find((n) => n.id === 'nav-search-notice');
			expect(target).toHaveClass('sr-only');
			expect(nodes.find((n) => n !== target)).toHaveAttribute('aria-hidden', 'true');
			expect(within(search).getByRole('combobox')).toBeInTheDocument();
		},
	);

	it.each([
		['en', 'Vehicle 40061 Line 161'],
		['fr', 'Véhicule 40061 Ligne 161'],
	] as const)("names a live vehicle's line in %s", (locale, name) => {
		const bus = { id: '40061', lat: 0, lon: 0, status: 'late', route: '161' } as Vehicle;
		const searchList = searchTransit(
			{ surface: 'list', query: '40061' },
			{
				routes: [{ id: '161', short: '161', long: 'Van Horne', type: 3 }],
				stops: [],
				vehicles: [bus],
			},
		);
		const { getByRole } = render(NavPill, { props: { locale, search: '40061', searchList } });
		expect(getByRole('option', { name })).toHaveTextContent(name.split(' ').slice(-2).join(' '));
	});

	it('turns browser autofill off on the in-pill search box', () => {
		const { getByRole } = render(NavPill, { props: { locale: 'en' } });
		const searchbox = getByRole('combobox', { name: 'Search the network' });
		expect(searchbox).toHaveAttribute('autocomplete', 'off');
		expect(searchbox).toHaveAttribute('name', 'network-search');
	});

	it('scopes the search placeholder + aria-label to the line catalogue', () => {
		const { getByRole } = render(NavPill, { props: { locale: 'en', searchScope: 'route' } });
		expect(getByRole('combobox', { name: 'Search a line' })).toHaveAttribute(
			'placeholder',
			'Search a line…',
		);
	});

	it('shows the collection notice only where searches actually transmit (S5-377 B3)', () => {
		for (const searchScope of ['map', 'all'] as const) {
			const { getAllByText, getByRole, unmount } = render(NavPill, {
				props: { locale: 'en', searchScope },
			});
			const notices = getAllByText(
				'Your searches are sent to our server and the Government of Canada Geo.ca service.',
			);
			expect(notices).toHaveLength(2);
			const target = notices.find((n) => n.id === 'nav-search-notice');
			expect(target).toBeDefined();
			expect(target).toHaveClass('sr-only');
			expect(notices.find((n) => n !== target)).toHaveAttribute('aria-hidden', 'true');
			expect(getByRole('combobox', { name: 'Search the network' })).toHaveAttribute(
				'aria-describedby',
				'nav-search-notice',
			);
			unmount();
		}
		for (const searchScope of ['route', 'stop'] as const) {
			const { queryByText, getByRole, unmount } = render(NavPill, {
				props: { locale: 'en', searchScope },
			});
			expect(queryByText(/searches are sent/i)).toBeNull();
			expect(getByRole('combobox', { name: /^Search a/ })).not.toHaveAttribute('aria-describedby');
			unmount();
		}
	});

	it('closes desktop search suggestions when the user clicks outside', async () => {
		const label = '5333 Avenue Casgrain, Montréal, Quebec';
		const searchList = searchTransit(
			{ surface: 'list', query: 'casgrain' },
			{
				routes: [],
				stops: [],
				addresses: [{ lat: 45.5, lon: -73.6, label, source: 'geo_ca', precision: 'address' }],
			},
		);
		const { getByRole, queryByRole } = render(NavPill, {
			props: { locale: 'en', search: 'casgrain', searchList },
		});
		expect(getByRole('option', { name: `Address ${label}` })).toBeInTheDocument();
		await fireEvent.pointerDown(document.body);
		await waitFor(() => expect(queryByRole('option', { name: `Address ${label}` })).toBeNull());
	});
});
const NOTICE_EN =
	'Your searches are sent to our server and the Government of Canada Geo.ca service.';

function renderWithResults() {
	return render(NavPill, {
		props: {
			locale: 'en',
			search: '161',
			searchScope: 'all',
			searchList: searchTransit(
				{ surface: 'list', query: '161' },
				{ routes: [{ id: '161', short: '161', long: 'Van Horne', type: 3 }], stops: [] },
			),
		},
	});
}

describe('NavPill — the focus dropdown that houses the disclosure (M6i F25/F26)', () => {
	it('parks the visible disclosure inside that dropdown, ahead of the results', () => {
		const { getByRole } = renderWithResults();
		const form = getByRole('search');
		const panel = form.querySelector<HTMLElement>('[data-slot="nav-search-panel"]');
		expect(panel).not.toBeNull();

		const notice = within(panel!).getByText(NOTICE_EN);
		expect(notice).toHaveAttribute('aria-hidden', 'true');
		const results = panel!.querySelector('.nav-search-results');
		expect(results).not.toBeNull();
		expect(
			notice.compareDocumentPosition(results!) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();

		expect(document.querySelectorAll('#nav-search-notice')).toHaveLength(1);
		expect(panel!.querySelector('#nav-search-notice')).toBeNull();
	});
});

it.each(['en', 'fr'] as const)(
	'shows search Feed health in %s even when vehicles could not load',
	async (locale) => {
		const reader = createMemoryLiveReader();
		const manifest = ManifestSchema.parse({
			provider: 'octranspo',
			display_name: 'OC Transpo',
			attribution: 'Test',
			dataset_version: 'test',
			bbox: [-76, 45, -75, 46],
			labels: {},
			surfaces: [],
			files: { live: { ttl_s: 30, generated_utc: '2026-06-16T00:00:00Z' } },
		});
		let live!: LiveStore;
		const dispose = $effect.root(() => {
			live = createLiveStore(manifest, reader, { families: ['vehicles'] });
		});
		try {
			await live.refresh();
			const presentation = livePresentation({
				familyStates: live.familyStates,
				families: ['vehicles'],
				locale,
				page: 'map',
			});
			expect(presentation.notice.kind).toBe('unavailable');
			const view = render(NavPill, {
				props: { locale, search: '40061', searchPresentation: presentation },
			});
			expect(view.getByText(presentation.notice.message)).toHaveAttribute('role', 'status');
			expect(
				view.getByText(
					locale === 'en'
						? 'Live · update time unknown'
						: 'En direct · heure de mise à jour inconnue',
				),
			).toBeInTheDocument();
		} finally {
			live.stop();
			dispose();
		}
	},
);
