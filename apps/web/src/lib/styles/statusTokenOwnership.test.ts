import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
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

it('lists no transport-status owner that has stopped using the colours', () => {
	const stale = [...TRANSPORT_STATUS_FILES].filter(
		(file) => !STATUS_TOKEN.test(readFileSync(join(src, file), 'utf8')),
	);
	expect(stale).toEqual([]);
});
