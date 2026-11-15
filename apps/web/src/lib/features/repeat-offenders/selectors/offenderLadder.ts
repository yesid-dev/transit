import { resolveOffenderName } from '../offenderNames';
import type { LineDirectory } from '#lib/site/lineDirectory.ts';
import type { Locale } from '#lib/i18n/index.ts';
import {
	encodeSevereLadder,
	type SevereLadderLabels,
	type SevereLadderEvidence as OffenderPopoverEvidence,
	type SevereLadderResult as OffenderLadderResult,
} from '#lib/reliability/severeLadder.ts';
import type { RepeatOffenderEntry } from '#lib/v1/schemas/index.ts';

export type { OffenderPopoverEvidence, OffenderLadderResult };

export interface OffenderLadderLabels extends SevereLadderLabels<RepeatOffenderEntry> {
	readonly directory?: LineDirectory;
	unnamed: (e: RepeatOffenderEntry) => string;
}

export function selectOffenderLadder(
	entries: readonly RepeatOffenderEntry[],
	cap: number,
	locale: Locale,
	labels: OffenderLadderLabels,
): OffenderLadderResult {
	const directory = labels.directory;
	const result = encodeSevereLadder(entries, cap, locale, labels, {
		key: (entry) => `${entry.type}-${entry.id}-${entry.route ?? ''}`,
		label: (entry) => resolveOffenderName(entry, directory, labels.unnamed).label,
	});
	if (directory && result.spec.kind === 'magnitude-bars') {
		result.spec = {
			...result.spec,
			rows: result.spec.rows.map((row, i) => ({
				...row,
				spoken: resolveOffenderName(entries[i], directory, labels.unnamed).spoken,
			})),
		};
	}
	return result;
}
