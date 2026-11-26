import runnerCases from './__fixtures__/b9/runner-cases.json' with { type: 'json' };
import { spawn } from 'node:child_process';
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { lineEngine } from '../e2e/line-engine.mjs';
import { networkServiceFixture } from '../e2e/network-engine.mjs';
import { overviewEngine } from '../e2e/overview-engine.mjs';
import { stopEngine } from '../e2e/stop-engine.mjs';
import { b9LiveFixture } from './b9-live-fixture.mjs';
import { verifyInstalledBrowserArtifact } from './browser-toolchain.mjs';
import { FIXTURES, normalizeObservation, runOracleSelfCheck } from './b9-display-oracle.mjs';

const args = new Set(process.argv.slice(2));
const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUTPUT = fileURLToPath(new URL('../.svelte-kit/output/server/index.js', import.meta.url));
const BUILD_ROOT = join(WEB_ROOT, '.svelte-kit/cloudflare');
const WRANGLER = join(WEB_ROOT, '../../node_modules/wrangler/bin/wrangler.js');
const EXPECTED_WRANGLER = JSON.parse(readFileSync(join(WEB_ROOT, '../../package.json'), 'utf8'))
	.devDependencies?.wrangler;
const REPLAY_PREFIX = '/v1/stm/';
const CELLS = Object.freeze(runnerCases.cells);

function recordFixture(url, fixtureName) {
	const match = /^\/v2\/stm\/(measure|ranking)$/.exec(url.pathname);
	if (!match) return null;
	const line = url.searchParams.get('line') === '24';
	const stop = url.searchParams.get('stop') === 'S1';
	const query = new URL(url);
	query.pathname = '/' + match[1];
	query.searchParams.set('city', 'stm');
	if (!line && !stop)
		return (
			(match[1] === 'measure' ? networkServiceFixture(query) : null) ??
			(match[1] === 'measure' &&
			query.searchParams.get('measure') === 'on_time' &&
			[null, 'day'].includes(query.searchParams.get('group'))
				? overviewEngine(query)
				: null)
		);
	const answer = (line ? lineEngine : stopEngine)(query);
	if (fixtureName === 'sparse' && query.searchParams.get('measure') === 'punctuality') {
		answer.body.state = 'not_measured';
		answer.body.state_text = { en: 'Not measured', fr: 'Non mesuré' };
		answer.body.value = { early: null, on_time: null, late: null };
		answer.body.evidence.counts = { classified: null };
		answer.body.evidence.days_measured = [];
		answer.body.evidence.days_not_measured = answer.body.evidence.days_included;
	}
	return answer;
}

function invariant(condition, message) {
	if (!condition) throw new Error(`B9 runner invariant: ${message}`);
}

function transcriptDifference(left, right) {
	const fields = ['cell', 'actual', 'ssr', 'hydrated', 'ledger'];
	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		const first = left[index];
		const second = right[index];
		if (!first || !second) return `cell ${index}: one run omitted the cell`;
		for (const field of fields) {
			const firstValue = JSON.stringify(first[field]);
			const secondValue = JSON.stringify(second[field]);
			if (firstValue !== secondValue) {
				return `${first.cell} ${field}\nrun 1: ${firstValue}\nrun 2: ${secondValue}`;
			}
		}
	}
	return 'no differing field found';
}

const parseNumber = (value) => {
	if (value == null) return null;
	const match = String(value)
		.replaceAll('\u2212', '-')
		.replace(/(?<=\d)[ ,\u00a0\u202f](?=\d{3}\b)/gu, '')
		.replace(',', '.')
		.match(/[+-]?\d+(?:\.\d+)?/u);
	return match ? Number(match[0]) : null;
};

/** The readings behind the line record's answer, from its evidence sentence. */
function lineVerdictObservationCount(text) {
	const count = text.match(
		/\b(?:Based on|Selon)\s+(\d+(?:[ ,\u00a0\u202f]\d{3})*)\s+(?:readings?|relevés?)\./u,
	)?.[1];
	return parseNumber(count);
}

function stopVerdictObservationCount(text) {
	const observedN =
		text.match(/\bn=(\d+)/u)?.[1] ??
		text.match(
			/\b(?:of|de|contains|contient)\s+(\d+)\s+(?:known predictions|prévisions connues)/iu,
		)?.[1] ??
		text.match(
			/\b(?:only|seulement)\s+(\d+)\s+(?:eligible known predictions|prévisions connues admissibles)/iu,
		)?.[1];
	return parseNumber(observedN);
}

