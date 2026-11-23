import type { StatusDotColor } from '@yesid/ui/brand';
import { freshnessAgeSeconds } from '#lib/v1/freshness.ts';
import type { DataHealth, Provenance, ProvenanceFreshness } from '#lib/v1/schemas/index.ts';

// A lamp for the feed, not a vehicle status: the kit's proceed and stop signals.
export type FreshnessAspect = Extract<StatusDotColor, 'green' | 'stop' | 'unknown'>;

export interface StatusVerdictLabels {
	readonly ok: string;
	readonly running: string;
	readonly failed: string;
	readonly unknown: string;
}

export interface FreshnessVerdict {
	readonly aspect: FreshnessAspect;
	readonly label: string;
}

export function verdictFor(
	status: string | null | undefined,
	labels: StatusVerdictLabels,
): FreshnessVerdict {
	switch (status) {
		case 'succeeded':
		case 'live':
			return { aspect: 'green', label: labels.ok };
		case 'failed':
		case 'refresh_unavailable':
			return { aspect: 'stop', label: labels.failed };
		case 'running':
		case 'pending':
			return { aspect: 'unknown', label: labels.running };
		default:
			return { aspect: 'unknown', label: labels.unknown };
	}
}

export function freshnessOf(p: Provenance) {
	return p.freshness ?? [];
}

/**
 * The feed list: data health's feeds, republished every live cycle, else the daily record's. Those
 * statuses are as of its publication, and their ages, frozen then, are counted on to now.
 */
export function feedFreshness(
	dataHealth: DataHealth | null,
	provenance: Provenance | null,
	nowMs: number,
): { readonly items: readonly ProvenanceFreshness[]; readonly atPublication: boolean } {
	if (dataHealth?.feeds?.length) return { items: dataHealth.feeds, atPublication: false };
	const since = freshnessAgeSeconds(provenance?.generated_utc, nowMs);
	const items = (provenance?.freshness ?? []).map((f) => ({
		...f,
		age_s: f.age_s == null || since == null ? null : f.age_s + since,
	}));
	return { items, atPublication: items.length > 0 };
}

export function sourcesOf(p: Provenance) {
	return p.sources ?? [];
}
export function gapsOf(p: Provenance) {
	return p.gaps ?? [];
}

export type PipelineNoteKind = 'definition' | 'math' | 'caveat' | 'pipeline-note';

export interface PipelineNote {
	readonly key: string;
	readonly label: string;
	readonly text: string;
	readonly kind: PipelineNoteKind;
}

export function pipelineNotesOf(
	p: Provenance,
	threadedKeys: Readonly<Record<string, unknown>>,
	labels: Readonly<Record<string, string>>,
	kinds: Readonly<Record<string, PipelineNoteKind>> = {},
): PipelineNote[] {
	const methodology = p.methodology;
	if (!methodology) return [];
	return Object.entries(methodology)
		.filter(([key, value]) => !(key in threadedKeys) && typeof value === 'string')
		.map(([key, value]) => ({
			key,
			label: labels[key] ?? key.replace(/_/g, ' '),
			text: (value as string).trim(),
			kind: kinds[key] ?? 'pipeline-note',
		}))
		.filter((n) => n.text.length > 0);
}

export function retentionOf(p: Provenance): { detail: number | null; aggregate: number | null } {
	const r = p.retention ?? {};
	const detail = typeof r.detail_days === 'number' ? r.detail_days : null;
	const aggregate = typeof r.aggregate_days === 'number' ? r.aggregate_days : null;
	return { detail, aggregate };
}
