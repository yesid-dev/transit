import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AdapterCtx } from '#lib/v1/adapter/index.ts';
import { adapter } from '#lib/v1/adapter/index.ts';
import {
	HistoryArtifactContractError,
	HistoryTransientPublicationError,
} from '#lib/v1/history/index.ts';
import { sha256Hex } from '#lib/v1/http.ts';
import {
	HistoricCollectionIndexSchema,
	HistoricEntityDirectoryIndexSchema,
	HistoricAvailabilityIndexSchema,
	LineHistoryPartitionSchema,
	StopHistoryPartitionSchema,
} from '#lib/v1/schemas/index.ts';
import {
	getHistoricAvailability,
	getLineHistoryDirectory,
	getLineHistoryIndex,
	getStopHistoryDirectory,
	getStopHistoryIndex,
	loadLineHistoryRange,
	loadStopHistoryRange,
} from './historic';

const ISO = '2026-03-31T12:00:00Z';
const GENERATION = 'b'.repeat(64);
const NEXT_GENERATION = 'c'.repeat(64);
const OLD_POINTER_SHA = 'd'.repeat(64);
const NEW_POINTER_SHA = 'e'.repeat(64);

function availabilityRoot(
	families: Array<{
		family: string;
		index_path: string;
		collection_generation_id: string;
	}>,
) {
	return HistoricAvailabilityIndexSchema.parse({
		generated_utc: ISO,
		families: families.map((family) => ({ ...family, selection_mode: 'range' })),
	});
}

function rootFamily(
	family: 'network' | 'lines' | 'stops',
	generation = GENERATION,
	indexPath = `historic/history/${family}/index.json`,
) {
	return {
		family,
		index_path: indexPath,
		collection_generation_id: generation,
	};
}

function versionedFamilyPath(family: 'network' | 'lines' | 'stops', sha = OLD_POINTER_SHA): string {
	return `historic/history/${family}/generations/${sha}/index.json`;
}

function versionedEntityPath(
	family: 'lines' | 'stops',
	encodedId: string,
	sha = OLD_POINTER_SHA,
): string {
	return `historic/history/${family}/${encodedId}/generations/${sha}/index.json`;
}

function collectionIndex(
	family: 'network' | 'lines' | 'stops',
	generation = GENERATION,
	entityId: string | null = null,
	partitions: Array<Record<string, unknown>> = [],
	metrics: Array<Record<string, unknown>> = [],
) {
	const coverageStarts = partitions
		.map((partition) => partition.coverage_start)
		.filter((value): value is string => typeof value === 'string')
		.sort();
	const coverageEnds = partitions
		.map((partition) => partition.coverage_end)
		.filter((value): value is string => typeof value === 'string')
		.sort();
	return HistoricCollectionIndexSchema.parse({
		generated_utc: ISO,
		family,
		selection_mode: 'range',
		entity_id: entityId,
		collection_generation_id: generation,
		first_available_date: coverageStarts[0] ?? null,
		last_available_date: coverageEnds.at(-1) ?? null,
		partitions,
		metrics,
	});
}

