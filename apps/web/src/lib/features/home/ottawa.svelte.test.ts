import { render, screen } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import HomeExplore from './HomeExplore.svelte';
import { homeCadence, homeCopy, homeGroups } from './home.copy';
import MapFilters from '../map/MapFilters.svelte';
import { createFilterStore, emptyFilterState } from '#lib/filters/index.ts';
import { hasOccupancy } from '#lib/site/transitDisplay.ts';
import { providerHasAlerts } from '#lib/v1/providers.ts';

describe.each(['en', 'fr'] as const)('provider cosmetics in %s', (locale) => {
	it.each(['octranspo', 'stm'])('%s exposes only available filters', (provider) => {
		const supported = provider === 'stm';
		const { container } = render(MapFilters, {
			props: {
				locale,
				store: createFilterStore(emptyFilterState(), () => {}),
				occupancyAvailable: hasOccupancy(supported || undefined, []),
				alertsAvailable: supported,
			},
		});
		expect(container.querySelector('[data-filter-group="crowding"]') != null).toBe(supported);
		expect(container.querySelector('[data-filter-group="alerts"]') != null).toBe(supported);
	});
	it.each(['octranspo', 'stm'])(
		'%s home groups offer Service alerts only with an alert feed',
		(provider) => {
			const available = providerHasAlerts({
				id: provider,
				labels: {
					en: { city: provider, operator: provider },
					fr: { city: provider, operator: provider },
				},
				inputs: { i3_alerts: provider === 'stm', service_alerts: provider === 'stm' },
				alert_links: {},
			});
			render(HomeExplore, {
				props: { locale, copy: homeCopy[locale], alertsAvailable: available },
			});
			const alerts = screen.queryByRole('link', {
				name: locale === 'en' ? 'Service alerts' : 'Avis de service',
			});
			expect(alerts != null).toBe(available);
			expect(
				homeGroups(available)
					.flatMap((group) => group.entries)
					.some((entry) => entry.href === '/alerts'),
			).toBe(available);
		},
	);
	it('states the live refresh rate a network declares and assumes none otherwise', () => {
		expect(homeCadence(locale, 20)).toContain(
			locale === 'en' ? 'every 20 seconds' : 'les 20 secondes',
		);
		expect(homeCadence(locale, null)).toBe(homeCopy[locale].cadence);
		expect(homeCadence(locale, undefined)).not.toMatch(/\d/);
	});
});