function ssrText(html) {
	return normalizeObservation(
		(html.match(/<main\b[^>]*>[\s\S]*?<\/main>/iu)?.[0] ?? html)
			.replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/giu, ' ')
			.replace(/<!--[\s\S]*?-->/gu, ' ')
			.replace(/<[^>]+>/gu, ' ')
			.replaceAll('&nbsp;', ' ')
			.replaceAll('&amp;', '&'),
	);
}

async function verifyAccessibility(page, cell) {
	invariant((await page.locator('main').isVisible()) === true, `${cell.path} main is not visible`);
	invariant(
		(await page.locator('html').getAttribute('lang')) === cell.locale,
		`${cell.path} wrong document language`,
	);
	const unlabeled = await page
		.locator('figure[data-slot$="-mark"], figure[data-slot="service-span-timeline"]')
		.evaluateAll(
			(figures) =>
				figures.filter((figure) => !(figure.getAttribute('aria-label') ?? '').trim()).length,
		);
	invariant(unlabeled === 0, `${cell.path} has ${unlabeled} unlabeled chart figures`);
	const emptyCaptions = await page
		.locator('figure[data-slot] table.sr-only')
		.evaluateAll(
			(tables) =>
				tables.filter((table) => !(table.querySelector('caption')?.textContent ?? '').trim())
					.length,
		);
	invariant(
		emptyCaptions === 0,
		`${cell.path} has ${emptyCaptions} charts without accessible text`,
	);
}

function jsonHeaders(fixture) {
	return {
		'Access-Control-Expose-Headers': 'Date, Age',
		'Access-Control-Allow-Origin': '*',
		'Cache-Control': 'no-store',
		'Content-Type': 'application/json; charset=utf-8',
		Date: new Date(fixture.frozen_utc).toUTCString(),
		Age: '0',
	};
}

function replayPath({ pathname, search }) {
	if (pathname.startsWith('/v2/')) return pathname + search;
	return pathname.startsWith(REPLAY_PREFIX)
		? decodeURIComponent(pathname.slice(REPLAY_PREFIX.length))
		: null;
}

async function startReplay(fixtures = FIXTURES, initialKey = Object.keys(fixtures)[0]) {
	const state = { active: initialKey, ledger: [], outbound: [] };
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? '/', 'http://127.0.0.1');
		const relative = replayPath(url);
		const fixture = fixtures[state.active];
		const record = recordFixture(url, state.active);
		const found =
			record?.body ??
			(relative === '/v2/stm/live'
				? b9LiveFixture(fixture).snapshot
				: relative == null
					? null
					: fixture.files[relative]);
		const declaredMissing = relative != null && fixture.not_found.includes(relative);
		const status = record?.status ?? (found ? 200 : declaredMissing ? 404 : 599);
		state.ledger.push({
			lane: 'ssr',
			method: request.method,
			path: relative ?? url.pathname,
			status,
		});
		response.writeHead(status === 599 ? 404 : status, {
			...jsonHeaders(fixture),
			...record?.headers,
		});
		response.end(
			JSON.stringify(found ?? { error: declaredMissing ? 'not found' : 'unknown fixture path' }),
		);
	});
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	const address = server.address();
	invariant(address && typeof address === 'object', 'replay did not bind');
	return {
		base: `http://127.0.0.1:${address.port}/v1`,
		origin: `http://127.0.0.1:${address.port}`,
		fixtures,
		state,
		close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
	};
}

function runChild(command, commandArgs, options) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, commandArgs, {
			cwd: options.cwd,
			env: options.env ?? process.env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let output = '';
		child.stdout.on('data', (chunk) => (output += chunk));
		child.stderr.on('data', (chunk) => (output += chunk));
		child.once('error', reject);
		child.once('exit', (code) => {
			if (code === 0) resolve(output);
			else reject(new Error(`B9 ${options.label} exited ${code}\n${output}`));
		});
	});
}

async function ensureBuild() {
	if (process.env.B9_REUSE_BUILD === '1') {
		invariant(existsSync(OUTPUT), 'B9_REUSE_BUILD=1 without built output');
		return false;
	}
	await runChild('bun', ['run', 'build'], { cwd: WEB_ROOT, label: 'build' });
	invariant(existsSync(OUTPUT), 'build completed without server output');
	return true;
}

function verifyProductionFixtureIsolation() {
	for (const path of readdirSync(BUILD_ROOT, { recursive: true })) {
		if (!/\.(?:js|mjs|cjs|map)$/.test(path)) continue;
		const body = readFileSync(join(BUILD_ROOT, path));
		for (const control of ['x-transit-fixture-scope', 'CAPTURE_FIXTURE_CLOCK'])
			invariant(!body.includes(control), `${control} reached the production asset ${path}`);
	}
}