function entityDirectory(
	family: 'lines' | 'stops',
	directoryGeneration = GENERATION,
	entityId = 'A/B',
	entityGeneration = GENERATION,
	entityIndexPath?: string,
) {
	const encodedId = Array.from(new TextEncoder().encode(entityId), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('');
	return HistoricEntityDirectoryIndexSchema.parse({
		generated_utc: ISO,
		family,
		selection_mode: 'range',
		collection_generation_id: directoryGeneration,
		entities: [
			{
				entity_id: entityId,
				encoded_id: encodedId,
				index_path: entityIndexPath ?? `historic/history/${family}/${encodedId}/index.json`,
				collection_generation_id: entityGeneration,
			},
		],
	});
}

async function entityArtifact(
	family: 'lines' | 'stops',
	entityId: string,
	month: string,
	day: string,
) {
	const encodedId = Array.from(new TextEncoder().encode(entityId), (byte) =>
		byte.toString(16).padStart(2, '0'),
	).join('');
	const value =
		family === 'lines'
			? LineHistoryPartitionSchema.parse({
					generated_utc: ISO,
					month,
					entity_id: entityId,
					days: [
						{
							date: day,
							delay: {
								observation_count: 10,
								in_clamp_observation_count: 10,
								on_time_count: 8,
								severe_count: 1,
								sum_delay_seconds: 100,
							},
						},
					],
				})
			: StopHistoryPartitionSchema.parse({
					generated_utc: ISO,
					month,
					entity_id: entityId,
					days: [
						{
							date: day,
							delay: {
								observation_count: 10,
								in_clamp_observation_count: 10,
								severe_count: 1,
								sum_delay_seconds: 100,
							},
						},
					],
				});
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	const sha = await sha256Hex(bytes);
	return {
		value,
		bytes,
		ref: {
			path: `historic/history/${family}/${encodedId}/generations/${sha}/${month}.json`,
			coverage_start: day,
			coverage_end: day,
			count: 1,
			sha256: sha,
			byte_size: bytes.byteLength,
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('historic repository collection seams', () => {
	it('delegates the optional history index with the exact adapter context', async () => {
		const ctx: AdapterCtx = { signal: new AbortController().signal };
		const history = HistoricAvailabilityIndexSchema.parse({ generated_utc: ISO, families: [] });
		const historyPort = vi.spyOn(adapter.historic, 'historyIndex').mockResolvedValue(history);

		await expect(getHistoricAvailability(ctx)).resolves.toBe(history);
		expect(historyPort).toHaveBeenCalledWith(ctx);
	});
});

describe('retained family discovery and generation pins', () => {
	it('refreshes only the immediate directory once for an entity-index generation race', async () => {
		const root = availabilityRoot([rootFamily('lines')]);
		const firstDirectory = entityDirectory('lines', GENERATION, 'A/B', GENERATION);
		const freshDirectory = entityDirectory('lines', GENERATION, 'A/B', NEXT_GENERATION);
		const rootPort = vi.spyOn(adapter.historic, 'historyIndex').mockResolvedValue(root);
		const directoryPort = vi
			.spyOn(adapter.historic, 'lineHistoryDirectory')
			.mockResolvedValueOnce(firstDirectory)
			.mockResolvedValueOnce(freshDirectory);
		const child = collectionIndex('lines', NEXT_GENERATION, 'A/B');
		const childPort = vi.spyOn(adapter.historic, 'lineHistoryIndex').mockResolvedValue(child);

		await expect(getLineHistoryIndex('A/B')).resolves.toBe(child);
		expect(rootPort).toHaveBeenCalledTimes(1);
		expect(childPort).toHaveBeenCalledTimes(1);
		expect(directoryPort).toHaveBeenNthCalledWith(
			1,
			'historic/history/lines/index.json',
			undefined,
		);
		expect(directoryPort).toHaveBeenNthCalledWith(
			2,
			'historic/history/lines/index.json',
			expect.objectContaining({ freshHistoryParent: true }),
		);
	});

	it('reloads a stale fixed entity index once when its directory is already newer', async () => {
		const root = availabilityRoot([rootFamily('lines', NEXT_GENERATION)]);
		const directory = entityDirectory('lines', NEXT_GENERATION, 'A/B', NEXT_GENERATION);
		const rootPort = vi.spyOn(adapter.historic, 'historyIndex').mockResolvedValue(root);
		const directoryPort = vi
			.spyOn(adapter.historic, 'lineHistoryDirectory')
			.mockResolvedValue(directory);
		const staleChild = collectionIndex('lines', GENERATION, 'A/B');
		const freshChild = collectionIndex('lines', NEXT_GENERATION, 'A/B');
		const childPort = vi
			.spyOn(adapter.historic, 'lineHistoryIndex')
			.mockResolvedValueOnce(staleChild)
			.mockResolvedValueOnce(freshChild);

		await expect(getLineHistoryIndex('A/B')).resolves.toBe(freshChild);
		expect(rootPort).toHaveBeenCalledTimes(1);
		expect(directoryPort).toHaveBeenCalledTimes(2);
		expect(childPort).toHaveBeenCalledTimes(2);
		expect(directoryPort).toHaveBeenNthCalledWith(
			2,
			'historic/history/lines/index.json',
			expect.objectContaining({ freshHistoryParent: true }),
		);
		expect(childPort).toHaveBeenNthCalledWith(
			2,
			'A/B',
			'historic/history/lines/412f42/index.json',
			expect.objectContaining({ freshHistoryParent: true }),
		);
	});

	it('fails closed after one bounded entity child reload when the mismatch persists', async () => {
		const root = availabilityRoot([rootFamily('lines', NEXT_GENERATION)]);
		vi.spyOn(adapter.historic, 'historyIndex').mockResolvedValue(root);
		const directoryPort = vi
			.spyOn(adapter.historic, 'lineHistoryDirectory')
			.mockResolvedValue(entityDirectory('lines', NEXT_GENERATION, 'A/B', NEXT_GENERATION));
		const childPort = vi
			.spyOn(adapter.historic, 'lineHistoryIndex')
			.mockResolvedValue(collectionIndex('lines', GENERATION, 'A/B'));

		await expect(getLineHistoryIndex('A/B')).rejects.toBeInstanceOf(
			HistoryTransientPublicationError,
		);
		expect(directoryPort).toHaveBeenCalledTimes(2);
		expect(childPort).toHaveBeenCalledTimes(2);
	});

	it('keeps the advertised directory 404 strict during entity-chain recovery', async () => {
		const root = availabilityRoot([rootFamily('lines', NEXT_GENERATION)]);
		vi.spyOn(adapter.historic, 'historyIndex').mockResolvedValue(root);
		vi.spyOn(adapter.historic, 'lineHistoryDirectory')
			.mockResolvedValueOnce(entityDirectory('lines', NEXT_GENERATION, 'A/B', NEXT_GENERATION))
			.mockResolvedValueOnce(null);
		vi.spyOn(adapter.historic, 'lineHistoryIndex').mockResolvedValueOnce(
			collectionIndex('lines', GENERATION, 'A/B'),
		);

		await expect(getLineHistoryIndex('A/B')).rejects.toMatchObject({
			name: 'HistoryArtifactContractError',
			path: 'historic/history/lines/index.json',
		});
	});

	it('reloads a stale fixed directory once when its root is already newer', async () => {
		const root = availabilityRoot([rootFamily('stops', NEXT_GENERATION)]);
		const rootPort = vi.spyOn(adapter.historic, 'historyIndex').mockResolvedValue(root);
		const staleDirectory = entityDirectory('stops', GENERATION, '..', GENERATION);
		const freshDirectory = entityDirectory('stops', NEXT_GENERATION, '..', NEXT_GENERATION);
		const directoryPort = vi
			.spyOn(adapter.historic, 'stopHistoryDirectory')
			.mockResolvedValueOnce(staleDirectory)
			.mockResolvedValueOnce(freshDirectory);

		await expect(getStopHistoryDirectory()).resolves.toBe(freshDirectory);
		expect(rootPort).toHaveBeenCalledTimes(2);
		expect(directoryPort).toHaveBeenCalledTimes(2);
		expect(directoryPort).toHaveBeenNthCalledWith(
			2,
			'historic/history/stops/index.json',
			expect.objectContaining({ freshHistoryParent: true }),
		);
	});

	it('fails transiently when an entity retry sees a directory generation newer than the root', async () => {
		const root = availabilityRoot([rootFamily('lines', GENERATION)]);
		const firstDirectory = entityDirectory('lines', GENERATION, 'A/B', GENERATION);
		const freshDirectory = entityDirectory('lines', NEXT_GENERATION, 'A/B', NEXT_GENERATION);
		const rootPort = vi.spyOn(adapter.historic, 'historyIndex').mockResolvedValue(root);
		const directoryPort = vi
			.spyOn(adapter.historic, 'lineHistoryDirectory')
			.mockResolvedValueOnce(firstDirectory)
			.mockResolvedValueOnce(freshDirectory);
		vi.spyOn(adapter.historic, 'lineHistoryIndex').mockResolvedValue(
			collectionIndex('lines', NEXT_GENERATION, 'A/B'),
		);

		await expect(getLineHistoryIndex('A/B')).rejects.toBeInstanceOf(
			HistoryTransientPublicationError,
		);
		expect(rootPort).toHaveBeenCalledTimes(2);
		expect(rootPort).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ freshHistoryParent: true }),
		);
		expect(directoryPort).toHaveBeenCalledTimes(2);
	});

	it('validates the root-to-directory path and refreshes that root pin exactly once', async () => {
		const badRoot = {
			...availabilityRoot([]),
			families: [
				{
					...rootFamily('lines', GENERATION, 'historic/history/stops/index.json'),
					selection_mode: 'range' as const,
				},
			],
		};
		const directoryPort = vi.spyOn(adapter.historic, 'lineHistoryDirectory');
		vi.spyOn(adapter.historic, 'historyIndex').mockResolvedValueOnce(badRoot);
		await expect(getLineHistoryDirectory()).rejects.toBeInstanceOf(HistoryArtifactContractError);
		expect(directoryPort).not.toHaveBeenCalled();
		vi.mocked(adapter.historic.historyIndex).mockClear();

		const rootPort = vi
			.spyOn(adapter.historic, 'historyIndex')
			.mockResolvedValueOnce(availabilityRoot([rootFamily('lines', GENERATION)]))
			.mockResolvedValueOnce(availabilityRoot([rootFamily('lines', NEXT_GENERATION)]));
		const directory = entityDirectory('lines', NEXT_GENERATION);
		directoryPort.mockResolvedValue(directory);

		await expect(getLineHistoryDirectory()).resolves.toBe(directory);
		expect(rootPort).toHaveBeenCalledTimes(2);
		expect(directoryPort).toHaveBeenCalledTimes(1);
	});

	it('returns null for an unadvertised entity but makes an advertised entity 404 strict', async () => {
		vi.spyOn(adapter.historic, 'historyIndex').mockResolvedValue(
			availabilityRoot([rootFamily('lines')]),
		);
		vi.spyOn(adapter.historic, 'lineHistoryDirectory')
			.mockResolvedValueOnce(entityDirectory('lines', GENERATION, 'other'))
			.mockResolvedValueOnce(entityDirectory('lines', GENERATION, 'A/B'));
		const childPort = vi.spyOn(adapter.historic, 'lineHistoryIndex').mockResolvedValue(null);

		await expect(getLineHistoryIndex('A/B')).resolves.toBeNull();
		await expect(getLineHistoryIndex('A/B')).rejects.toMatchObject({
			name: 'HistoryArtifactContractError',
			path: 'historic/history/lines/412f42/index.json',
		});
		expect(childPort).toHaveBeenCalledTimes(1);
	});

	it('discovers matching line and stop directories through their exact root pins', async () => {
		vi.spyOn(adapter.historic, 'historyIndex')
			.mockResolvedValueOnce(availabilityRoot([rootFamily('lines')]))
			.mockResolvedValueOnce(availabilityRoot([rootFamily('stops')]));
		const line = entityDirectory('lines');
		const stop = entityDirectory('stops', GENERATION, '..');
		vi.spyOn(adapter.historic, 'lineHistoryDirectory').mockResolvedValue(line);
		vi.spyOn(adapter.historic, 'stopHistoryDirectory').mockResolvedValue(stop);

		await expect(getLineHistoryDirectory()).resolves.toBe(line);
		await expect(getStopHistoryDirectory()).resolves.toBe(stop);
	});

	it('loads a matching Stop entity index without touching any other entity', async () => {
		vi.spyOn(adapter.historic, 'historyIndex').mockResolvedValue(
			availabilityRoot([rootFamily('stops')]),
		);
		vi.spyOn(adapter.historic, 'stopHistoryDirectory').mockResolvedValue(
			entityDirectory('stops', GENERATION, '..'),
		);
		const child = collectionIndex('stops', GENERATION, '..');
		const childPort = vi.spyOn(adapter.historic, 'stopHistoryIndex').mockResolvedValue(child);

		await expect(getStopHistoryIndex('..')).resolves.toBe(child);
		expect(childPort).toHaveBeenCalledWith(
			'..',
			'historic/history/stops/2e2e/index.json',
			undefined,
		);
	});

	it('follows versioned directory and awkward entity pointers without fixed-path fallback', async () => {
		const directoryPath = versionedFamilyPath('lines');
		const entityPath = versionedEntityPath('lines', '412f42');
		const rootPort = vi
			.spyOn(adapter.historic, 'historyIndex')
			.mockResolvedValueOnce(availabilityRoot([rootFamily('lines', GENERATION, directoryPath)]))
			.mockResolvedValue(
				availabilityRoot([
					rootFamily('lines', NEXT_GENERATION, versionedFamilyPath('lines', NEW_POINTER_SHA)),
				]),
			);
		const directory = entityDirectory('lines', GENERATION, 'A/B', GENERATION, entityPath);
		const directoryPort = vi
			.spyOn(adapter.historic, 'lineHistoryDirectory')
			.mockResolvedValue(directory);
		const index = collectionIndex('lines', GENERATION, 'A/B');
		const childPort = vi.spyOn(adapter.historic, 'lineHistoryIndex').mockResolvedValue(index);

		await expect(getLineHistoryIndex('A/B')).resolves.toBe(index);
		expect(rootPort).toHaveBeenCalledOnce();
		expect(directoryPort).toHaveBeenCalledWith(directoryPath, undefined);
		expect(childPort).toHaveBeenCalledWith('A/B', entityPath, undefined);
	});

	it('keeps missing versioned directory and entity children strict without legacy fallback', async () => {
		const directoryPath = versionedFamilyPath('lines');
		const entityPath = versionedEntityPath('lines', '412f42');
		vi.spyOn(adapter.historic, 'historyIndex').mockResolvedValue(
			availabilityRoot([rootFamily('lines', GENERATION, directoryPath)]),
		);
		const directoryPort = vi.spyOn(adapter.historic, 'lineHistoryDirectory');
		directoryPort.mockResolvedValueOnce(null);

		await expect(getLineHistoryDirectory()).rejects.toMatchObject({
			name: 'HistoryArtifactContractError',
			path: directoryPath,
		});
		expect(directoryPort).toHaveBeenCalledOnce();
		expect(directoryPort).toHaveBeenCalledWith(directoryPath, undefined);

		directoryPort.mockResolvedValueOnce(
			entityDirectory('lines', GENERATION, 'A/B', GENERATION, entityPath),
		);
		const childPort = vi.spyOn(adapter.historic, 'lineHistoryIndex').mockResolvedValueOnce(null);

		await expect(getLineHistoryIndex('A/B')).rejects.toMatchObject({
			name: 'HistoryArtifactContractError',
			path: entityPath,
		});
		expect(childPort).toHaveBeenCalledOnce();
		expect(childPort).toHaveBeenCalledWith('A/B', entityPath, undefined);
	});
});

describe('retained network partition loading', () => {
	it('loads awkward Line and Stop entities through isolated exact-byte validators', async () => {
		const lineId = 'A/B';
		const stopId = '..';
		const line = await entityArtifact('lines', lineId, '2026-01', '2026-01-31');
		const stop = await entityArtifact('stops', stopId, '2026-01', '2026-01-31');
		const coverage = [
			{
				metric: 'delay',
				aggregation: 'additive',
				first_available_date: '2026-01-31',
				last_available_date: '2026-01-31',
			},
		];
		const linePort = vi.spyOn(adapter.historic, 'lineHistoryPartition').mockResolvedValue(line);
		const stopPort = vi.spyOn(adapter.historic, 'stopHistoryPartition').mockResolvedValue(stop);

		await expect(
			loadLineHistoryRange(
				lineId,
				collectionIndex('lines', GENERATION, lineId, [line.ref], coverage),
				{ from: '2026-01-31', to: '2026-01-31' },
			),
		).resolves.toEqual([line.value]);
		await expect(
			loadStopHistoryRange(
				stopId,
				collectionIndex('stops', GENERATION, stopId, [stop.ref], coverage),
				{ from: '2026-01-31', to: '2026-01-31' },
			),
		).resolves.toEqual([stop.value]);
		expect(linePort).toHaveBeenCalledWith(lineId, line.ref.path, expect.any(Object));
		expect(stopPort).toHaveBeenCalledWith(stopId, stop.ref.path, expect.any(Object));
	});

	it('fails Line/Stop loads on cross-family, cross-entity, month, or byte-size drift', async () => {
		const lineId = 'A/B';
		const line = await entityArtifact('lines', lineId, '2026-01', '2026-01-31');
		const coverage = [
			{
				metric: 'delay',
				aggregation: 'additive',
				first_available_date: '2026-01-31',
				last_available_date: '2026-01-31',
			},
		];
		const linePort = vi.spyOn(adapter.historic, 'lineHistoryPartition');

		await expect(
			loadLineHistoryRange(
				lineId,
				collectionIndex('stops', GENERATION, lineId, [line.ref], coverage),
				{ from: '2026-01-31', to: '2026-01-31' },
			),
		).rejects.toBeInstanceOf(HistoryArtifactContractError);
		expect(linePort).not.toHaveBeenCalled();

		linePort.mockResolvedValueOnce({
			...line,
			value: { ...line.value, entity_id: 'other' },
		});
		await expect(
			loadLineHistoryRange(
				lineId,
				collectionIndex('lines', GENERATION, lineId, [line.ref], coverage),
				{ from: '2026-01-31', to: '2026-01-31' },
			),
		).rejects.toBeInstanceOf(HistoryArtifactContractError);

		linePort.mockResolvedValueOnce({
			...line,
			value: { ...line.value, month: '2026-02' },
		});
		await expect(
			loadLineHistoryRange(
				lineId,
				collectionIndex('lines', GENERATION, lineId, [line.ref], coverage),
				{ from: '2026-01-31', to: '2026-01-31' },
			),
		).rejects.toBeInstanceOf(HistoryArtifactContractError);

		linePort.mockResolvedValueOnce(line);
		await expect(
			loadLineHistoryRange(
				lineId,
				collectionIndex(
					'lines',
					GENERATION,
					lineId,
					[{ ...line.ref, byte_size: line.ref.byte_size + 1 }],
					coverage,
				),
				{ from: '2026-01-31', to: '2026-01-31' },
			),
		).rejects.toBeInstanceOf(HistoryArtifactContractError);
	});
});
