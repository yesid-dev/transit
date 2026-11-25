import type { z } from 'zod';
import { resolveUrl } from '#lib/v1/config.ts';
import { getEntityJson, getEntityJsonWithBytes, sha256Hex } from '#lib/v1/http.ts';
import { HotspotsSchema } from '#lib/v1/schemas/hotspots.ts';
import { RouteReliabilityIndexSchema } from '#lib/v1/schemas/route_reliability_index.ts';
import { RouteReliabilitySchema } from '#lib/v1/schemas/route_reliability.ts';
import { StopReliabilitySchema } from '#lib/v1/schemas/stop_reliability.ts';
import {
	HistoricAvailabilityIndexSchema,
	HistoricCollectionIndexSchema,
	HistoricEntityDirectoryIndexSchema,
	LineHistoryPartitionSchema,
	StopHistoryPartitionSchema,
} from '#lib/v1/schemas/history.ts';
import { HistoryArtifactContractError } from '#lib/v1/history/partitions.ts';
import { encodeHistoryEntityId } from '#lib/v1/history/entity.ts';
import {
	historyPointerPayloadSha,
	isHistoryEntityIndexPath,
	isHistoryFamilyIndexPath,
} from '#lib/v1/history/pointers.ts';
import type { AdapterCtx } from './types';
import {
	R2_DEFAULTS as DEFAULTS,
	IMMUTABLE_CACHE,
	MUTABLE_CACHE,
	fetchOf,
	providerOf,
	loadManifest,
	readEntity,
	readWhole,
} from './r2.core';

let historyRefreshSequence = 0;

function freshHistoryUrl(path: string, fresh: boolean | undefined, ctx?: AdapterCtx): string {
	const url = resolveUrl(path, providerOf(ctx));
	if (!fresh) return url;
	historyRefreshSequence += 1;
	const token = `${Date.now().toString(36)}-${historyRefreshSequence.toString(36)}`;
	return `${url}?history_refresh=${encodeURIComponent(token)}`;
}

async function readOptionalHistory<T>(
	path: string,
	schema: z.ZodType<T>,
	label: string,
	ctx?: AdapterCtx,
): Promise<T | null> {
	const url = freshHistoryUrl(path, ctx?.freshHistoryParent, ctx);
	const expectedSha = historyPointerPayloadSha(path);
	const init = {
		cache: ctx?.freshHistoryParent
			? ('reload' as const)
			: expectedSha === null
				? MUTABLE_CACHE
				: IMMUTABLE_CACHE,
		providerId: providerOf(ctx),
		signal: ctx?.signal,
	};
	if (expectedSha !== null) {
		const raw = await getEntityJsonWithBytes(url, schema, label, fetchOf(ctx), init);
		if (raw === undefined) return null;
		if ((await sha256Hex(raw.bytes)) !== expectedSha) {
			throw new HistoryArtifactContractError(path, 'advertised pointer payload SHA-256 mismatch');
		}
		return raw.value;
	}
	const value = await getEntityJson(url, schema, label, fetchOf(ctx), init);
	return value ?? null;
}

function assertHistoryFamilyIndexPath(family: 'network' | 'lines' | 'stops', path: string): string {
	if (!isHistoryFamilyIndexPath(family, path)) {
		throw new HistoryArtifactContractError(path, `unsafe advertised ${family} history index path`);
	}
	return path;
}

function assertHistoryEntityIndexPath(
	family: 'lines' | 'stops',
	entityId: string,
	path: string,
): string {
	if (!isHistoryEntityIndexPath(family, entityId, path)) {
		throw new HistoryArtifactContractError(path, `unsafe advertised ${family} entity index path`);
	}
	return path;
}

function assertFamilyPartitionPath(
	family: 'network' | 'lines' | 'stops',
	entityId: string | null,
	path: string,
): string {
	const encoded = family === 'network' ? '' : `${encodeHistoryEntityId(entityId ?? '')}/`;
	const pattern = new RegExp(
		`^historic/history/${family}/${encoded}generations/[0-9a-f]{64}/\\d{4}-(?:0[1-9]|1[0-2])\\.json$`,
	);
	if (!pattern.test(path)) {
		throw new HistoryArtifactContractError(path, `unsafe advertised ${family} history path`);
	}
	return path;
}

