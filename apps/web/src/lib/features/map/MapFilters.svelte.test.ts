import { fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it } from 'vitest';
import { STATUS_GLYPH, occupancyGlyph } from '#lib/components/dataviz/index.ts';
import { createFilterStore, emptyFilterState } from '#lib/filters/index.ts';
import { type OccupancyCode, type StatusCode } from '#lib/v1/schemas/index.ts';
import MapFilters from './MapFilters.svelte';

describe('MapFilters', () => {
	it('exposes marker and status settings as checked rows', async () => {
		const store = createFilterStore(emptyFilterState(), () => {});
		const view = render(MapFilters, { props: { store, locale: 'en' } });
		const vehicle = view.getByRole('checkbox', { name: /^Vehicle$/ });
		const stop = view.getByRole('checkbox', { name: 'Stop' });
		expect(vehicle).toBeChecked();
		expect(stop).toBeChecked();
		await fireEvent.click(stop);
		expect(stop).not.toBeChecked();
		expect(vehicle).toBeChecked();
		await fireEvent.click(vehicle);
		expect(vehicle).not.toBeChecked();
		expect(stop).not.toBeChecked();
		await fireEvent.click(view.getByRole('button', { name: 'Clear' }));
		expect(vehicle).toBeChecked();
		expect(stop).toBeChecked();
		const late = view.getByRole('checkbox', { name: 'Late' });
		await fireEvent.click(late);
		expect(late).toHaveAttribute('aria-checked', 'true');
		expect(store.status).toContain('late');
	});

	const routeFixtures = [
		{ id: '161', short: '161', long: 'Van Horne', type: 3 },
		{ id: '24', short: '24', long: 'Sherbrooke', type: 3 },
		{ id: '55', short: '55', long: 'Saint-Laurent', type: 3 },
	];
	const stopFixtures = [
		{ id: '53355', code: '53355', name: 'Van Horne / Rockland', lat: 45.52, lon: -73.62 },
	];
	const statusMappings = [
		{ code: 'early', en: 'Early', fr: 'En avance' },
		{ code: 'on_time', en: 'On time', fr: 'À l’heure' },
		{ code: 'late', en: 'Late', fr: 'En retard' },
		{ code: 'unknown', en: 'Delay unknown', fr: 'Retard inconnu' },
	] as const;
	const occupancyMappings = [
		{ code: 'empty', en: 'Empty', fr: 'Vide' },
		{ code: 'many_seats', en: 'Many seats', fr: 'Plusieurs places' },
		{ code: 'few_seats', en: 'Few seats', fr: 'Peu de places' },
		{ code: 'standing', en: 'Standing', fr: 'Debout' },
		{ code: 'full', en: 'Full', fr: 'Plein' },
	] as const;

	function expectGlyphMappings(
		container: HTMLElement,
		kind: 'status' | 'crowding',
		mappings: typeof statusMappings | typeof occupancyMappings,
		locale: 'en' | 'fr',
	): void {
		const group = container.querySelector<HTMLElement>(`[data-filter-group="${kind}"]`)!;
		for (const mapping of mappings) {
			const label = mapping[locale];
			const expectedGlyph =
				kind === 'crowding'
					? occupancyGlyph(mapping.code as OccupancyCode)
					: STATUS_GLYPH[mapping.code as StatusCode];
			const chip = within(group).getByRole('checkbox', { name: label });
			const glyph = chip.querySelector(
				`[data-m6d-glyph-kind="${kind}"][data-m6d-glyph-code="${mapping.code}"]`,
			);
			expect(glyph).toHaveTextContent(expectedGlyph);
			expect(glyph).toHaveAttribute('aria-hidden', 'true');
			expect(chip.querySelector('.mf-chip-text')).toHaveTextContent(label);
			expect(chip).toHaveAccessibleName(label);
		}
	}

	it.each(['en', 'fr'] as const)('hides unavailable alert filtering (%s)', async (locale) => {
		const store = createFilterStore(emptyFilterState(), () => {});
		const officialAlertsUrl = 'https://transport.example/notices';
		const view = render(MapFilters, {
			props: { store, locale, alertsAvailable: false, officialAlertsUrl },
		});
		expect(view.container.querySelector('[data-filter-group="alerts"]')).toBeNull();
		expect(
			view.getByText(locale === 'en' ? 'No notices to filter.' : 'Aucun avis à filtrer.'),
		).toBeVisible();
		expect(
			view.getByRole('link', {
				name: locale === 'fr' ? 'Consulter les avis officiels' : 'Check the official notices',
			}),
		).toHaveAttribute('href', officialAlertsUrl);
		expect(store.alerts).toEqual([]);
	});

	it('renders ordered disclosures and applies their filters', async () => {
		let pushed = '';
		const store = createFilterStore(emptyFilterState(), (search) => {
			pushed = search;
		});

		const { container, getByText, getByRole, getAllByText, queryByRole } = render(MapFilters, {
			props: { store, locale: 'en', routes: routeFixtures },
		});

		expect(getByText('Status')).toBeTruthy();
		expect(getByText('Room on board')).toBeTruthy();
		expect(getByText('Markers')).toBeTruthy();
		expect(getAllByText('Notices').length).toBeGreaterThan(0);
		expect(
			getByRole('checkbox', { name: 'With notices Show markers with notices' }),
		).not.toBeDisabled();
		expect(container.querySelectorAll('.mf-group-badge[data-icon]').length).toBeGreaterThanOrEqual(
			4,
		);

		expect(queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
		expect(
			Array.from(container.querySelectorAll('[data-filter-group]'), (group) =>
				group.getAttribute('data-filter-group'),
			),
		).toEqual(['markers', 'alerts', 'status', 'crowding']);
		for (const name of ['Markers', 'Notices', 'Status', 'Room on board']) {
			expect(getByRole('button', { name })).toHaveAttribute('aria-expanded', 'true');
		}
		expect(queryByRole('button', { name: /^Active/ })).not.toBeInTheDocument();

		const vehicle = getByRole('checkbox', { name: /^Vehicle$/ });
		await fireEvent.click(vehicle);

		expect(pushed).toBe('entity=stop');
		expect(store.entities).toEqual(['stop']);
		expect(getByRole('button', { name: 'Clear' })).toBeInTheDocument();

		store.addRoute('161');
		await waitFor(() => expect(getByRole('button', { name: 'Remove line 161' })).toBeVisible());
		expect(queryByRole('button', { name: /^Active/ })).not.toBeInTheDocument();
	});

	it.each(['en', 'fr'] as const)(
		'renders canonical glyphs without changing %s chip names',
		(locale) => {
			const store = createFilterStore(emptyFilterState());
			const { container } = render(MapFilters, { props: { store, locale } });
			expectGlyphMappings(container, 'status', statusMappings, locale);
			expectGlyphMappings(container, 'crowding', occupancyMappings, locale);
		},
	);

	it('renders line tags and active stop and vehicle picks as removable filters', async () => {
		let pushed = '';
		const store = createFilterStore(emptyFilterState(), (search) => {
			pushed = search;
		});
		store.addRoute('161');
		store.addStop('53355');
		store.addVehicle('40061');

		const { getByRole, queryByRole, queryByText } = render(MapFilters, {
			props: { store, locale: 'en', routes: routeFixtures, stops: stopFixtures },
		});

		expect(queryByRole('searchbox', { name: 'Search routes' })).not.toBeInTheDocument();
		expect(queryByText('Drilldown')).not.toBeInTheDocument();
		expect(getByRole('button', { name: 'Remove line 161' })).toBeVisible();
		expect(
			getByRole('button', { name: 'Remove filter: Van Horne / Rockland · 53355' }),
		).toHaveTextContent('Van Horne / Rockland');
		expect(getByRole('button', { name: 'Remove filter: Vehicle 40061' })).toHaveTextContent(
			'Vehicle 40061',
		);

		await fireEvent.click(getByRole('button', { name: 'Remove line 161' }));

		expect(pushed).toBe('stop=53355&vehicle=40061');
		expect([...store.routes]).toEqual([]);
		expect(queryByRole('button', { name: 'Remove line 161' })).not.toBeInTheDocument();

		await fireEvent.click(getByRole('button', { name: 'Clear' }));

		expect(pushed).toBe('');
		expect(store.isEmpty).toBe(true);
	});

	it('counts line tags and other filters in the header while Active counts other selected IDs', () => {
		const store = createFilterStore(emptyFilterState());
		store.addRoute('161');
		store.addStop('53355');
		store.toggleEntity('stop');
		store.toggleStatus('late');

		const { container, getByRole } = render(MapFilters, {
			props: {
				store,
				locale: 'en',

				routes: routeFixtures,
			},
		});

		expect(container.querySelector('.mf-head-count')).toHaveTextContent('4');
		expect(getByRole('button', { name: /^Active/ })).toHaveTextContent('1');
	});

	it('renders removable trip chips without the old drilldown bucket', async () => {
		let pushed = '';
		const store = createFilterStore(emptyFilterState(), (search) => {
			pushed = search;
		});
		store.addTrip('296851600');

		const { getByRole, getByText, queryByText, queryByRole } = render(MapFilters, {
			props: { store, locale: 'en' },
		});

		expect(queryByText('Drilldown')).not.toBeInTheDocument();
		expect(getByText('Trips')).toBeInTheDocument();
		expect(getByRole('button', { name: 'Remove filter: Trip 296851600' })).toBeInTheDocument();

		await fireEvent.click(getByRole('button', { name: 'Remove filter: Trip 296851600' }));

		expect([...store.trips]).toEqual([]);
		expect(pushed).toBe('');
		expect(queryByRole('button', { name: /^Active/ })).not.toBeInTheDocument();
		expect(getByRole('button', { name: 'Markers' })).toHaveFocus();
	});

	it('keeps selected route pills removable when multiple routes are active', async () => {
		let pushed = '';
		const store = createFilterStore(emptyFilterState(), (search) => {
			pushed = search;
		});
		store.addRoute('161');
		store.addRoute('24');

		const { getByRole } = render(MapFilters, {
			props: { store, locale: 'en', routes: routeFixtures },
		});

		expect(getByRole('button', { name: 'Remove line 161' })).toBeVisible();
		expect(getByRole('button', { name: 'Remove line 24' })).toBeVisible();

		await fireEvent.click(getByRole('button', { name: 'Remove line 161' }));

		expect(pushed).toBe('route=24');
		expect([...store.routes]).toEqual(['24']);
	});

	it('renders the filter title above the motion header', () => {
		const store = createFilterStore(emptyFilterState(), () => {});
		const header = createRawSnippet(() => ({
			render: () => `<div data-testid="motion-slot">motion</div>`,
		}));

		const { container, getByTestId } = render(MapFilters, {
			props: { store, locale: 'en', header },
		});

		const slot = getByTestId('motion-slot');
		expect(slot).toBeInTheDocument();

		const head = container.querySelector('.mf-head')!;
		const headerWrap = container.querySelector('[data-testid="map-filter-header"]')!;
		expect(
			head.compareDocumentPosition(headerWrap) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(headerWrap.contains(slot)).toBe(true);
	});

	it('renders the filter title and omits a missing header', () => {
		const store = createFilterStore(emptyFilterState(), () => {});

		const { container } = render(MapFilters, {
			props: { store, locale: 'en' },
		});

		expect(container.querySelector('.mf-title')).toHaveTextContent('Filter');

		expect(container.querySelector('[data-testid="map-filter-header"]')).not.toBeInTheDocument();
	});

	it('keeps the legend out of controls', () => {
		const view = render(MapFilters, {
			props: { store: createFilterStore(emptyFilterState()), locale: 'fr' },
		});
		expect(view.container.querySelector('[data-filter-group]')).toHaveAttribute(
			'data-filter-group',
			'markers',
		);
		expect(view.queryByRole('button', { name: 'Légende' })).toBeNull();
		expect(view.queryByRole('list', { name: 'Légende' })).toBeNull();
	});
});

describe.each(['en', 'fr'] as const)('out-of-service filter %s', (locale) => {
	it('starts off, persists its toggle, and clears', async () => {
		const writes: string[] = [];
		const store = createFilterStore(emptyFilterState(), (value) => writes.push(value));
		const view = render(MapFilters, { store, locale });
		const name = locale === 'en' ? 'Out-of-service vehicles' : 'Véhicules hors service';
		const button = view.getByRole('checkbox', { name });
		expect(button).toHaveAttribute('aria-checked', 'false');
		await fireEvent.click(button);
		expect(button).toHaveAttribute('aria-checked', 'true');
		expect(writes.at(-1)).toContain('out_of_service=1');
		store.clear();
		await waitFor(() => expect(button).toHaveAttribute('aria-checked', 'false'));
	});
});