async function startPreview(replay) {
	const version = await runChild('node', [WRANGLER, '--version'], {
		cwd: WEB_ROOT,
		label: 'wrangler version',
	});
	invariant(
		typeof EXPECTED_WRANGLER === 'string' && version.trim() === EXPECTED_WRANGLER,
		`unexpected wrangler version ${version.trim()}`,
	);
	const stateDir = mkdtempSync(join(tmpdir(), 'transit-b9-preview-'));
	const configPath = join(stateDir, 'wrangler.json');
	let devEnv;
	let timeout;
	let onStartupError;
	try {
		writeFileSync(
			configPath,
			JSON.stringify({
				name: 'transit-b9-preview',
				main: join(BUILD_ROOT, '_worker.js'),
				assets: { directory: BUILD_ROOT, binding: 'ASSETS' },
				compatibility_date: '2025-01-01',
				compatibility_flags: ['nodejs_compat'],
				vars: {
					PUBLIC_V1_PROVIDER: 'stm',
					QUESTION_FIXTURE_ORIGIN: replay.origin,
				},
			}),
		);
		const { unstable_DevEnv } = await import('wrangler');
		devEnv = new unstable_DevEnv();
		const startupFailure = new Promise((_, reject) => {
			onStartupError = (event) =>
				reject(
					event instanceof Error
						? event
						: new Error(`B9 preview startup failed: ${event.reason}`, { cause: event.cause }),
				);
			devEnv.on('error', onStartupError);
			devEnv.on('buildFailed', onStartupError);
			timeout = setTimeout(() => reject(new Error('B9 preview startup timed out')), 30_000);
		});
		const startup = async () => {
			const worker = await devEnv.startWorker({
				config: configPath,
				dev: {
					remote: false,
					server: { hostname: '127.0.0.1', port: 0 },
					inspector: false,
					persist: false,
					watch: false,
					registry: undefined,
					enableContainers: false,
					logLevel: 'error',
				},
			});
			const origin = (await worker.url).origin;
			const response = await fetch(new URL('/privacy', origin), { redirect: 'manual' });
			await response.arrayBuffer();
			invariant(response.ok, `B9 preview readiness returned ${response.status}`);
			return origin;
		};
		return { devEnv, origin: await Promise.race([startup(), startupFailure]), stateDir };
	} catch (error) {
		try {
			await stopPreview({ devEnv, stateDir });
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], 'B9 preview startup and cleanup failed', {
				cause: cleanupError,
			});
		}
		throw error;
	} finally {
		clearTimeout(timeout);
		if (onStartupError) {
			devEnv.off('error', onStartupError);
			devEnv.off('buildFailed', onStartupError);
		}
	}
}

async function stopPreview(preview) {
	await preview.devEnv?.teardown();
	rmSync(preview.stateDir, { recursive: true, force: true });
}

function freezeClockScript(iso) {
	return `(() => {
		const NativeDate = Date;
		const frozen = NativeDate.parse(${JSON.stringify(iso)});
		class FrozenDate extends NativeDate {
			constructor(...values) { super(...(values.length ? values : [frozen])); }
			static now() { return frozen; }
		}
		FrozenDate.parse = NativeDate.parse;
		FrozenDate.UTC = NativeDate.UTC;
		Object.defineProperty(window, 'Date', { value: FrozenDate });
	})();`;
}

function svgGuardScript() {
	return `(() => {
		const attrs = ${JSON.stringify(['x', 'y', 'width', 'height', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'transform', 'points'])};
		const bad = /(?:NaN|Infinity)/;
		window.__b9SvgViolations = [];
		const setAttribute = Element.prototype.setAttribute;
		Element.prototype.setAttribute = function(name, value) {
			if (this.namespaceURI === 'http://www.w3.org/2000/svg' && attrs.includes(name) && bad.test(String(value)))
				window.__b9SvgViolations.push({ phase: window.__b9Phase, attr: name, value: String(value), root: this.closest('figure')?.getAttribute('data-slot'), html: this.outerHTML.slice(0, 500), stack: new Error().stack });
			return setAttribute.call(this, name, value);
		};
		const check = (node) => {
			if (!(node instanceof Element) || node.namespaceURI !== 'http://www.w3.org/2000/svg') return;
			for (const attr of attrs) if (bad.test(node.getAttribute(attr) ?? ''))
				window.__b9SvgViolations.push({ attr, value: node.getAttribute(attr), html: node.outerHTML.slice(0, 500) });
		};
		new MutationObserver((records) => records.forEach((record) => {
			check(record.target); record.addedNodes.forEach((node) => { check(node); node.querySelectorAll?.('svg *').forEach(check); });
		})).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: attrs });
	})();`;
}

