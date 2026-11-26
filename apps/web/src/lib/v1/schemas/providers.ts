import { z } from 'zod';
import { payloadEnvelopeFields } from './types';

const providerId = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/);
const label = z.object({ city: z.string().min(1), operator: z.string().min(1) });
const nameLanguage = z.enum(['en', 'fr']);
const nameSeparator = z.string().regex(/^\S+$/u);
const nameSeparators = z
	.object({
		ends: nameSeparator,
		languages: nameSeparator,
		language_order: z.tuple([nameLanguage, nameLanguage]),
	})
	.refine(
		({ ends, languages, language_order: [first, second] }) =>
			ends !== languages && first !== second,
	);
export type NameSeparators = z.infer<typeof nameSeparators>;
const bounds = z
	.tuple([z.number(), z.number(), z.number(), z.number()])
	.refine(
		([west, south, east, north]) =>
			-180 <= west && west < east && east <= 180 && -90 <= south && south < north && north <= 90,
	);

export const PublicProviderSchema = z.object({
	id: providerId,
	labels: z.object({ en: label, fr: label }),
	fit_bounds: bounds.nullable().optional(),
	max_bounds: bounds.nullable().optional(),
	geocode_context: z.string().nullable().optional(),
	posters_url: z.string().nullable().optional(),
	alert_links: z.object({ en: z.url().optional(), fr: z.url().optional() }),
	inputs: z.record(z.string(), z.boolean()),
});
export const PublicCitySchema = PublicProviderSchema.extend({
	name_separators: nameSeparators.optional(),
	timezone: z.string().min(1),
	record_through: z.iso.date().nullable().optional(),
	bounds: bounds.nullable(),
	basemap_url: z.string().nullable().optional(),
	basemap_v2_url: z.string().nullable().optional(),
	attribution: z.string().nullable().optional(),
	download_licence: z
		.object({
			source_date_required: z.boolean().optional(),
			attribution: z.object({ en: z.string(), fr: z.string() }),
			name: z.object({ en: z.string(), fr: z.string() }).optional(),
			url: z.object({ en: z.url(), fr: z.url() }).optional(),
			source: z.object({ en: z.string(), fr: z.string() }).optional(),
		})
		.nullable()
		.optional(),
	live_source_lag_seconds: z.int().nonnegative().optional(),
	/** Declared first day of the city's record. */
	record_from: z.iso.date().nullable().optional(),
	lines_without_live_data: z.array(
		z.object({
			route_types: z.array(z.int()),
			route_ids: z.array(z.string()),
		}),
	),
});
export type PublicCity = z.infer<typeof PublicCitySchema>;

export type PublicProvider = z.infer<typeof PublicProviderSchema>;

export const PublicProviderCatalogSchema = z
	.object({
		...payloadEnvelopeFields(),
		schema_version: z.literal(1).default(1),
		generated_utc: z.iso.datetime(),
		default_provider: providerId,
		providers: z.array(PublicProviderSchema).min(1),
	})
	.refine(({ default_provider, providers }) => {
		const ids = new Set(providers.map(({ id }) => id));
		return ids.size === providers.length && ids.has(default_provider);
	}, 'Catalog providers must be unique and include the default');
export const CityCatalogSchema = z
	.object({
		default_provider: providerId,
		providers: z.array(PublicCitySchema).min(1),
		cleaning_version: z.int().nonnegative().optional(),
	})
	.refine(({ default_provider, providers }) => {
		const ids = new Set(providers.map(({ id }) => id));
		return ids.size === providers.length && ids.has(default_provider);
	}, 'Catalog providers must be unique and include the default');

export type PublicProviderCatalog = z.infer<typeof PublicProviderCatalogSchema>;
export type CityCatalog = z.infer<typeof CityCatalogSchema>;
