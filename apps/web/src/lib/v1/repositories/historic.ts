import { adapter } from '#lib/v1/adapter/index.ts';
import type { AdapterCtx } from '#lib/v1/adapter/index.ts';
import type { DateWindow } from '../history/window';
import {
	HistoryArtifactContractError,
	HistoryTransientPublicationError,
	loadHistoryPartitions,
} from '#lib/v1/history/partitions.ts';
import { encodeHistoryEntityId } from '#lib/v1/history/entity.ts';
import { isHistoryEntityIndexPath, isHistoryFamilyIndexPath } from '#lib/v1/history/pointers.ts';
import {
	selectLineHistoryPartitionRefs,
	selectStopHistoryPartitionRefs,
	validateLineHistoryPartition,
	validateStopHistoryPartition,
} from '#lib/v1/history/families.ts';
import type {
	HistoricAvailabilityIndex,
	HistoricCollectionIndex,
	HistoricEntityDirectoryIndex,
	HistoricFamilyAvailability,
	Hotspots,
	LineHistoryPartition,
	RouteReliability,
	StopReliability,
	StopHistoryPartition,
} from '#lib/v1/schemas/index.ts';
import {
	SHA256_PATTERN as SHA256,
	abortError,
	freshHistoryCtx,
	historyRootPath,
	verifyPartitionBytes,
} from './historyIntegrity';

export const getHistoricAvailability: (
	ctx?: AdapterCtx,
) => Promise<HistoricAvailabilityIndex | null> = (ctx) => adapter.historic.historyIndex(ctx);

const ALL_HISTORY: DateWindow = { from: '0001-01-01', to: '9999-12-31' };

function familyIndexPath(family: 'network' | 'lines' | 'stops'): string {
	return `historic/history/${family}/index.json`;
}

function rootEdge(
	root: HistoricAvailabilityIndex,
	family: 'network' | 'lines' | 'stops',
): HistoricFamilyAvailability | null {
	const matches = (root.families ?? []).filter((entry) => entry.family === family);
	if (matches.length > 1) {
		throw new HistoryArtifactContractError(historyRootPath(), `duplicate ${family} root edge`);
	}
	const edge = matches[0];
	if (edge === undefined) return null;
	if (
		edge.selection_mode !== 'range' ||
		!isHistoryFamilyIndexPath(family, edge.index_path) ||
		!SHA256.test(edge.collection_generation_id ?? '')
	) {
		throw new HistoryArtifactContractError(edge.index_path, `invalid ${family} root edge`);
	}
	return edge;
}

function assertDirectory(
	family: 'lines' | 'stops',
	directory: HistoricEntityDirectoryIndex,
): HistoricEntityDirectoryIndex {
	const path = familyIndexPath(family);
	if (
		directory.family !== family ||
		directory.selection_mode !== 'range' ||
		!SHA256.test(directory.collection_generation_id)
	) {
		throw new HistoryArtifactContractError(path, `invalid ${family} history directory`);
	}
	const ids = new Set<string>();
	const encodedIds = new Set<string>();
	const paths = new Set<string>();
	for (const entity of directory.entities ?? []) {
		const encoded = encodeHistoryEntityId(entity.entity_id);
		if (
			entity.encoded_id !== encoded ||
			!isHistoryEntityIndexPath(family, entity.entity_id, entity.index_path) ||
			!SHA256.test(entity.collection_generation_id)
		) {
			throw new HistoryArtifactContractError(entity.index_path, `invalid ${family} entity edge`);
		}
		if (
			ids.has(entity.entity_id) ||
			encodedIds.has(entity.encoded_id) ||
			paths.has(entity.index_path)
		) {
			throw new HistoryArtifactContractError(entity.index_path, 'duplicate history entity edge');
		}
		ids.add(entity.entity_id);
		encodedIds.add(entity.encoded_id);
		paths.add(entity.index_path);
	}
	return directory;
}

function assertCollection(
	family: 'lines' | 'stops',
	entityId: string,
	index: HistoricCollectionIndex,
): HistoricCollectionIndex {
	if (family === 'lines') selectLineHistoryPartitionRefs(entityId, index, ALL_HISTORY);
	else selectStopHistoryPartitionRefs(entityId, index, ALL_HISTORY);
	return index;
}

async function refreshRootEdge(
	family: 'network' | 'lines' | 'stops',
	ctx?: AdapterCtx,
): Promise<HistoricFamilyAvailability | null> {
	try {
		const freshRoot = await adapter.historic.historyIndex(freshHistoryCtx(ctx));
		return freshRoot == null ? null : rootEdge(freshRoot, family);
	} catch (error) {
		if (abortError(error)) throw error;
		return null;
	}
}

function transientGeneration(family: 'network' | 'lines' | 'stops', message: string): never {
	throw new HistoryTransientPublicationError(familyIndexPath(family), message);
}

async function getFamilyDirectory(
	family: 'lines' | 'stops',
	ctx?: AdapterCtx,
): Promise<HistoricEntityDirectoryIndex | null> {
	return (await getFamilyDirectoryDiscovery(family, ctx))?.directory ?? null;
}

