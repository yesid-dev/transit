import { fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { createMemoryLiveReader } from '#lib/v1/live/__fixtures__/reader.ts';
import { createLiveStore, type LiveStore } from '#lib/v1/live/store.svelte.ts';
import { livePresentation } from '#lib/v1/live/livePresentation.ts';
import { ManifestSchema } from '#lib/v1/schemas/index.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchTransit, withAddresses } from '#lib/search/transitSearch.ts';
import type { Vehicle } from '#lib/v1/schemas/index.ts';
import NavPill from './__fixtures__/NavPillHarness.svelte';
import { createNavigationRouter } from './__fixtures__/navigationRouter';
import catalog from '../../../../e2e/providers.json';
import { PublicProviderCatalogSchema } from '#lib/v1/providers.ts';
import { NAV_ITEMS } from '#lib/content/nav.ts';
import { navPillCopy } from '#lib/i18n/messages.ts';

// The owner's approved menu (R4.26, S0.4 Design E): four labelled groups, plain labels.
const MENU = {
	en: {
		search: 'Search',
		groups: [
			['Now', ['Overview', 'Live map', 'Network health']],
			['Explore', ['Lines', 'Stops', 'Vehicles']],
			[
				'Rankings and reports',
				['Worst lines and stops', 'Worst trips and vehicles', 'Daily report', 'Service alerts'],
			],
			['About the data', ['How we measure', 'Data health', 'Download the data']],
		],
	},
	fr: {
		search: 'Rechercher',
		groups: [
			['Maintenant', ['Aperçu', 'Carte en direct', 'Santé du réseau']],
			['Explorer', ['Lignes', 'Arrêts', 'Véhicules']],
			[
				'Classements et rapports',
				[
					'Pires lignes et arrêts',
					'Pires trajets et véhicules',
					'Rapport quotidien',
					'Avis de service',
				],
			],
			[
				'À propos des données',
				['Comment on mesure', 'Santé des données', 'Télécharger les données'],
			],
		],
	},
} as const;

it.each(['en', 'fr'] as const)(
	'names both search buttons and the menu in four labelled groups in %s',
	async (locale) => {
		const view = render(NavPill, { props: { locale } });
		// The phone trigger carries its word; beside the page links (1024 to 1279 px) the icon
		// button opens the same sheet under the same name. CSS shows one at a time.
		const buttons = view.getAllByRole('button', { name: navPillCopy[locale].searchAria.all });
		const slot = (name: string) => buttons.filter((button) => button.dataset.slot === name);
		const [phone] = slot('nav-compact-search');
		const [beside] = slot('nav-search-button');
		expect(buttons).toHaveLength(2);
		expect(phone).toHaveTextContent(MENU[locale].search);
		expect(beside).toHaveTextContent('');
		await fireEvent.click(view.getByRole('button', { name: navPillCopy[locale].openMenu }));
		const menu = within(view.getByRole('dialog'));
		expect(
			menu.getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent),
		).toEqual(MENU[locale].groups.map(([label]) => label));
		for (const [label, items] of MENU[locale].groups) {
			const links = within(menu.getByRole('list', { name: label })).getAllByRole('link');
			expect(links).toHaveLength(items.length);
			items.forEach((name, index) => expect(links[index]).toHaveAccessibleName(name));
		}
	},
);

it.each(['en', 'fr'] as const)(
	'links to the alert page even without a feed in %s',
	async (locale) => {
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
			expect(alert).toBeInTheDocument();
			view.unmount();
		}
	},
);

