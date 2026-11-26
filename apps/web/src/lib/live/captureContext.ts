import type { Locale } from '#lib/i18n/index.ts';
import type { ScheduleEdition } from '#lib/search/searchIndex.ts';
import type { V1Context } from '#lib/v1/boot.ts';
import { OCCUPANCY_LABELS, SEVERITY_LABELS, STATUS_LABELS } from '#lib/v1/enumLabels.ts';
import { ManifestSchema } from '#lib/v1/schemas/manifest.ts';
import type { PublicCity } from '#lib/v1/schemas/providers.ts';

const origin = 'https://data.yesid.dev';

export function captureContext(
	provider: PublicCity,
	lang: Locale,
	schedule: ScheduleEdition | null,
): V1Context {
	const entries = (prefix: string, values: Record<string, string>) =>
		Object.entries(values).map(([key, value]) => [`${prefix}.${key}`, value]);
	const labels = Object.fromEntries([
		...entries('status', STATUS_LABELS[lang]),
		...entries('severity', SEVERITY_LABELS[lang]),
		...entries('occupancy', OCCUPANCY_LABELS[lang]),
	]);
	const tile = /^\/data\/v1\/([^/]+)\/static\/basemap\/([a-zA-Z0-9_-]+\.pmtiles)$/.exec(
		provider.basemap_url ?? '',
	);
	const publishedTile =
		/^https:\/\/data\.yesid\.dev\/v2\/([^/]+)\/basemap\/[a-zA-Z0-9_-]+\.pmtiles$/.exec(
			provider.basemap_v2_url ?? '',
		);
	const basemap =
		publishedTile?.[1] === provider.id
			? publishedTile[0]
			: tile?.[1] === provider.id
				? `${origin}/v2/${provider.id}/basemap/${tile[2]}`
				: null;
	const position = provider.inputs.vehicle_positions === true;
	return {
		lang,
		provider,
		labels,
		manifest: ManifestSchema.parse({
			provider: provider.id,
			display_name: provider.labels[lang].operator,
			city: provider.labels[lang].city,
			tz: provider.timezone,
			bbox: provider.bounds ?? provider.fit_bounds ?? [],
			attribution: provider.attribution ?? '',
			basemap,
			dataset_version: schedule?.date ?? 'unavailable',
			labels,
			files: {
				live: {
					generated_utc: '1970-01-01T00:00:00Z',
					ttl_s: 20,
					source_lag_s: provider.live_source_lag_seconds ?? 0,
				},
				static: { generated_utc: schedule ? `${schedule.date}T00:00:00Z` : null },
			},
			surfaces: [],
			capabilities: {
				live_map: position ? 'enabled' : 'unavailable',
				network_health: position ? 'enabled' : 'unavailable',
				lookups: schedule ? 'enabled' : 'unavailable',
				reliability: 'enabled',
				accountability:
					provider.inputs.i3_alerts || provider.inputs.service_alerts ? 'enabled' : 'unavailable',
				data_trust: 'enabled',
			},
		}),
	};
}