function builtAssetPaths() {
	return new Set(
		readdirSync(BUILD_ROOT, { recursive: true })
			.map(String)
			.filter((path) => statSync(join(BUILD_ROOT, path)).isFile())
			.map((path) => `/${path.split(sep).join('/')}`),
	);
}

async function installNetworkBoundary(context, pageOrigin, replay, documentPaths) {
	const assets = builtAssetPaths();
	const documents = new Set(documentPaths.map((path) => new URL(path, pageOrigin).href));
	await context.route('**/*', async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		if (!['http:', 'https:'].includes(url.protocol)) {
			await route.continue();
			return;
		}
		if (url.origin === pageOrigin) {
			const exactDocument = request.isNavigationRequest() && documents.has(url.href);
			if (exactDocument || assets.has(decodeURIComponent(url.pathname))) {
				await route.continue();
				return;
			}
			if (
				request.method() === 'GET' &&
				url.pathname === '/api/live' &&
				url.search === '?city=stm'
			) {
				const fixture = replay.fixtures[replay.state.active];
				replay.state.ledger.push({
					lane: 'browser',
					method: 'GET',
					path: '/v2/stm/live',
					status: 200,
				});
				await route.fulfill({
					headers: jsonHeaders(fixture),
					json: b9LiveFixture(fixture).snapshot,
				});
				return;
			}
			replay.state.outbound.push(`same-origin:${request.method()}:${url.pathname}${url.search}`);
			await route.abort('blockedbyclient');
			return;
		}
		const relative = url.origin === replay.origin ? replayPath(url) : null;
		if (relative !== null) {
			const fixture = replay.fixtures[replay.state.active];
			const found = fixture.files[relative];
			const declaredMissing = fixture.not_found.includes(relative);
			const status = found ? 200 : declaredMissing ? 404 : 599;
			replay.state.ledger.push({
				lane: 'browser',
				method: request.method(),
				path: relative,
				status,
			});
			await route.fulfill({
				status: status === 599 ? 404 : status,
				headers: jsonHeaders(fixture),
				body: JSON.stringify(
					found ?? { error: declaredMissing ? 'not found' : 'unknown fixture path' },
				),
			});
			return;
		}
		replay.state.outbound.push(request.url());
		await route.abort('blockedbyclient');
	});
}

async function readBandRows(bands) {
	return bands.locator('dt').evaluateAll((terms) =>
		terms.map((term) => {
			const status = term.querySelector('[data-slot="status-mark"]');
			return {
				label: status?.querySelector('.status-word')?.textContent.trim(),
				count: status?.querySelector('.status-detail')?.textContent,
				share: term.nextElementSibling?.textContent,
			};
		}),
	);
}

