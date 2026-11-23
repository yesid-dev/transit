import { resolveUrl } from '#lib/v1/config.ts';
import { getEntityJson } from '#lib/v1/http.ts';
import { DataHealthSchema } from '#lib/v1/schemas/data_health.ts';
import { fetchOf, loadManifest, MUTABLE_CACHE, providerOf, R2_DEFAULTS } from './r2.core';
import type { AdapterCtx } from './types';

export const dataHealthPort = {
	async get(ctx?: AdapterCtx) {
		const manifest = await loadManifest(ctx);
		const path = manifest.files.live.data_health ?? R2_DEFAULTS.live.data_health;
		const providerId = providerOf(ctx);
		const value = await getEntityJson(
			resolveUrl(path, providerId),
			DataHealthSchema,
			'dataHealth',
			fetchOf(ctx),
			{
				cache: MUTABLE_CACHE,
				providerId,
				signal: ctx?.signal,
			},
		);
		return value ?? null;
	},
};
