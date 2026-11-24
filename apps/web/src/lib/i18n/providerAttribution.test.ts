import { expect, it } from 'vitest';
import { PublicCitySchema } from '#lib/v1/schemas/providers.ts';
import {
	datedProviderAttribution,
	providerAttribution,
	providerSourceAttribution,
} from './providerAttribution';

it.each(['stm', 'octranspo'])(
	'localizes %s attribution without changing the published English text',
	(provider) => {
		const published = `Contains ${provider} data`;
		expect(providerAttribution(provider, published, 'en')).toBe(published);
		expect(providerAttribution(provider, published, 'fr')).not.toMatch(/Contains/);
	},
);

it('credits the STM with its full French name and licence', () => {
	expect(providerAttribution('stm', 'Contains STM data', 'fr')).toBe(
		'Contient des données de la Société de transport de Montréal mises à disposition selon la licence CC BY 4.0.',
	);
});

it('uses Ottawa’s official French notice', () => {
	expect(providerAttribution('octranspo', 'Contains OC Transpo data', 'fr')).toBe(
		"Contient de l'information visée par la Licence du gouvernement ouvert – Ville d'Ottawa.",
	);
});

it('preserves attribution for providers without an override', () => {
	expect(providerAttribution('other', 'Provider licence', 'fr')).toBe('Provider licence');
});

it('renders a dated notice from the catalogue, including an unknown date in either locale', () => {
	const city = PublicCitySchema.parse({
		id: 'example',
		timezone: 'America/Toronto',
		bounds: null,
		labels: {
			en: { city: 'Example', operator: 'Example Transit' },
			fr: { city: 'Example', operator: 'Example Transit' },
		},
		alert_links: {},
		inputs: {},
		lines_without_live_data: [],
		download_licence: {
			source_date_required: true,
			attribution: { en: 'Update: {source_date}.', fr: 'Mise à jour : {source_date}.' },
		},
	});
	expect(datedProviderAttribution(city, 'en', '2026-11-20')).toBe('Update: 2026-11-20.');
	expect(datedProviderAttribution(city, 'en')).toBe('Update: unknown.');
	expect(datedProviderAttribution(city, 'fr')).toBe('Mise à jour : inconnue.');
	expect(providerSourceAttribution(city, 'fr', '2026-11-20')).toBe('Mise à jour : 2026-11-20.');
	expect(
		providerSourceAttribution(
			{
				...city,
				download_licence: {
					attribution: { en: 'City source', fr: 'Source municipale' },
				},
			},
			'fr',
		),
	).toBe('Source municipale');
	expect(
		providerSourceAttribution(
			{ ...city, download_licence: undefined, attribution: 'From the city' },
			'en',
		),
	).toBe('From the city');
	expect(datedProviderAttribution({ ...city, download_licence: undefined }, 'en')).toBeNull();
});