interface FamilyDirectoryDiscovery {
	readonly directory: HistoricEntityDirectoryIndex;
	readonly indexPath: string;
}

async function getFamilyDirectoryDiscovery(
	family: 'lines' | 'stops',
	ctx?: AdapterCtx,
	onRoot?: (root: HistoricAvailabilityIndex | null) => void,
): Promise<FamilyDirectoryDiscovery | null> {
	const root = await adapter.historic.historyIndex(ctx);
	onRoot?.(root);
	if (root === null) return null;
	const edge = rootEdge(root, family);
	if (edge === null) return null;
	const directory =
		family === 'lines'
			? await adapter.historic.lineHistoryDirectory(edge.index_path, ctx)
			: await adapter.historic.stopHistoryDirectory(edge.index_path, ctx);
	if (directory === null) {
		throw new HistoryArtifactContractError(
			edge.index_path,
			'advertised history directory not found',
		);
	}
	assertDirectory(family, directory);
	if (directory.collection_generation_id !== edge.collection_generation_id) {
		const freshEdge = await refreshRootEdge(family, ctx);
		if (
			freshEdge?.collection_generation_id === directory.collection_generation_id &&
			freshEdge.index_path === edge.index_path
		) {
			return { directory, indexPath: edge.index_path };
		}
		if (freshEdge !== null) {
			const freshDirectory =
				family === 'lines'
					? await adapter.historic.lineHistoryDirectory(freshEdge.index_path, freshHistoryCtx(ctx))
					: await adapter.historic.stopHistoryDirectory(freshEdge.index_path, freshHistoryCtx(ctx));
			if (freshDirectory === null) {
				throw new HistoryArtifactContractError(
					freshEdge.index_path,
					'advertised history directory not found',
				);
			}
			assertDirectory(family, freshDirectory);
			if (freshDirectory.collection_generation_id === freshEdge.collection_generation_id) {
				return { directory: freshDirectory, indexPath: freshEdge.index_path };
			}
		}
		transientGeneration(
			family,
			`${family} generation still disagrees after one bounded pointer-chain refresh`,
		);
	}
	return { directory, indexPath: edge.index_path };
}

export function getLineHistoryDirectory(
	ctx?: AdapterCtx,
): Promise<HistoricEntityDirectoryIndex | null> {
	return getFamilyDirectory('lines', ctx);
}

export function getStopHistoryDirectory(
	ctx?: AdapterCtx,
): Promise<HistoricEntityDirectoryIndex | null> {
	return getFamilyDirectory('stops', ctx);
}

async function getEntityHistoryIndex(
	family: 'lines' | 'stops',
	entityId: string,
	ctx?: AdapterCtx,
	onRoot?: (root: HistoricAvailabilityIndex | null) => void,
): Promise<HistoricCollectionIndex | null> {
	const discovery = await getFamilyDirectoryDiscovery(family, ctx, onRoot);
	if (discovery === null) return null;
	const { directory, indexPath: directoryPath } = discovery;
	const edge = (directory.entities ?? []).find((entity) => entity.entity_id === entityId);
	if (edge === undefined) return null;
	const index =
		family === 'lines'
			? await adapter.historic.lineHistoryIndex(entityId, edge.index_path, ctx)
			: await adapter.historic.stopHistoryIndex(entityId, edge.index_path, ctx);
	if (index === null) {
		throw new HistoryArtifactContractError(
			edge.index_path,
			'advertised entity history index not found',
		);
	}
	assertCollection(family, entityId, index);
	if (index.collection_generation_id !== edge.collection_generation_id) {
		let freshDirectory: HistoricEntityDirectoryIndex | null;
		try {
			freshDirectory =
				family === 'lines'
					? await adapter.historic.lineHistoryDirectory(directoryPath, freshHistoryCtx(ctx))
					: await adapter.historic.stopHistoryDirectory(directoryPath, freshHistoryCtx(ctx));
			if (freshDirectory !== null) assertDirectory(family, freshDirectory);
		} catch (error) {
			if (abortError(error)) throw error;
			if (error instanceof HistoryArtifactContractError) throw error;
			throw new HistoryTransientPublicationError(
				edge.index_path,
				`${family} directory could not be refreshed during bounded pointer-chain recovery`,
			);
		}
		if (freshDirectory === null) {
			throw new HistoryArtifactContractError(
				directoryPath,
				'advertised history directory not found',
			);
		}
		let recoveryDirectory = freshDirectory;
		let recoveryDirectoryPath = directoryPath;
		let rootMatches =
			recoveryDirectory.collection_generation_id === directory.collection_generation_id;
		if (!rootMatches) {
			const freshRootEdge = await refreshRootEdge(family, ctx);
			if (freshRootEdge !== null && freshRootEdge.index_path !== recoveryDirectoryPath) {
				const rootDirectory =
					family === 'lines'
						? await adapter.historic.lineHistoryDirectory(
								freshRootEdge.index_path,
								freshHistoryCtx(ctx),
							)
						: await adapter.historic.stopHistoryDirectory(
								freshRootEdge.index_path,
								freshHistoryCtx(ctx),
							);
				if (rootDirectory === null) {
					throw new HistoryArtifactContractError(
						freshRootEdge.index_path,
						'advertised history directory not found',
					);
				}
				assertDirectory(family, rootDirectory);
				recoveryDirectory = rootDirectory;
				recoveryDirectoryPath = freshRootEdge.index_path;
			}
			rootMatches =
				freshRootEdge !== null &&
				freshRootEdge.index_path === recoveryDirectoryPath &&
				freshRootEdge.collection_generation_id === recoveryDirectory.collection_generation_id;
		}
		const freshEdge = (recoveryDirectory.entities ?? []).find(
			(entity) => entity.entity_id === entityId,
		);
		if (
			rootMatches &&
			freshEdge !== undefined &&
			freshEdge.collection_generation_id === index.collection_generation_id &&
			freshEdge.index_path === edge.index_path
		) {
			return index;
		}
		if (rootMatches && freshEdge !== undefined) {
			const freshIndex =
				family === 'lines'
					? await adapter.historic.lineHistoryIndex(
							entityId,
							freshEdge.index_path,
							freshHistoryCtx(ctx),
						)
					: await adapter.historic.stopHistoryIndex(
							entityId,
							freshEdge.index_path,
							freshHistoryCtx(ctx),
						);
			if (freshIndex === null) {
				throw new HistoryArtifactContractError(
					freshEdge.index_path,
					'advertised entity history index not found',
				);
			}
			assertCollection(family, entityId, freshIndex);
			if (freshIndex.collection_generation_id === freshEdge.collection_generation_id) {
				return freshIndex;
			}
		}
		throw new HistoryTransientPublicationError(
			edge.index_path,
			`${family} directory chain still disagrees after one bounded pointer-chain refresh`,
		);
	}
	return index;
}