async function readRawHistoryPartition<T>(
	path: string,
	schema: z.ZodType<T>,
	label: string,
	ctx?: AdapterCtx,
) {
	const value = await getEntityJsonWithBytes(
		resolveUrl(path, providerOf(ctx)),
		schema,
		label,
		fetchOf(ctx),
		{
			cache: IMMUTABLE_CACHE,
			providerId: providerOf(ctx),
			signal: ctx?.signal,
		},
	);
	return value ?? null;
}

export const historicPort = {
	historyIndex: (ctx?: AdapterCtx) =>
		readOptionalHistory(
			DEFAULTS.historic.history_index,
			HistoricAvailabilityIndexSchema,
			'historic.historyIndex',
			ctx,
		),
	lineHistoryDirectory: async (path: string, ctx?: AdapterCtx) =>
		readOptionalHistory(
			assertHistoryFamilyIndexPath('lines', path),
			HistoricEntityDirectoryIndexSchema,
			'historic.lineHistoryDirectory',
			ctx,
		),
	stopHistoryDirectory: async (path: string, ctx?: AdapterCtx) =>
		readOptionalHistory(
			assertHistoryFamilyIndexPath('stops', path),
			HistoricEntityDirectoryIndexSchema,
			'historic.stopHistoryDirectory',
			ctx,
		),
	lineHistoryIndex: async (entityId: string, path: string, ctx?: AdapterCtx) =>
		readOptionalHistory(
			assertHistoryEntityIndexPath('lines', entityId, path),
			HistoricCollectionIndexSchema,
			'historic.lineHistoryIndex',
			ctx,
		),
	stopHistoryIndex: async (entityId: string, path: string, ctx?: AdapterCtx) =>
		readOptionalHistory(
			assertHistoryEntityIndexPath('stops', entityId, path),
			HistoricCollectionIndexSchema,
			'historic.stopHistoryIndex',
			ctx,
		),
	lineHistoryPartition: async (entityId: string, path: string, ctx?: AdapterCtx) =>
		readRawHistoryPartition(
			assertFamilyPartitionPath('lines', entityId, path),
			LineHistoryPartitionSchema,
			'historic.lineHistoryPartition',
			ctx,
		),
	stopHistoryPartition: async (entityId: string, path: string, ctx?: AdapterCtx) =>
		readRawHistoryPartition(
			assertFamilyPartitionPath('stops', entityId, path),
			StopHistoryPartitionSchema,
			'historic.stopHistoryPartition',
			ctx,
		),
	hotspots: async (ctx?: AdapterCtx) => {
		const manifest = await loadManifest(ctx);
		return readWhole(
			manifest.files.historic?.hotspots ?? DEFAULTS.historic.hotspots,
			HotspotsSchema,
			'historic.hotspots',
			MUTABLE_CACHE,
			ctx,
		);
	},
	routeReliabilityIndex: async (ctx?: AdapterCtx) => {
		const manifest = await loadManifest(ctx);
		const url = resolveUrl(
			manifest.files.historic?.route_reliability_index ?? DEFAULTS.historic.route_reliability_index,
			providerOf(ctx),
		);
		const value = await getEntityJson(
			url,
			RouteReliabilityIndexSchema,
			'historic.routeReliabilityIndex',
			fetchOf(ctx),
			{ cache: MUTABLE_CACHE, providerId: providerOf(ctx), signal: ctx?.signal },
		);
		return value ?? null;
	},
	routeReliability: async (routeId: string, ctx?: AdapterCtx) => {
		const manifest = await loadManifest(ctx);
		return readEntity(
			'historic',
			manifest.files.historic?.route_reliability_prefix ??
				DEFAULTS.historic.route_reliability_prefix,
			routeId,
			RouteReliabilitySchema,
			'historic.routeReliability',
			MUTABLE_CACHE,
			ctx,
		);
	},
	stopReliability: async (stopId: string, ctx?: AdapterCtx) => {
		const manifest = await loadManifest(ctx);
		return readEntity(
			'historic',
			manifest.files.historic?.stop_reliability_prefix ?? DEFAULTS.historic.stop_reliability_prefix,
			stopId,
			StopReliabilitySchema,
			'historic.stopReliability',
			MUTABLE_CACHE,
			ctx,
		);
	},
};
