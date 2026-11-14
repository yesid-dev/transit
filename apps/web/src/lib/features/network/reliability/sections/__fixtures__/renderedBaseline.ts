import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, vi } from 'vitest';

const sha = '38abc538a64063a4494d6a809a887d431706806a';
const tree = '436a6caefff8e2171107a9c4a1d61e54e41995e9';
const normalization = 'svelte-client-cN-scope-v2';
const inventory = [
	'network-live-headline',
	'network-reporting',
	'network-status-mix',
	'network-occupancy-mix',
	'network-delay-histogram',
	'network-daily-trend',
	'network-cancellations',
	'network-service-completeness',
	'network-crowding-by-day',
	'network-by-time-of-day',
	'network-weekday-weekend',
];
const snapshot = join(
	process.cwd(),
	'src/lib/features/network/reliability/sections/__fixtures__/network-render-baseline.jsonl',
);
const generatedToken = () => /\bc[1-9]\d*\b/g;
// Svelte cssHash emits svelte-${(hash >>> 0).toString(36)}: canonical unsigned base36.
const scopeToken = () => /(?<![\w-])svelte-(?:0|[1-9a-z][0-9a-z]{0,6})(?![\w-])/g;
const readRecords = () =>
	readFileSync(snapshot, 'utf8')
		.trim()
		.split('\n')
		.map((line) => JSON.parse(line));
const fingerprint = (html: string | null) =>
	html === null
		? null
		: { bytes: Buffer.byteLength(html), sha256: createHash('sha256').update(html).digest('hex') };

// Svelte props_id() emits c${window.__svelte.uid++}; suffixes remain byte-identical.
export function canonicalizeRenderedTokens(
	html: string,
	ids = new Map<string, string>(),
	scopes = new Map<string, string>(),
): string {
	return html.replace(
		new RegExp(`${scopeToken().source}|${generatedToken().source}`, 'g'),
		(token) => {
			const isScope = token.startsWith('svelte-');
			const names = isScope ? scopes : ids;
			if (!names.has(token)) names.set(token, `${isScope ? 'scope' : 'id'}${names.size + 1}`);
			return names.get(token)!;
		},
	);
}

export function captureEnvironment(width = 1280): void {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-06-16T02:00:20Z'));
	localStorage.clear();
	sessionStorage.clear();
	const host = window as unknown as {
		happyDOM: { setWindowSize(size: { width: number; height: number }): void };
	};
	host.happyDOM.setWindowSize({ width, height: 900 });
	expect(window.matchMedia('(min-width: 1024px)').matches).toBe(width >= 1024);
}

export function baselineInventory(prefix: string, keys: string[]): void {
	if (process.env.NETWORK_RENDER_MODE === 'capture') return;
	const records = readRecords();
	expect(
		records
			.filter((entry) => entry.key.startsWith(prefix))
			.map((entry) => entry.key)
			.sort(),
	).toEqual([...keys].sort());
}

export function unreachableBaseline(key: string): void {
	const record = {
		sha,
		tree,
		key,
		normalization,
		reachable: false,
		sections: null,
		reason: 'Retained mean delay present implies OTP present',
		sources: ['data/retainedTrend.ts:30,42-46', 'v1/history/families.ts:422,799-801'],
		observed: { meanDelayMin: [1, 1], onTimePct: [20, 90] },
	};
	if (process.env.NETWORK_RENDER_MODE === 'capture') {
		const directory = process.env.NETWORK_RENDER_ARTIFACTS;
		if (!directory) throw new Error('NETWORK_RENDER_ARTIFACTS is required');
		mkdirSync(directory, { recursive: true });
		writeFileSync(join(directory, `${key}.json`), JSON.stringify(record), { flag: 'wx' });
	} else {
		const records = readRecords();
		expect(records.filter((entry) => entry.key === key)).toEqual([record]);
	}
}

export function renderedBaseline(key: string, container: HTMLElement): void {
	const raw = container.outerHTML;
	const attributes = new Set([
		'id',
		'for',
		'aria-controls',
		'aria-labelledby',
		'aria-describedby',
		'href',
		'popovertarget',
	]);
	let attributeTokens = 0;
	let classTokens = 0;
	for (const element of [container, ...container.querySelectorAll('*')]) {
		for (const attribute of element.attributes) {
			const scopes = attribute.value.match(scopeToken()) ?? [];
			if (scopes.length) expect(attribute.name, 'scope token outside class').toBe('class');
			classTokens += scopes.length;
			const matches = attribute.value.replace(scopeToken(), '').match(generatedToken()) ?? [];
			if (matches.length) expect(attributes.has(attribute.name), attribute.name).toBe(true);
			attributeTokens += matches.length;
		}
	}
	// Any matching token in copy, CSS, data, SVG or another attribute fails closed.
	expect(raw.replace(scopeToken(), '').match(generatedToken())?.length ?? 0).toBe(attributeTokens);
	expect(raw.match(scopeToken())?.length ?? 0, 'scope token outside class').toBe(classTokens);
	expect(raw).not.toMatch(/\b(?:id|scope)[1-9]\d*\b/);
	const names = new Map<string, string>();
	const scopes = new Map<string, string>();
	const capture: Record<string, string | null> = {
		surface: canonicalizeRenderedTokens(raw, names, scopes),
	};
	const rawCapture: Record<string, string | null> = { surface: raw };
	for (const name of inventory) capture[name] = rawCapture[name] = null;
	for (const tile of container.querySelectorAll<HTMLElement>('[data-network-section]')) {
		const name = tile.dataset.networkSection!;
		expect(inventory, `unexpected tile ${name}`).toContain(name);
		expect(capture[name], `duplicate tile ${name}`).toBeNull();
		rawCapture[name] = tile.outerHTML;
		capture[name] = canonicalizeRenderedTokens(tile.outerHTML, names, scopes);
	}
	const record = {
		sha,
		tree,
		normalization,
		key,
		sections: Object.fromEntries(
			Object.entries(capture).map(([name, html]) => [name, fingerprint(html)]),
		),
	};
	const directory = process.env.NETWORK_RENDER_ARTIFACTS;
	const mode = process.env.NETWORK_RENDER_MODE;
	if (mode === 'capture' || mode === 'compare') {
		if (!directory) throw new Error('NETWORK_RENDER_ARTIFACTS is required');
		mkdirSync(directory, { recursive: true });
		for (const [name, html] of Object.entries(capture)) {
			const path = join(directory, `${key}.${name}.html`);
			writeFileSync(
				`${path}.${mode === 'capture' ? 'raw' : 'actual.raw'}`,
				rawCapture[name] ?? '<!-- absent -->',
				{ flag: 'wx' },
			);
			if (mode === 'capture') writeFileSync(path, html ?? '<!-- absent -->', { flag: 'wx' });
			else {
				writeFileSync(`${path}.actual`, html ?? '<!-- absent -->', { flag: 'wx' });
				expect(html ?? '<!-- absent -->', `${key}/${name}`).toBe(readFileSync(path, 'utf8'));
			}
		}
		if (mode === 'capture') {
			writeFileSync(join(directory, `${key}.json`), JSON.stringify(record), { flag: 'wx' });
			return;
		}
	}
	const records = readRecords();
	expect(
		records.filter((entry) => entry.key === key),
		`baseline case ${key}`,
	).toEqual([record]);
}
