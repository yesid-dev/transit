import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import dividerAllowlist from './record-divider-allowlist.json';
import { pageDrawnDividers } from './record-divider-gate';
import {
	brandHexViolations,
	datavizViolations,
	styleRegressionViolations,
	tvOnlyInUiViolations,
	walk,
} from '@yesid/gates';
import {
	TRANSIT_AFFORDANCE_TOKENS,
	TRANSIT_ALLOW_MARKERS,
	TRANSIT_BRAND_HEXES,
	TRANSIT_FORBIDDEN,
	TRANSIT_STYLE_EXEMPTIONS,
	TRANSIT_STYLE_ROOTS,
} from './design-gates';

// Keep temporary exceptions counted so a removed class cannot give a new use a free pass.
const recordLayoutAllowlist: Record<string, Record<string, { count: number; owner: string }>> = {
	'lib/features/record/RecordActionGroup.svelte': {
		'gap-6': { count: 1, owner: 'Cite sheet body, outside the card-spacing rule' },
	},
};

export function recordLayoutViolations(path: string, source: string): string[] {
	const allowed = recordLayoutAllowlist[path] ?? {};
	const counts: Record<string, number> = {};
	const failures: string[] = [];
	const departures = /(?<![\w-])(?:(?:gap(?:-y)?|space-y)-6(?![\w-])|nameWidth(?=\s*=))/g;
	for (const [index, line] of source.split(/\r?\n/).entries()) {
		for (const [token] of line.matchAll(departures)) {
			counts[token] = (counts[token] ?? 0) + 1;
			if (counts[token] > (allowed[token]?.count ?? 0)) {
				const fix =
					token === 'nameWidth'
						? 'Let RecordDataTable size its name column'
						: 'Use gap-(--space-card-gap) between cards';
				failures.push(`${fix} in ${path}:${index + 1} (${token})`);
			}
		}
	}
	for (const [token, { count, owner }] of Object.entries(allowed)) {
		if ((counts[token] ?? 0) < count)
			failures.push(`Shrink record layout allowlist for ${path} (${token}, ${owner})`);
	}
	return failures;
}

function lintDesign() {
	const src = fileURLToPath(new URL('../src', import.meta.url));
	const failures: string[] = [];

	const pendingDividers = new Map<string, Record<string, number>>(Object.entries(dividerAllowlist));
	const pendingRecordLayouts = new Set(Object.keys(recordLayoutAllowlist));
	for (const directory of ['lib/features', 'lib/components', 'routes']) {
		for (const file of walk(join(src, directory), ['.svelte', '.css'])) {
			const path = relative(src, file).split(sep).join('/');
			const source = readFileSync(file, 'utf8');
			if (directory === 'lib/features') {
				failures.push(...recordLayoutViolations(path, source));
				pendingRecordLayouts.delete(path);
			}
			const allowed = pendingDividers.get(path) ?? {};
			const counts: Record<string, number> = {};
			for (const { line, token } of pageDrawnDividers(source)) {
				counts[token] = (counts[token] ?? 0) + 1;
				if (counts[token] > (allowed[token] ?? 0)) {
					failures.push(`Use a kit divider in ${path}:${line} (${token})`);
				}
			}
			for (const [token, count] of Object.entries(allowed)) {
				if ((counts[token] ?? 0) < count)
					failures.push(`Shrink divider allowlist for ${path} (${token})`);
			}
			pendingDividers.delete(path);
		}
	}
	for (const path of pendingDividers.keys()) failures.push(`Stale divider allowlist for ${path}`);
	for (const path of pendingRecordLayouts)
		failures.push(`Stale record layout allowlist for ${path}`);

	const brand = brandHexViolations({ root: src, hexes: TRANSIT_BRAND_HEXES });
	if (brand.fileCount === 0) failures.push(`No source files scanned: ${src}`);
	for (const violation of brand.violations) failures.push(`Raw brand hex: ${violation}`);

	const doctrine = {
		affordanceTokens: TRANSIT_AFFORDANCE_TOKENS,
		allowMarkers: TRANSIT_ALLOW_MARKERS,
		markerWindow: 8,
	};
	const datavizFiles = walk(join(src, 'lib/components/dataviz'), ['.svelte', '.ts']);
	if (datavizFiles.length === 0) failures.push('No dataviz files scanned.');
	for (const file of datavizFiles) {
		for (const hit of datavizViolations(readFileSync(file, 'utf8'), doctrine)) {
			failures.push(`Affordance token as a data mark in ${relative(src, file)}: ${hit}`);
		}
	}

	const tv = tvOnlyInUiViolations({ root: src, uiRoots: [join(src, 'lib/components/ui')] });
	if (tv.fileCount === 0) failures.push('No files scanned for tv() imports.');
	for (const violation of tv.violations) failures.push(`tv() outside ui/: ${violation}`);

	for (const exemption of TRANSIT_STYLE_EXEMPTIONS.proseMeasure) {
		if (
			!TRANSIT_STYLE_ROOTS.some((root) => exemption.startsWith(root)) ||
			!existsSync(join(src, '..', exemption))
		)
			failures.push(`Stale prose-measure exemption: ${exemption}`);
	}

	for (const { pattern, reason, hits } of styleRegressionViolations({
		root: src,
		extensions: ['.svelte', '.css'],
		forbidden: TRANSIT_FORBIDDEN,
	})) {
		const found = hits
			.map((hit) => hit.split(sep).join('/'))
			.filter((hit) => TRANSIT_STYLE_ROOTS.some((root) => hit.startsWith(root)))
			.filter((hit) => !TRANSIT_STYLE_EXEMPTIONS.everyPattern.some((part) => hit.includes(part)))
			.filter(
				(hit) =>
					pattern !== TRANSIT_STYLE_EXEMPTIONS.measurePattern ||
					!TRANSIT_STYLE_EXEMPTIONS.proseMeasure.some((path) => hit.startsWith(path)),
			);
		if (found.length > 0) failures.push(`${reason}: ${found.join(', ')}`);
	}

	if (failures.length > 0) {
		console.error(failures.join('\n'));
		process.exit(1);
	}
}

if (import.meta.main) lintDesign();