async function verifyNetwork(page, cell, fixture, replay, errors, html) {
	const label = `${cell.fixture}/${cell.locale}/${cell.surface}`;
	const main = page.locator('main');
	const answer = main.locator('[data-slot="screen-answer"] [data-slot="answer-lead"]');
	const value = answer.locator('.answer-value');
	await value.waitFor();
	const isLive = cell.surface === 'network-live';
	const actual = [parseNumber(await value.innerText())];
	const expectedPaths = ['/v2/cities', '/v2/stm/schedule-index'];
	if (isLive) {
		const expected = b9LiveFixture(fixture).expectation;
		const title = cell.locale === 'fr' ? 'Véhicules par état' : 'Vehicles by status';
		const status = main.getByRole('article', { name: title, exact: true });
		const counts = (await status.locator('dd').allTextContents()).map(parseNumber);
		actual.push(...counts);
		invariant(
			JSON.stringify(actual) ===
				JSON.stringify([
					expected.vehicles_in_service,
					...['early', 'on_time', 'late', 'unknown'].map((key) => expected.status_dist?.[key] ?? 0),
				]),
			`${label} capture headcount or status values drifted: ${JSON.stringify(actual)}`,
		);
		const silentTitle = cell.locale === 'fr' ? 'Trajets sans signalement' : 'Silent trips';
		const silent = main.getByRole('article', { name: silentTitle, exact: true });
		await silent.locator('[data-record-state="not_measured"]').waitFor();
		expectedPaths.push('/v2/stm/live');
	} else {
		const bands = main.locator('#network-bands');
		await bands.locator('dt').first().waitFor();
		const displayedRows = await readBandRows(bands);
		const shares = displayedRows.map(({ share }) => parseNumber(share));
		const counts = displayedRows.map(({ count }) => parseNumber(count));
		const delivery = main.locator('#delivery table tbody tr');
		await delivery.first().waitFor();
		const deliveryValues = (await delivery.first().locator('td').allTextContents()).map(
			parseNumber,
		);
		actual.push(shares, counts, deliveryValues);
		invariant(
			JSON.stringify(actual) ===
				JSON.stringify([80.7, [5.6, 80.7, 13.7], [3120, 44966, 7634], [15861, 15476, 125, 260]]),
			`${label} Record answer, bands, counts or delivery values drifted: ${JSON.stringify(actual)}`,
		);
		const trend = main.locator('#network-trend [data-slot="chart-frame"]');
		await trend.locator('svg polyline').waitFor();
		invariant(Boolean(await trend.getAttribute('aria-label')), `${label} unlabeled trend`);
		const toggle = main.locator('button[aria-controls="network-trend"]');
		await toggle.click();
		const rows = main.locator('#network-trend table tbody tr');
		await rows.first().waitFor();
		const trendValues = (await rows.locator('td').allTextContents()).map(parseNumber);
		actual.push(trendValues);
		invariant(
			JSON.stringify(trendValues) === JSON.stringify([80.7, 83.1]),
			`${label} trend table diverged: ${JSON.stringify(trendValues)}`,
		);
		await toggle.click();
		await trend.locator('svg polyline').waitFor();
		const hours = main.locator('#network-hours [data-slot="hour-grid"] table');
		await hours.locator('tbody tr').first().waitFor();
		invariant((await hours.locator('tbody tr').count()) === 7, `${label} weekday rows missing`);
		invariant(
			(await hours.locator('tbody td[aria-label]').count()) > 0,
			`${label} hour values missing accessible labels`,
		);
		const { searchParams } = new URL(cell.path, 'http://b9.local');
		for (const query of [
			{ measure: 'punctuality' },
			{ measure: 'delay_distribution' },
			{ measure: 'on_time', group: 'day_type' },
			{ measure: 'on_time', group: 'day' },
			{ measure: 'service_delivered' },
			{ measure: 'service_delivered', group: 'day' },
			{ measure: 'late', group: 'weekday_hour' },
			{ measure: 'crowding' },
		]) {
			const params = new URLSearchParams({
				from: searchParams.get('recordFrom'),
				to: searchParams.get('recordTo'),
				...query,
			});
			params.sort();
			expectedPaths.push(`/v2/stm/measure?${params}`);
		}
	}
	await verifyAccessibility(page, cell);
	await page.setViewportSize({ width: 320, height: 900 });
	invariant(
		await main.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
		`${label} exceeds the narrow viewport`,
	);
	const data = replay.state.ledger;
	const normalizePath = (path) => {
		const url = new URL(path.startsWith('/') ? path : `/legacy/${path}`, 'http://b9.local');
		url.searchParams.sort();
		return url.pathname + url.search;
	};
	invariant(
		data.every((entry) => entry.lane === 'ssr' && entry.status === 200) &&
			JSON.stringify(data.map(({ path }) => normalizePath(path)).sort()) ===
				JSON.stringify(expectedPaths.sort()),
		`${label} made incomplete or unexpected requests: ${JSON.stringify(data)}`,
	);
	invariant(replay.state.outbound.length === 0, `${label} outbound: ${replay.state.outbound}`);
	invariant(errors.length === 0, `${label} browser errors: ${errors.join(' | ')}`);
	const svgViolations = await page.evaluate(() => window.__b9SvgViolations ?? []);
	invariant(
		svgViolations.length === 0,
		`${label} non-finite SVG geometry: ${JSON.stringify(svgViolations[0])}`,
	);
	return {
		cell: label,
		actual,
		ssr: ssrText(html),
		hydrated: normalizeObservation(await main.innerText()),
		ledger: data.map(({ lane, path, status }) => `${lane}|${normalizePath(path)}|${status}`).sort(),
	};
}

async function displayedRecordNumbers(locator, expected, label) {
	await locator.first().waitFor();
	const readings = (await locator.allInnerTexts()).map((text) =>
		Array.from(text.matchAll(/\d+(?:[ ,\u00a0\u202f]\d{3}\b)*(?:[.,]\d+)?/gu), ([number]) =>
			parseNumber(number),
		),
	);
	invariant(
		JSON.stringify(readings) === JSON.stringify(expected),
		`${label} expected ${JSON.stringify(expected)}, read ${JSON.stringify(readings)}`,
	);
	return readings;
}