it('keeps city, period and mode in both existing and upcoming menu destinations', async () => {
	const url = new URL(
		'https://transit.test/fr/map?provider=octranspo&frameMode=live&recordFrom=2026-10-13&recordTo=2026-10-13&stop=42',
	);
	const view = render(NavPill, { props: { locale: 'fr', url, providerId: 'octranspo' } });
	await fireEvent.click(view.getByRole('button', { name: navPillCopy.fr.openMenu }));
	const menu = within(view.getByRole('list', { name: 'Explorer' }));
	for (const [name, path] of [
		['Lignes', '/fr/lines'],
		['Véhicules', '/fr/vehicles'],
	]) {
		const href = menu.getByRole('link', { name }).getAttribute('href')!;
		expect(new URL(href, url).pathname).toBe(path);
		expect(new URL(href, url).searchParams.toString()).toBe(
			'provider=octranspo&frameMode=live&recordFrom=2026-10-13&recordTo=2026-10-13',
		);
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
			const label = picker.closest('label')!;
			expect(label).toHaveAttribute('title', fullName);
			expect(within(picker).getByRole('option', { selected: true })).toHaveTextContent(fullName);
			expect(within(label).getByText(operator, { exact: true })).toBeInTheDocument();
		});

// WCAG 3.2.2: a city is never chosen by arrow keys alone. Keys preview it; Enter or a pointer
// switches; Escape or leaving the picker keeps the current city.
describe.each([
	['en', 'Press Enter to switch to Ottawa · OC Transpo.'],
	['fr', 'Appuyez sur Entrée pour passer à Ottawa · OC Transpo.'],
] as const)('city picker in %s', (locale, confirm) => {
	const providers = PublicProviderCatalogSchema.parse(catalog).providers;
	const setups = [
		['kit picker', { providers }],
		['fallback select', { providers, discoveryError: true }],
	] as const;
	const picker = (container: HTMLElement) =>
		within(container).getByRole('combobox', { name: new RegExp(navPillCopy[locale].network) });
	const arrowTo = async (select: HTMLElement, id: string) => {
		await fireEvent.keyDown(select, { key: 'ArrowUp' });
		await fireEvent.change(select, { target: { value: id } });
	};

	it.each(setups)('arrow keys only preview the city; Enter switches (%s)', async (_, props) => {
		const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
		const view = render(NavPill, { props: { locale, providerId: 'stm', ...props } });
		const select = picker(view.container);
		await arrowTo(select, 'octranspo');
		expect(assign).not.toHaveBeenCalled();
		await waitFor(() => expect(select).toHaveValue('octranspo'));
		expect(
			view.container.querySelector('[data-slot="network-choice"] [role="status"]'),
		).toHaveTextContent(confirm);
		await fireEvent.keyDown(select, { key: 'Enter' });
		expect(assign).toHaveBeenCalledOnce();
		expect(assign.mock.calls[0]![0]).toMatch(/provider=octranspo/);
	});

	it.each(setups)('Escape and leaving keep the current city (%s)', async (_, props) => {
		const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
		const view = render(NavPill, { props: { locale, providerId: 'stm', ...props } });
		const select = picker(view.container);
		await arrowTo(select, 'octranspo');
		await fireEvent.keyDown(select, { key: 'Escape' });
		await waitFor(() => expect(select).toHaveValue('stm'));
		await arrowTo(select, 'octranspo');
		await fireEvent.focusOut(select);
		await waitFor(() => expect(select).toHaveValue('stm'));
		await fireEvent.keyDown(select, { key: 'Enter' });
		expect(assign).not.toHaveBeenCalled();
		expect(view.container).not.toHaveTextContent(confirm);
	});

	it.each(setups)('a pointer choice switches at once (%s)', async (_, props) => {
		const assign = vi.spyOn(window.location, 'assign').mockImplementation(() => {});
		const view = render(NavPill, { props: { locale, providerId: 'stm', ...props } });
		const select = picker(view.container);
		await fireEvent.pointerDown(select);
		await fireEvent.change(select, { target: { value: 'octranspo' } });
		expect(assign).toHaveBeenCalledOnce();
		expect(assign.mock.calls[0]![0]).toMatch(/provider=octranspo/);
	});
});

it.each([
	['en', 'yesid. (opens in a new tab)', '/?provider=stm'],
	['fr', 'yesid. (nouvel onglet)', '/fr?provider=stm'],
] as const)('reads "yesid. | Transit" in the %s header', (locale, houseName, home) => {
	const view = render(NavPill, { props: { locale, providerId: 'stm' } });
	const nav = view.getByRole('navigation', { name: navPillCopy[locale].nav });
	const house = within(nav).getByRole('link', { name: houseName });
	expect(house).toHaveAttribute('href', 'https://yesid.dev');
	expect(house).toHaveAttribute('target', '_blank');
	expect(within(nav).getByRole('link', { name: 'Transit' })).toHaveAttribute('href', home);
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

it.each(['en', 'fr'] as const)(
	'uses public names in the %s city picker when discovery fails',
	(locale) => {
		const view = render(NavPill, {
			props: { locale, providerId: 'octranspo', discoveryError: true },
		});
		const picker = view.getByRole('combobox', { name: /Ottawa · OC Transpo/ });
		expect(within(picker).getByRole('option', { selected: true })).toHaveTextContent(
			'Ottawa · OC Transpo',
		);
		expect(within(picker).getByRole('option', { name: 'Montréal · STM' })).toHaveValue('stm');
		expect(
			within(picker.parentElement!).getByText('OC Transpo', { exact: true }),
		).toBeInTheDocument();
	},
);

it('uses a generic label for an unknown provider id', () => {
	const view = render(NavPill, { props: { locale: 'en', providerId: 'private-provider' } });
	const picker = view.getByRole('combobox', { name: /Unknown network/ });
	expect(within(picker).getByRole('option', { selected: true })).toHaveAccessibleName(
		'Unknown network',
	);
	expect(picker.parentElement).not.toHaveTextContent('private-provider');
});

it('uses the operator name when snapshot boot only knows the city id', () => {
	const label = { city: 'private-provider', operator: 'Example Transit' };
	const view = render(NavPill, {
		props: {
			locale: 'en',
			providerId: 'private-provider',
			providers: [
				{ id: 'private-provider', labels: { en: label, fr: label }, inputs: {}, alert_links: {} },
			],
			discoveryError: true,
		},
	});
	const picker = view.getByRole('combobox', { name: 'Transit network: Example Transit' });
	expect(within(picker).getByRole('option', { selected: true })).toHaveTextContent(
		'Example Transit',
	);
	expect(picker.parentElement).not.toHaveTextContent('private-provider');
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
		['en', 'Vehicle 40061 Line 161'],
		['fr', 'Véhicule 40061 Ligne 161'],
	] as const)("names a live vehicle's line in %s", (locale, name) => {
		const bus = { id: '40061', lat: 0, lon: 0, status: 'late', route: '161' } as Vehicle;
		const searchList = searchTransit(
			{ query: '40061' },
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

	it('uses the same search name and placeholder on the line catalogue', () => {
		const url = new URL('https://transit.local/lines');
		const { getByRole } = render(NavPill, { props: { locale: 'en', url } });
		expect(getByRole('combobox', { name: 'Search the network' })).toHaveAttribute(
			'placeholder',
			'Line, stop, vehicle',
		);
	});

	it('closes desktop search suggestions when the user clicks outside', async () => {
		const label = '5333 Avenue Casgrain, Montréal, Quebec';
		const searchList = withAddresses(
			searchTransit({ query: 'casgrain' }, { routes: [], stops: [] }),
			[{ lat: 45.5, lon: -73.6, label, source: 'geo_ca', precision: 'address' }],
		);
		const { getByRole, queryByRole } = render(NavPill, {
			props: { locale: 'en', search: 'casgrain', searchList },
		});
		expect(getByRole('option', { name: `Address ${label}` })).toBeInTheDocument();
		await fireEvent.pointerDown(document.body);
		await waitFor(() => expect(queryByRole('option', { name: `Address ${label}` })).toBeNull());
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