export function getLineHistoryIndex(
	entityId: string,
	ctx?: AdapterCtx,
	onRoot?: (root: HistoricAvailabilityIndex | null) => void,
): Promise<HistoricCollectionIndex | null> {
	return getEntityHistoryIndex('lines', entityId, ctx, onRoot);
}

export function getStopHistoryIndex(
	entityId: string,
	ctx?: AdapterCtx,
	onRoot?: (root: HistoricAvailabilityIndex | null) => void,
): Promise<HistoricCollectionIndex | null> {
	return getEntityHistoryIndex('stops', entityId, ctx, onRoot);
}

export async function loadLineHistoryRange(
	entityId: string,
	index: HistoricCollectionIndex,
	window: DateWindow,
	ctx?: AdapterCtx,
): Promise<LineHistoryPartition[]> {
	const refs = selectLineHistoryPartitionRefs(entityId, index, window);
	return loadHistoryPartitions(
		refs,
		async (ref, signal) => {
			const raw = await adapter.historic.lineHistoryPartition(entityId, ref.path, {
				...ctx,
				signal,
			});
			if (raw === null) {
				throw new HistoryArtifactContractError(ref.path, 'advertised history partition not found');
			}
			await verifyPartitionBytes(ref, raw);
			return validateLineHistoryPartition(entityId, index, ref, raw.value);
		},
		{ signal: ctx?.signal },
	);
}

export async function loadStopHistoryRange(
	entityId: string,
	index: HistoricCollectionIndex,
	window: DateWindow,
	ctx?: AdapterCtx,
): Promise<StopHistoryPartition[]> {
	const refs = selectStopHistoryPartitionRefs(entityId, index, window);
	return loadHistoryPartitions(
		refs,
		async (ref, signal) => {
			const raw = await adapter.historic.stopHistoryPartition(entityId, ref.path, {
				...ctx,
				signal,
			});
			if (raw === null) {
				throw new HistoryArtifactContractError(ref.path, 'advertised history partition not found');
			}
			await verifyPartitionBytes(ref, raw);
			return validateStopHistoryPartition(entityId, index, ref, raw.value);
		},
		{ signal: ctx?.signal },
	);
}

export const getHotspots: (ctx?: AdapterCtx) => Promise<Hotspots> = (ctx) =>
	adapter.historic.hotspots(ctx);

export async function getRouteReliabilityIndex(ctx?: AdapterCtx): Promise<Set<string> | null> {
	const idx = await adapter.historic.routeReliabilityIndex(ctx);
	return idx ? new Set(idx.route_ids ?? []) : null;
}

export const getPublishedReliabilityIndex = (ctx?: AdapterCtx) =>
	adapter.historic.routeReliabilityIndex(ctx);

export const getRouteReliability: (
	routeId: string,
	ctx?: AdapterCtx,
) => Promise<RouteReliability | null> = (routeId, ctx) =>
	adapter.historic.routeReliability(routeId, ctx);

export const getStopReliability: (
	stopId: string,
	ctx?: AdapterCtx,
) => Promise<StopReliability | null> = (stopId, ctx) =>
	adapter.historic.stopReliability(stopId, ctx);