async function verifyLineReadings(page, cell, onTime, label) {
	const fr = cell.locale === 'fr';
	const network = 81.2;
	const late = 90 - onTime;
	const readings = [];
	const check = async (selector, values) => {
		const actual = await displayedRecordNumbers(
			page.locator(selector),
			values,
			`${label} ${selector}`,
		);
		readings.push({ selector, actual });
	};
	const about = page.getByRole('article', {
		name: fr ? 'À propos de ces chiffres' : 'About these figures',
		exact: true,
	});
	// Coverage is displayed once, alongside the denominator that used to appear in every band.
	const coverage = about.getByText(fr ? /^50\s*% des 200 /u : /^50% of 200 /u);
	const actual = await displayedRecordNumbers(
		coverage,
		[[50, 200, 50, 50]],
		`${label} coverage and timing basis`,
	);
	readings.push({ selector: 'observed coverage', actual });
	await check('#punctuality .answer-value', [[onTime]]);
	await check('#punctuality .answer-meta > p:first-child', [[100, 1]]);
	await check('#punctuality .answer-meta > p:nth-child(2)', [[1, 7]]);
	await check('#punctuality .answer-context > p', [[onTime === 40 ? 41.2 : 1.2, network]]);
	await check('#directions dd', [
		[80, 100],
		[80, 100],
	]);

	const daily = page.locator('#daily footer button');
	await daily.click();
	await check('#daily tbody td', [[onTime], [network], [], [network]]);
	await daily.click();

	const measuredHour = page.locator('#line-hour-chart td[aria-label]').first();
	await measuredHour.waitFor();
	const hour = await measuredHour.getAttribute('aria-label');
	invariant(
		JSON.stringify(hour?.match(/\d+/gu)?.map(Number)) === JSON.stringify([7, late, 100]),
		`${label} hourly late share or stop count drifted: ${hour}`,
	);
	readings.push({ selector: 'hourly accessible reading', actual: hour });
	await check('#line-hour-chart td[aria-label]:first-of-type [data-level]', [[late]]);

	const stops = page.locator('#stops footer button');
	await stops.click();
	await check('#stops tbody td', [[0.6], [5.6]]);
	await stops.click();
	await check('#delivery tbody td', [[2], [6], [32], [40]]);
	await check('#late tbody td', [[late, 100]]);
	await check('#waiting dl dd:first-of-type', [[0.8], [8.3], [25]]);
	await check('#offered tbody td', [
		[8, 8, 1],
		[0, 1],
	]);
	await check('#crowding tbody td', [
		[25, 30],
		[75, 90],
	]);
	await check('#boundaries dd', [[5, 44], [1, 15], [16]]);
	await check('#frequency tbody td', [[7, 0, 9, 0], [7.5]]);
	await check('#alerts dd', [[3], [4]]);
	return readings;
}

