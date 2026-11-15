import { publishedOrder } from '#lib/v1/ranking/published.ts';
import type {
	ReliabilityLoader,
	ReliabilitySnapshot,
	ReliabilityTarget,
} from '#lib/v1/reliabilitySnapshot.svelte.ts';

export function isReliabilitySnapshotPending(snapshot: ReliabilitySnapshot): boolean {
	return snapshot.phase === 'idle' || snapshot.phase === 'loading';
}

interface ReliabilityListingOptions<T> {
	readonly loader: ReliabilityLoader;
	readonly candidates: () => readonly T[];
	readonly id: (candidate: T) => string;
	readonly target?: (candidate: T) => ReliabilityTarget;
	readonly requestWhen: () => boolean;
	readonly rankWhen: () => boolean;
	readonly published?: () => readonly string[] | null;
}

export interface ReliabilityListingController<T> {
	readonly coveragePending: boolean;
	order(items: readonly T[]): readonly T[];
}

export function createReliabilityListingController<T>(
	options: ReliabilityListingOptions<T>,
): ReliabilityListingController<T> {
	const candidates = $derived.by(() => options.candidates());
	const requestEnabled = $derived(options.requestWhen());
	const rankingEnabled = $derived(options.rankWhen());
	const hasPending = $derived.by(() =>
		candidates.some((candidate) =>
			isReliabilitySnapshotPending(options.loader.get(options.id(candidate))),
		),
	);

	$effect(() => {
		if (!requestEnabled) return;
		for (const candidate of candidates) {
			options.loader.request(options.target?.(candidate) ?? options.id(candidate));
		}
	});

	return {
		get coveragePending() {
			return requestEnabled && hasPending;
		},
		order(items) {
			const order = options.published?.();
			if (!rankingEnabled || !order) return items;
			return publishedOrder(items, options.id, order);
		},
	};
}
