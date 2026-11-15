import { render } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicProvider } from '#lib/v1/schemas/providers.ts';
import StopsBlueprint from './StopsBlueprint.svelte';

const view = vi.hoisted(() => ({
	page: { data: {} as Record<string, unknown> },
	locale: 'en' as 'en' | 'fr',
}));
vi.mock('$app/state', () => ({ page: view.page }));
vi.mock('#lib/i18n/index.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#lib/i18n/index.ts')>();
	return { ...actual, getLocale: () => view.locale };
});

const METRO = 1;
const BUS = 3;
/** A GTFS route type the shared mode mapping does not name (trolleybus). */
const UNMAPPED = 11;
/** The mode-neutral metro drawing: names the mode, never an operator or a city. */
const METRO_ARTWORK = 'MÉTRO PLATFORM + CIRCULATION · PLAN';

function provider(id: string, operator: { en: string; fr: string }): PublicProvider {
	return {
		id,
		labels: {
			en: { city: 'Fixture City', operator: operator.en },
			fr: { city: 'Ville Fixture', operator: operator.fr },
		},
		alert_links: {},
		inputs: {},
	};
}

function routesIndex(...types: number[]) {
	return {
		generated_utc: '2026-11-14T00:00:00Z',
		routes: types.map((type, index) => ({
			id: `r${index}`,
			short: `${index}`,
			long: 'Line',
			type,
		})),
	};
}

/** The drawing's visible text, SVG labels included, for one set of page data. */
function drawnText(data: Record<string, unknown>): string {
	view.page.data = data;
	const { container } = render(StopsBlueprint);
	return container.textContent ?? '';
}

beforeEach(() => {
	view.locale = 'en';
	view.page.data = {};
});

describe('StopsBlueprint identity and artwork', () => {
	it('missing identity never renders STM', () => {
		const text = drawnText({
			provider: null,
			providerId: undefined,
			routesIndex: routesIndex(BUS),
		});

		expect(text).not.toContain('STM');
		expect(text).not.toContain('URBAN FLEET');
	});

	it('metro artwork follows route type, not provider id', () => {
		const stmBusOnly = drawnText({
			provider: provider('stm', { en: 'STM', fr: 'STM' }),
			providerId: 'stm',
			routesIndex: routesIndex(BUS),
		});
		expect(stmBusOnly).not.toContain(METRO_ARTWORK);

		const fixtureMetro = drawnText({
			provider: provider('fixture_city', { en: 'Fixture Transit', fr: 'Transports Fixture' }),
			providerId: 'fixture_city',
			routesIndex: routesIndex(METRO, BUS),
		});
		expect(fixtureMetro).toContain(METRO_ARTWORK);
		expect(fixtureMetro).not.toContain('STM');
	});

	it('unknown route modes do not claim metro service', () => {
		const stm = provider('stm', { en: 'STM', fr: 'STM' });
		for (const index of [null, undefined, routesIndex(UNMAPPED)]) {
			const text = drawnText({ provider: stm, providerId: 'stm', routesIndex: index });

			expect(text).not.toContain(METRO_ARTWORK);
			// Unknown is not evidence of a bus-only network either.
			expect(text).not.toContain('URBAN FLEET');
		}
	});

	it('operator comes from the selected catalogue in both languages', () => {
		const data = {
			provider: provider('fixture_city', { en: 'Fixture Transit', fr: 'Transports Fixture' }),
			providerId: 'fixture_city',
			routesIndex: routesIndex(BUS),
		};

		const english = drawnText(data);
		view.locale = 'fr';
		const french = drawnText(data);

		expect(english).toContain('SIDE ELEVATION · Fixture Transit URBAN FLEET');
		expect(french).toContain('SIDE ELEVATION · Transports Fixture URBAN FLEET');
		expect(english + french).not.toContain('STM');
	});
});