async function verifyEngineRecord(page, cell, replay, errors, html) {
	const label = `${cell.fixture}/${cell.locale}/${cell.surface}`;
	const isLine = cell.surface === 'line';
	const section = page.locator('#punctuality');
	const bands = page.locator(isLine ? '#line-bands-chart dl' : '#stop-bands-chart dl');
	const missing = cell.fixture === 'sparse';
	let lineReadings = [];
	const verifyExport = (csv, section = 'punctuality') => {
		invariant(csv != null, `${label} missing CSV link`);
		const exportUrl = new URL(csv, page.url());
		invariant(
			exportUrl.searchParams.get('section') === section &&
				exportUrl.searchParams.get('recordFrom') === '2026-11-08' &&
				exportUrl.searchParams.get('recordTo') === '2026-11-14',
			`${label} CSV lost the displayed measure or dates: ${exportUrl}`,
		);
	};
	if (missing) {
		await section.getByText('Not measured', { exact: true }).waitFor();
		invariant((await bands.count()) === 0, `${label} gave an unmeasured record numeric bands`);
		invariant(
			!/\b0\s*%/u.test(await section.innerText()),
			`${label} replaced missing data with zero`,
		);
	} else {
		await bands.waitFor();
		const early = isLine ? 10 : 5;
		const onTime = new URL(page.url()).searchParams.get('direction') === '1' ? 40 : 80;
		const counts = [early, onTime, 100 - early - onTime];
		const displayedRows = await readBandRows(bands);
		const displayedLabels = displayedRows.map(({ label }) => label);
		const expectedLabels =
			cell.locale === 'fr' ? ['En avance', 'À l’heure', 'En retard'] : ['Early', 'On time', 'Late'];
		invariant(
			JSON.stringify(displayedLabels) === JSON.stringify(expectedLabels),
			`${label} mislabeled or reordered the punctuality bands: ${displayedLabels}`,
		);
		const readings = displayedRows.map(({ share, count }) => [
			parseNumber(share),
			parseNumber(count),
		]);
		const expectedReadings = isLine
			? counts.map((count) => [count, count])
			: [
					[5, 414],
					[80, 6628],
					[15, 1243],
				];
		invariant(
			JSON.stringify(readings) === JSON.stringify(expectedReadings),
			`${label} punctuality shares or denominators drifted: ${JSON.stringify(readings)}`,
		);
		if (isLine) {
			lineReadings = await verifyLineReadings(page, cell, onTime, label);
		} else {
			await page.locator('#daily footer button').click();
			await page.locator('#daily table tbody tr').first().waitFor();
			await page.locator('#daily footer button').click();
		}
	}
	await section.getByRole('button', { name: /^(Download|Télécharger)$/u }).click();
	const sheet = page.getByRole('dialog');
	const dailyExport = sheet.locator('a[href*="section=daily"]');
	await dailyExport.waitFor();
	verifyExport(await dailyExport.getAttribute('href'), 'daily');
	verifyExport(await sheet.locator('a[href*="section=punctuality"]').getAttribute('href'));
	await page.keyboard.press('Escape');
	await sheet.waitFor({ state: 'hidden' });
	await verifyAccessibility(page, cell);
	const data = replay.state.ledger;
	invariant(errors.length === 0, `${label} browser errors: ${errors.join(' | ')}`);
	invariant(replay.state.outbound.length === 0, `${label} outbound: ${replay.state.outbound}`);
	invariant(
		data.every(
			(entry) => entry.lane === 'ssr' && entry.status === 200 && entry.path.startsWith('/v2/'),
		),
		`${label} touched a snapshot or made an unknown request: ${JSON.stringify(data)}`,
	);
	const queries = data.filter(({ path }) => /\/(measure|ranking)\?/u.test(path));
	const direction = new URL(cell.path, 'http://b9.local').searchParams.get('direction');
	const expectedQueries = isLine
		? [
				{ measure: 'punctuality' },
				{ measure: 'on_time', group: 'day' },
				{ measure: 'late', group: 'weekday_hour' },
				{ measure: 'punctuality', group: 'direction' },
				{ measure: 'punctuality', group: 'stop' },
				{ measure: 'waiting_and_gaps' },
				{ measure: 'scheduled_frequency', group: 'hour' },
				{ measure: 'trips_run', group: 'departure' },
				{ measure: 'late', kind: 'departure', limit: '8' },
				{ measure: 'crowding' },
				{ measure: 'alert_counts', alert_details: '1' },
				{ measure: 'scheduled_frequency' },
				{ measure: 'service_delivered', group: 'day_type' },
				{ measure: 'on_time', network: true },
				{ measure: 'on_time', group: 'day', network: true },
			]
		: [
				{ measure: 'punctuality' },
				{ measure: 'on_time', group: 'line' },
				{ measure: 'waiting_and_gaps', group: 'line' },
				{ measure: 'on_time', group: 'hour' },
				{ measure: 'on_time', group: 'day' },
				{ measure: 'accessible_stops' },
				{ measure: 'alert_counts' },
				{ measure: 'late', group: 'weekday_hour' },
				{ measure: 'on_time', network: true },
				{ measure: 'on_time', group: 'day', network: true },
			];
	const expectedPaths = expectedQueries.map(({ network, ...query }) => {
		const params = new URLSearchParams({
			from: '2026-11-08',
			to: '2026-11-14',
			...(network ? {} : isLine ? { line: '24' } : { stop: 'S1' }),
			...query,
		});
		if (
			isLine &&
			!network &&
			direction &&
			query.group !== 'direction' &&
			query.measure !== 'alert_counts'
		)
			params.set('direction', direction);
		params.sort();
		return `/v2/stm/${query.kind ? 'ranking' : 'measure'}?${params}`;
	});
	const actualPaths = queries.map(({ path }) => {
		const url = new URL(path, 'http://b9.local');
		url.searchParams.sort();
		return url.pathname + url.search;
	});
	invariant(
		JSON.stringify(actualPaths.sort()) === JSON.stringify(expectedPaths.sort()),
		`${label} made incomplete or incorrectly scoped engine reads\nexpected: ${JSON.stringify(expectedPaths)}\nactual: ${JSON.stringify(actualPaths)}`,
	);
	const hydrated = normalizeObservation(await section.innerText());
	await page.setViewportSize({ width: 320, height: 900 });
	invariant(
		await page
			.locator('main')
			.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
		`${label} exceeds the narrow Record viewport`,
	);
	return {
		cell: label,
		actual: missing
			? ['not_measured']
			: [...(await bands.locator('dd').allTextContents()), ...lineReadings],
		ssr: ssrText(html),
		hydrated,
		ledger: data.map(({ lane, path, status }) => `${lane}|${path}|${status}`).sort(),
	};
}

