import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parse } from 'svelte/compiler';
import { expect, it } from 'vitest';

// The on-time, late and severe status colours mean a vehicle's punctuality and nothing else.
// Interface feedback (success, warning, error) takes the kit's --success, --accent-text and
// --destructive, so a change to the status palette never repaints a notice or a verdict.
const STATUS_TOKEN = /--dataviz-status-(?:on-time|late|severe)\b/;

const TRANSPORT_STATUS_FILES = new Set([
	'app.css',
	// The severe-share bullet is a data mark; the dataviz doctrine keeps affordance tokens off it.
	'lib/components/dataviz/chart/marks/BulletMark.svelte',
	'lib/components/dataviz/chart/marks/HistogramMark.svelte',
	'lib/components/dataviz/chart/marks/LineMark.svelte',
	'lib/components/dataviz/chart/marks/ServiceSpanMark.svelte',
	'lib/components/dataviz/chart/marks/SparklineMark.svelte',
	'lib/components/dataviz/chart/marks/TrendMark.svelte',
	'lib/features/lines/reliability/sections/Section1WhenToRide.svelte',
	'lib/features/map/MapDelayTag.svelte',
	'lib/features/network/reliability/selectors/trendChart.ts',
]);

const src = resolve('src');

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === '__fixtures__' ? [] : sources(path);
		if (/\.test\.ts$|\.spec\.ts$/.test(entry.name)) return [];
		return /\.(svelte|ts|css)$/.test(entry.name) ? [path] : [];
	});
}

it('keeps the on-time, late and severe colours to transport status', () => {
	const owners = sources(src)
		.filter((file) => STATUS_TOKEN.test(readFileSync(file, 'utf8')))
		.map((file) => relative(src, file).split('\\').join('/'));

	expect(owners.length).toBeGreaterThan(0);
	expect(owners.filter((file) => !TRANSPORT_STATUS_FILES.has(file))).toEqual([]);
});

// StatusDot's early, on_time, late and severe colours are the same status tokens, so the rule
// holds for its colour values too. Interface lamps take green, caution, stop, lunar or unknown.
const TRANSPORT_DOT_COLORS = new Set(['early', 'on_time', 'late', 'severe']);
// No dot shows a vehicle's punctuality today; one that does is named here.
const TRANSPORT_STATUS_DOTS = new Set<string>();
// A dot whose colour comes from elsewhere names the module that computes it.
const DOT_COLOR_SOURCES: Record<string, string> = {
	'lib/features/health/sections/SectionFreshness.svelte':
		'lib/features/health/selectors/provenanceViews.ts',
	'lib/features/health/sections/SectionLanes.svelte': 'lib/features/health/selectors/laneHealth.ts',
};

const quotedWords = (text: string) => [...text.matchAll(/['"]([a-z_]+)['"]/g)].map((m) => m[1]!);

function dotColorAttributes(source: string): string[] {
	const found: string[] = [];
	function visit(node: unknown): void {
		if (!node || typeof node !== 'object') return;
		const n = node as {
			type?: string;
			name?: string;
			attributes?: { type: string; name: string; start: number; end: number }[];
		};
		if (n.type === 'Component' && n.name === 'StatusDot') {
			const color = n.attributes?.find((a) => a.type === 'Attribute' && a.name === 'color');
			found.push(color ? source.slice(color.start, color.end) : 'color="orange"');
		}
		for (const value of Object.values(node))
			if (Array.isArray(value)) value.forEach(visit);
			else if (value && typeof value === 'object') visit(value);
	}
	visit(parse(source, { modern: true }));
	return found;
}

it('keeps the transport status colours off interface status dots', () => {
	const violations: string[] = [];
	let dots = 0;
	for (const file of sources(src).filter((path) => path.endsWith('.svelte'))) {
		const name = relative(src, file).split('\\').join('/');
		if (TRANSPORT_STATUS_DOTS.has(name)) continue;
		for (const attribute of dotColorAttributes(readFileSync(file, 'utf8'))) {
			dots += 1;
			const words = quotedWords(attribute);
			const origin = words.length > 0 ? null : DOT_COLOR_SOURCES[name];
			if (words.length === 0 && !origin) violations.push(`${name}: unclassified ${attribute}`);
			const checked = origin ? quotedWords(readFileSync(join(src, origin), 'utf8')) : words;
			for (const word of checked)
				if (TRANSPORT_DOT_COLORS.has(word)) violations.push(`${origin ?? name}: '${word}'`);
		}
	}
	expect(dots).toBeGreaterThan(0);
	expect([...new Set(violations)]).toEqual([]);
});

it('lists no transport-status owner that has stopped using the colours', () => {
	const stale = [...TRANSPORT_STATUS_FILES].filter(
		(file) => !STATUS_TOKEN.test(readFileSync(join(src, file), 'utf8')),
	);
	expect(stale).toEqual([]);
});