async function runGate({ fixtures = FIXTURES, cells = CELLS, runs = 2, synthetic = true } = {}) {
	const selfCheck = runRunnerSelfCheck();
	const built = await ensureBuild();
	verifyProductionFixtureIsolation();
	const replay = await startReplay(fixtures, cells[0]?.fixture);
	const transcripts = [];
	let observationCount = 0;
	let requestCount = 0;
	let preview;
	let browser;
	try {
		const browserArtifact = await verifyInstalledBrowserArtifact();
		browser = await chromium.launch({
			headless: true,
			executablePath: browserArtifact.paths.executablePath,
		});
		invariant(
			browser.version() === browserArtifact.browser.version,
			'launched Chromium version mismatch',
		);
		for (let run = 0; run < runs; run += 1) {
			preview = await startPreview(replay);
			const transcript = [];
			for (const cell of cells) {
				replay.state.active = cell.fixture;
				replay.state.ledger = [];
				replay.state.outbound = [];
				const fixture = fixtures[cell.fixture];
				const context = await browser.newContext({
					bypassCSP: true,
					locale: cell.locale === 'fr' ? 'fr-CA' : 'en-CA',
					serviceWorkers: 'block',
					viewport: { width: 1440, height: 1000 },
				});
				await context.addInitScript({
					content: freezeClockScript(
						cell.surface === 'network-live' ? fixture.frozen_utc : '2026-11-22T12:00:00Z',
					),
				});
				await context.addInitScript({ content: svgGuardScript() });
				await installNetworkBoundary(context, preview.origin, replay, [cell.path]);
				const page = await context.newPage();
				const errors = [];
				page.on('response', (response) => {
					if (response.status() >= 500)
						void response.text().then(
							(body) =>
								errors.push(`${response.status()} ${response.url()}: ${body.slice(0, 2_000)}`),
							(error) => errors.push(`${response.status()} ${response.url()}: ${error}`),
						);
				});
				page.on('pageerror', (error) => errors.push(String(error)));
				page.on('console', (message) => {
					if (message.type() === 'error')
						errors.push(`${message.text()} @ ${JSON.stringify(message.location())}`);
				});
				const response = await page.goto(`${preview.origin}${cell.path}`, {
					waitUntil: 'domcontentloaded',
					timeout: 15_000,
				});
				invariant(response?.ok(), `${cell.path} returned ${response?.status()}`);
				const ssrHtml = await response.text();
				let record;
				try {
					record = cell.surface.startsWith('network-')
						? await verifyNetwork(page, cell, fixture, replay, errors, ssrHtml)
						: await verifyEngineRecord(page, cell, replay, errors, ssrHtml);
				} catch (error) {
					throw new Error(
						`run ${run + 1} ${cell.fixture}/${cell.locale}/${cell.surface}: ${String(error)}\nreplay ledger ${JSON.stringify(replay.state.ledger)}`,
						{ cause: error },
					);
				}
				transcript.push(record);
				observationCount += record.actual.length;
				requestCount += replay.state.ledger.length;
				await context.close();
			}
			transcripts.push(transcript);
			await stopPreview(preview);
			preview = undefined;
		}
		if (synthetic) {
			const identical = JSON.stringify(transcripts[0]) === JSON.stringify(transcripts[1]);
			invariant(
				identical,
				`two normalized synthetic runs were not identical\n${transcriptDifference(transcripts[0], transcripts[1])}`,
			);
		}
		return {
			built,
			cells: cells.length,
			runs,
			observations: observationCount,
			requests: requestCount,
			...selfCheck,
		};
	} finally {
		await browser?.close();
		if (preview) await stopPreview(preview);
		await replay.close();
	}
}

function runRunnerSelfCheck() {
	for (const [text, expected] of runnerCases.line) {
		invariant(
			lineVerdictObservationCount(text) === expected,
			`line verdict observation count: ${text}`,
		);
	}
	for (const [text, expected] of runnerCases.stop) {
		invariant(
			stopVerdictObservationCount(text) === expected,
			`stop verdict observation count: ${text}`,
		);
	}
	// Preserve the existing fixture-mode report shape after retiring live readiness.
	return { ...runOracleSelfCheck(), representativeDate: '2026-09-02' };
}

const result = args.has('--self-check') ? runRunnerSelfCheck() : await runGate();
console.log(`B9 displayed-value gate PASS ${JSON.stringify(result)}`);
