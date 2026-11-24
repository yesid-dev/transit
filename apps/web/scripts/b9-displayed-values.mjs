import { trendClosedThrough } from '../src/lib/v1/closedWindow.ts';
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
import { stopEngine } from '../e2e/stop-engine.mjs';
import { b9LiveFixture } from './b9-live-fixture.mjs';
import { verifyInstalledBrowserArtifact } from './browser-toolchain.mjs';
import {
	FIXTURES,
	OBSERVATION_IDS,
	compareObservations,
	expectedDomainObservationsFromFixture,
	expectedScheduleTruth,
	expectedStopLatestDay,
	normalizeObservation,
	runOracleSelfCheck,
} from './b9-display-oracle.mjs';

const args = new Set(process.argv.slice(2));
const WEB_ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUTPUT = fileURLToPath(new URL('../.svelte-kit/output/server/index.js', import.meta.url));
const BUILD_ROOT = join(WEB_ROOT, '.svelte-kit/cloudflare');
const WRANGLER = join(WEB_ROOT, '../../node_modules/wrangler/bin/wrangler.js');
const EXPECTED_WRANGLER = JSON.parse(readFileSync(join(WEB_ROOT, '../../package.json'), 'utf8'))
	.devDependencies?.wrangler;
const REPLAY_PREFIX = '/v1/stm/';
const CELLS = Object.freeze(runnerCases.cells);
const NETWORK_MARKS = ['histogram', 'sparkline', 'stacked-share', 'trend'];

function recordFixture(url, fixtureName) {
	const match = /^\/v2\/stm\/(measure|ranking)$/.exec(url.pathname);
	if (!match) return null;
	const line = url.searchParams.get('line') === '24';
	const stop = url.searchParams.get('stop') === 'S1';
	if (!line && !stop) return null;
	const query = new URL(url);
	query.pathname = '/' + match[1];
	query.searchParams.set('city', 'stm');
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

const observation = (id, value) => ({ id, value });
const parseNumber = (value) => {
	if (value == null) return null;
	const match = String(value)
		.replaceAll('\u2212', '-')
		.replace(/(?<=\d)[ ,\u00a0\u202f](?=\d{3}\b)/gu, '')
		.replace(',', '.')
		.match(/[+-]?\d+(?:\.\d+)?/u);
	return match ? Number(match[0]) : null;
};

async function readValues(
	page,
	selector,
	valueSelector,
	absenceSelector = '[data-slot="absent-value"]',
) {
	return page
		.locator(selector)
		.evaluateAll(
			(elements, options) =>
				elements.map((element) =>
					element.querySelector(options.absenceSelector)
						? null
						: (element.querySelector(options.valueSelector)?.textContent?.trim() ?? null),
				),
			{ valueSelector, absenceSelector },
		);
}

const labelMap = (value) =>
	Object.fromEntries(
		value.split('|').map((entry) => {
			const [label, key] = entry.split('=');
			return [label, /^\d$/u.test(key) ? Number(key) : key];
		}),
	);
const SEMANTIC_LABELS = Object.freeze({
	en: labelMap(
		'Morning peak=am_peak|Afternoon peak=pm_peak|Weekdays=weekday|Weekends=weekend|AM peak=am_peak|Midday=midday|PM peak=pm_peak|Evening=evening|Night=night|AM=am_peak|Mid=midday|PM=pm_peak|Eve=evening|Weekday=weekday|Weekend=weekend|Monday=1|Tuesday=2|Wednesday=3|Thursday=4|Friday=5|Saturday=6|Sunday=7|Mon=1|Tue=2|Wed=3|Thu=4|Fri=5|Sat=6|Sun=7|Empty=empty|Many seats=many_seats|Few seats=few_seats|Standing=standing|Full=full|Early=early|On-time=on_time|Late=late|Severe=severe|Unknown=unknown',
	),
	fr: labelMap(
		'Pointe du matin=am_peak|Mi-journée=midday|Pointe de l’après-midi=pm_peak|Jours de semaine=weekday|Fins de semaine=weekend|Pointe AM=am_peak|Journée=midday|Pointe PM=pm_peak|Soirée=evening|Nuit=night|AM=am_peak|Jour=midday|PM=pm_peak|Soir=evening|Semaine=weekday|Fin de semaine=weekend|Lundi=1|Mardi=2|Mercredi=3|Jeudi=4|Vendredi=5|Samedi=6|Dimanche=7|Lun=1|Mar=2|Mer=3|Jeu=4|Ven=5|Sam=6|Dim=7|Vide=empty|Plusieurs places=many_seats|Peu de places=few_seats|Debout=standing|Plein=full|En avance=early|À l’heure=on_time|En retard=late|Sévère=severe|Inconnu=unknown',
	),
});

async function readTable(page, root, table = 'table.sr-only') {
	return page
		.locator(`${root} ${table} tbody tr`)
		.evaluateAll((rows) =>
			rows.map((row) =>
				[...row.querySelectorAll('th,td')].map((cell) => cell.textContent?.trim() ?? ''),
			),
		);
}

async function readHeaders(page, root, table = 'table.sr-only') {
	return page
		.locator(`${root} ${table} thead th`)
		.evaluateAll((items) => items.map((item) => item.textContent?.trim() ?? ''));
}

const displayCell = (text) => ({ value: parseNumber(text), text: normalizeObservation(text) });

async function readSemanticTable(page, root, locale, table = 'table.sr-only') {
	const labels = SEMANTIC_LABELS[locale];
	return {
		headers: await readHeaders(page, root, table),
		rows: (await readTable(page, root, table)).map((row) => {
			const baseLabel = row[0].split(' · ')[0];
			return [labels[baseLabel] ?? row[0], ...row.slice(1).map(displayCell)];
		}),
	};
}

async function readRankedRows(page, root, locale) {
	const labels = SEMANTIC_LABELS[locale];
	const rows = await page.locator(`${root} .dv-ranked-row`).evaluateAll((elements) =>
		elements.map((element) => {
			const main = element.querySelector('.min-w-0');
			const heading = main?.firstElementChild;
			return {
				title: heading?.firstElementChild?.textContent?.trim() ?? '',
				display: heading?.children[1]?.textContent?.trim() ?? '',
				subtitle: main?.children[1]?.textContent?.trim() ?? '',
			};
		}),
	);
	return rows.map((row) => [
		labels[row.title] ?? row.title,
		{ value: parseNumber(row.display), text: normalizeObservation(row.display) },
		{
			values: [...row.subtitle.replaceAll('\u2212', '-').matchAll(/[+-]?\d+(?:[.,]\d+)?/gu)].map(
				(match) => Number(match[0].replace(',', '.')),
			),
			text: normalizeObservation(row.subtitle),
		},
	]);
}

const shareRows = (rows, locale) => ({
	headers: [],
	rows: rows.map((row) => [SEMANTIC_LABELS[locale][row[0]] ?? row[0], displayCell(row[1])]),
});

async function readShares(page, root, locale) {
	return shareRows(await readTable(page, root), locale);
}

async function readHistogram(page, root, multiplier = 1) {
	return {
		headers: await readHeaders(page, root),
		rows: (await readTable(page, root)).map((row) => {
			const values = [...row[0].replaceAll('\u2212', '-').matchAll(/-?\d+(?:[.,]\d+)?/gu)].map(
				(match) => Number(match[0].replace(',', '.')),
			);
			return {
				lo: row[0].includes('-∞') ? null : (values[0] ?? null) * multiplier,
				hi: row[0].includes('+∞') ? null : (values.at(-1) ?? null) * multiplier,
				count: parseNumber(row[1]),
				text: row.map(normalizeObservation),
			};
		}),
	};
}

async function readText(page, selector) {
	const value = await page
		.locator(selector)
		.allInnerTexts()
		.then((rows) => rows[0]);
	return value == null ? null : normalizeObservation(value);
}

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

async function collectNetwork(page, locale) {
	const headlineText = await readValues(
		page,
		'[data-network-section="network-live-headline"] [data-slot="metric-display"]',
		'.metric-value',
	);
	const headline = headlineText.map(parseNumber);
	const reportingText = await readValues(
		page,
		'[data-slot="reporting-section"] [data-slot="metric-display"]',
		'.metric-value',
	);
	const reporting = reportingText.map(parseNumber);
	const statusShares = await readShares(
		page,
		'[data-network-section="network-status-mix"]',
		locale,
	);
	const occupancyShares = await readShares(
		page,
		'[data-network-section="network-occupancy-mix"]',
		locale,
	);
	const histogram = await readHistogram(page, '[data-network-section="network-delay-histogram"]');
	const completenessText =
		(
			await readValues(
				page,
				'[data-slot="completeness-section"] [data-slot="metric-display"]',
				'.metric-value',
			)
		)[0] ?? null;
	const completeness = parseNumber(completenessText);
	const delta = parseNumber(
		await page
			.locator('[data-slot="verdict-delta"]')
			.allInnerTexts()
			.then((v) => v[0]),
	);
	const shiftRows = await readRankedRows(page, '[data-slot="network-shift"]', locale);
	const dayTypeRows = await readRankedRows(
		page,
		'[data-network-section="network-weekday-weekend"]',
		locale,
	);
	const silentRoutes = await page.locator('[data-slot="silent-link"]').evaluateAll((links) =>
		links.map((link) => ({
			route: decodeURIComponent(new URL(link.href).pathname.split('/').at(-1) ?? ''),
			href: new URL(link.href).pathname,
			display:
				link.querySelector('.dv-ranked-row .tabular-nums.text-foreground')?.textContent?.trim() ??
				'',
		})),
	);
	const trendRows = await readSemanticTable(
		page,
		'[data-slot="network-history-trend-row"] figure[data-slot="trend-mark"]',
		locale,
	);
	const vehicleRows = await readSemanticTable(page, '[data-slot="vehicles-reporting-row"]', locale);
	const cancellationRows = await readSemanticTable(
		page,
		'[data-slot="network-history-cancellations-row"]',
		locale,
	);
	const occupancyGroups = await page
		.locator('[data-slot="occupancy-trend"] li')
		.evaluateAll((items) =>
			items.map((item) =>
				[...item.querySelectorAll('table.sr-only tbody tr')].map((row) =>
					[...row.querySelectorAll('th,td')].map((cell) => cell.textContent?.trim() ?? ''),
				),
			),
		);
	const freshness = page.locator('[data-slot="freshness-stamp"][data-variant="live"]').first();
	const conformance = page.locator('[data-slot="conformance-badge"]').first();
	const networkMeta = {
		freshness: (await freshness.count())
			? {
					text: await readText(
						page,
						'[data-slot="freshness-stamp"][data-variant="live"] .freshness-stamp-age',
					),
					datetime: await freshness.locator('time').getAttribute('datetime'),
					seconds: parseNumber(await freshness.getAttribute('data-age-seconds')),
				}
			: null,
		conformance: (await conformance.count())
			? {
					verdict: await conformance.getAttribute('data-verdict'),
					label: await readText(page, '[data-slot="conformance-badge"] .conformance-badge-label'),
					detail: await readText(page, '[data-slot="conformance-badge"] .conformance-badge-detail'),
					title: await conformance.getAttribute('title'),
				}
			: null,
		scalars: {
			headline: headline.map((value, index) => ({
				value,
				text: normalizeObservation(headlineText[index] ?? ''),
				unit: index < 2 ? '%' : 'min',
			})),
			reporting: reporting.map((value, index) => ({
				value,
				text: normalizeObservation(reportingText[index] ?? ''),
				unit: 'count',
			})),
			completeness: {
				value: completeness,
				text: normalizeObservation(completenessText ?? ''),
				unit: '%',
			},
		},
	};
	const latestCancellation = await readText(
		page,
		'[data-network-section="network-cancellations"] [data-slot="metric-display"] .metric-value',
	);
	return [
		observation('network.live.vehicles', reporting[0] ?? null),
		observation('network.live.on_time_pct', headline[0] ?? null),
		observation('network.live.coverage_pct', headline[1] ?? null),
		observation('network.live.p50_min', headline[2] ?? null),
		observation('network.live.p90_min', headline[3] ?? null),
		observation('network.live.non_responding', reporting[1] ?? null),
		observation('network.live.status_shares', { table: statusShares, meta: networkMeta }),
		observation('network.live.occupancy_shares', occupancyShares),
		observation('network.live.histogram', histogram),
		observation(
			'network.live.silent_routes',
			silentRoutes.map((row) => [row.route, parseNumber(row.display), row.href]),
		),
		observation('network.verdict.delta_pct', delta),
		observation('network.latest.completeness_pct', completeness),
		observation('network.trend.rows', trendRows),
		observation('network.vehicles.rows', vehicleRows),
		observation('network.cancellations.rows', {
			table: cancellationRows,
			latest:
				latestCancellation == null ? { value: null, text: '' } : displayCell(latestCancellation),
		}),
		observation(
			'network.occupancy.rows',
			occupancyGroups.map((rows) => shareRows(rows, locale)),
		),
		observation('network.shift.rows', shiftRows),
		observation('network.daytype.rows', dayTypeRows),
	];
}

function verifyLedger(cell, fixture, ledger) {
	const labelPath = `labels/${cell.locale}.json`;
	const historyStatus = fixture.not_found.includes('historic/history/index.json') ? 404 : 200;
	const range = new URL(cell.path, 'http://b9.local');
	const selectedLine =
		cell.surface === 'line' && range.searchParams.has('from') && range.searchParams.has('to');
	const lineHistoryLane = selectedLine && historyStatus === 200 ? 'ssr' : 'browser';
	const expected = {
		line: [
			['ssr', 'manifest.json', 200, 1],
			['ssr', 'static/routes/24.json', 200, 1],
			['ssr', 'historic/route_reliability/24.json', 200, 1],
			['ssr', labelPath, 200, 1],
			[lineHistoryLane, 'historic/history/index.json', historyStatus, 1],
			['browser', 'provenance.json', 200, 1],
			['browser', 'live/vehicles.json', 200, 1],
			['browser', 'live/trips.json', 200, 1],
			['browser', 'live/alerts.json', 200, 1],
			['browser', 'live/network.json', 200, 1],
			['browser', 'status/data_health.json', 404, 1],
		],
		stop: [
			['ssr', 'manifest.json', 200, 1],
			['ssr', 'static/stops/52095.json', 200, 1],
			['ssr', labelPath, 200, 1],
			['browser', 'historic/history/index.json', historyStatus, 1],
			['browser', 'historic/stop_reliability/52095.json', 200, 1],
			[
				'browser',
				'historic/route_reliability/index.json',
				fixture.files['historic/route_reliability/index.json'] ? 200 : 404,
				1,
			],
			['browser', 'live/stop_departures.json', 200, 1],
			['browser', 'live/alerts.json', 200, 1],
			['browser', 'status/data_health.json', 404, 1],
		],
		network: [
			['ssr', '/v2/stm/live', 200, 1],
			['ssr', 'historic/network_trend.json', 200, 1],
			['ssr', 'historic/history/index.json', historyStatus, 1],
			['ssr', 'provenance.json', 200, 1],
			['browser', 'historic/history/index.json', historyStatus, 1],
			['browser', '/v2/stm/live', 200, 1],
		],
	}[cell.surface];
	expected.push(['ssr', '/v2/cities', 200, 1], ['ssr', '/v2/stm/schedule-index', 200, 1]);
	if (selectedLine && historyStatus === 404)
		expected.push(['ssr', 'historic/history/index.json', 404, 1]);
	const selectedRefs = (index) => {
		const from = range.searchParams.get('from');
		const to = range.searchParams.get('to');
		return from && to
			? (index?.partitions ?? []).filter(
					(ref) => ref.coverage_start <= to && ref.coverage_end >= from,
				)
			: [];
	};
	if (cell.surface === 'network' && historyStatus === 200) {
		const root = fixture.files['historic/history/index.json'];
		const networkPath = root.families?.find((family) => family.family === 'network')?.index_path;
		if (networkPath) expected.push(['browser', networkPath, 200, 1]);
		for (const ref of selectedRefs(fixture.files[networkPath]))
			expected.push(['browser', ref.path, 200, 1]);
	}
	if ((cell.surface === 'line' || cell.surface === 'stop') && historyStatus === 200) {
		const root = fixture.files['historic/history/index.json'];
		const family = cell.surface === 'line' ? 'lines' : 'stops';
		const directoryPath = root.families?.find((entry) => entry.family === family)?.index_path;
		if (directoryPath) {
			const lane = cell.surface === 'line' ? lineHistoryLane : 'browser';
			expected.push([lane, directoryPath, 200, 1]);
			const entityId = cell.surface === 'line' ? '24' : '52095';
			const entityPath = fixture.files[directoryPath]?.entities?.find(
				(entry) => entry.entity_id === entityId,
			)?.index_path;
			if (entityPath) {
				expected.push([lane, entityPath, 200, 1]);
				const refs = selectedRefs(fixture.files[entityPath]);
				if (cell.surface === 'line' && cell.fixture === 'rich' && refs.length === 0)
					refs.push(...(fixture.files[entityPath]?.partitions ?? []).slice(-1));
				for (const ref of refs) {
					if (lane === 'ssr') {
						expected.push(['ssr', ref.path, 200, 1]);
						expected.push(['browser', ref.path, 200, 1]);
					} else {
						expected.push(['browser', ref.path, 200, 1]);
					}
				}
			}
		}
	}
	const counts = new Map();
	for (const entry of ledger) {
		invariant(entry.method === 'GET', `${cell.path} unexpected ${entry.method} ${entry.path}`);
		const key = `${entry.lane}|${entry.path}|${entry.status}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const actual = [...counts].sort();
	const wanted = expected
		.map(([lane, path, status, count]) => [`${lane}|${path}|${status}`, count])
		.sort();
	invariant(
		JSON.stringify(actual) === JSON.stringify(wanted),
		`${cell.path} request ledger mismatch\nexpected ${JSON.stringify(wanted)}\nactual ${JSON.stringify(actual)}`,
	);
}

async function verifySsr(page, cell, fixture, html) {
	const mainHtml = html.match(/<main\b[^>]*>[\s\S]*?<\/main>/iu)?.[0] ?? '';
	invariant(mainHtml !== '', `${cell.path} SSR omitted main`);
	const normalized = ssrText(mainHtml);
	if (cell.surface === 'line') {
		const route = fixture.files['static/routes/24.json'];
		invariant(normalized.includes(route.long), `${cell.path} SSR omitted line identity`);
		const selected = new URL(cell.path, 'http://b9.local').searchParams.has('from');
		if (selected && fixture.not_found.includes('historic/history/index.json')) {
			invariant(
				!mainHtml.includes('data-section="verdict"'),
				`${cell.path} SSR rendered an unresolved retained range`,
			);
			return;
		}
		const ssr = await page.evaluate((source) => {
			const template = document.createElement('template');
			template.innerHTML = source;
			const main = template.content.querySelector('main');
			const figures = [...main.querySelectorAll('[data-slot="record-figure"]')];
			const delays = [
				...main.querySelectorAll(
					'[data-section="verdict"] [data-slot="record-delays"] [data-metric]',
				),
			].map((row) =>
				row.querySelector('[data-slot="absent-value"]')
					? null
					: (row.querySelector('dd')?.textContent?.trim() ?? null),
			);
			return {
				figureCount: figures.length,
				values: [figures[0]?.textContent?.trim() ?? null, ...delays],
				readings:
					main.querySelector('[data-section="verdict"] [data-slot="record-readings"]')
						?.textContent ?? '',
				bands: [...main.querySelectorAll('.reliability-band[data-band]')].map((band) =>
					band.getAttribute('data-band'),
				),
				window: main.querySelector('[data-slot="active-window"]')?.textContent ?? '',
				freshness:
					main
						.querySelector('[data-slot="article-header"] .header__meta time')
						?.getAttribute('datetime') ?? null,
				secondVerdict:
					main.querySelector(
						'.route-verdict-banner, [data-slot="verdict"], [data-slot="verdict-kpis"], [data-slot="header-verdict-current-only"]',
					) != null,
				importError: main.querySelector('[data-slot="reliability-import-error"]') != null,
			};
		}, html);
		invariant(
			JSON.stringify(ssr.bands) ===
				JSON.stringify([
					'verdict',
					'when-to-ride',
					'worst-stops',
					'run-and-fit',
					'the-wait',
					'crowding',
				]),
			`${cell.path} SSR omitted or reordered reliability bands`,
		);
		invariant(!ssr.importError, `${cell.path} SSR contains a reliability import failure`);
		const ids = [
			'line.day.otp_pct',
			'line.day.avg_delay_min',
			'line.day.p50_min',
			'line.day.p90_min',
		];
		const expected = expectedDomainObservationsFromFixture(fixture, 'line', cell.locale, cell.path);
		const expectedHeadline = expected.filter((row) => ids.includes(row.id));
		invariant(ssr.values.length === 4, `${cell.path} SSR record shape changed`);
		invariant(
			ssr.figureCount === (expectedHeadline[0]?.value == null ? 0 : 1),
			`${cell.path} SSR record figure count disagrees with published data`,
		);
		invariant(!ssr.secondVerdict, `${cell.path} SSR rendered a second verdict`);
		invariant(
			lineVerdictObservationCount(normalizeObservation(ssr.readings)) ===
				expected.find((row) => row.id === 'line.day.observation_count')?.value,
			`${cell.path} SSR record readings disagree with published data`,
		);
		const actual = ids.map((id, index) => observation(id, parseNumber(ssr.values[index])));
		actual.push(observation('line.pane.freshness_iso', ssr.freshness));
		compareObservations(
			expected.filter((row) => ids.includes(row.id) || row.id === 'line.pane.freshness_iso'),
			actual,
			`${cell.fixture}/${cell.locale}/line SSR`,
		);
		for (const [index, value] of ssr.values.entries()) {
			if (value != null)
				invariant(
					index === 0 ? value.includes('%') : value.includes('min'),
					`${cell.path} SSR KPI ${index} omitted its unit`,
				);
		}
		const params = new URL(cell.path, 'http://b9.local').searchParams;
		const dates = selected
			? [params.get('from'), params.get('to')]
			: [expectedScheduleTruth(fixture).date];
		for (const date of dates)
			invariant(
				date && ssr.window.includes(date),
				`${cell.path} SSR omitted selected/current date ${date}`,
			);
	} else if (cell.surface === 'stop') {
		const stop = fixture.files['static/stops/52095.json'];
		invariant(normalized.includes(stop.name), `${cell.path} SSR omitted stop identity`);
		invariant(
			!mainHtml.includes('data-slot="stop-reliability-sections"') && !normalized.includes('16.1%'),
			`${cell.path} SSR rendered browser-only stop reliability`,
		);
	} else {
		const network = fixture.files['live/network.json'];
		invariant(
			normalized.includes(cell.locale === 'fr' ? 'RÉSEAU' : 'NETWORK'),
			`${cell.path} SSR omitted network identity`,
		);
		if (network.on_time_pct != null)
			invariant(
				normalized.includes(`${network.on_time_pct}%`),
				`${cell.path} SSR omitted live on-time value`,
			);
	}
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

async function verifyAccessibleMirrors(page, cell) {
	const invalid = await page.locator('figure[data-slot$="-mark"]').evaluateAll((figures) =>
		figures.flatMap((figure) => {
			if (figure.getAttribute('data-slot') === 'bullet-mark') return [];
			const table = figure.querySelector('table.sr-only');
			const rows = [...(table?.querySelectorAll('tbody tr') ?? [])];
			return table?.querySelector('caption')?.textContent?.trim() &&
				rows.some((row) =>
					[...row.querySelectorAll('th,td')].some((item) => item.textContent?.trim()),
				)
				? []
				: [figure.getAttribute('data-slot')];
		}),
	);
	invariant(invalid.length === 0, `${cell.path} invalid AT mirrors: ${invalid.join(', ')}`);
}

const NETWORK_TERMINAL_SELECTOR =
	'#net-historic [data-slot="network-history-board"], #net-historic [data-slot="edge-state"]:not([data-variant="skeleton"])';

function latestDatedRow(rows) {
	return rows
		.filter((row) => /^\d{4}-\d{2}-\d{2}$/u.test(row?.date ?? ''))
		.sort((left, right) => left.date.localeCompare(right.date))
		.at(-1);
}

function expectedSurfaceState(cell, fixture) {
	const rows = {
		line: fixture.files['historic/route_reliability/24.json']?.periods_by_grain?.filter(
			(row) => row.grain === 'day',
		),
		stop: fixture.files['historic/stop_reliability/52095.json']?.daily,
		network: (fixture.files['historic/network_trend.json']?.series ?? []).filter((row) => {
			const anchor = trendClosedThrough(
				fixture.files['historic/history/index.json'] ?? null,
				fixture.files['historic/network_trend.json']?.series ?? [],
			);
			return anchor != null && row.date <= anchor;
		}),
	}[cell.surface];
	const latest = latestDatedRow(rows ?? []);
	const terminalSelector =
		cell.surface === 'network' && !(latest?.observation_count > 0)
			? NETWORK_TERMINAL_SELECTOR
			: null;
	// The stop names its days in words: its representative date is the latest day it draws.
	const representativeDate =
		cell.surface === 'stop' ? expectedStopLatestDay(fixture, cell.locale) : (latest?.date ?? null);
	return { representativeDate: terminalSelector ? null : representativeDate, terminalSelector };
}

async function verifyTextSemantics(page, cell, fixture) {
	const text = normalizeObservation(await page.locator('main').innerText());
	const { representativeDate, terminalSelector } = expectedSurfaceState(cell, fixture);
	if (representativeDate)
		invariant(
			text.includes(representativeDate),
			`${cell.path} omitted the representative date ${representativeDate}`,
		);
	else
		invariant(
			terminalSelector && (await page.locator(terminalSelector).count()) > 0,
			`${cell.path} omitted its terminal state`,
		);
	if (cell.fixture !== 'rich') return;
	if (cell.surface === 'line') {
		if (!cell.path.includes('from=')) {
			invariant(/[−-]1[.,]5 min/u.test(text), `${cell.path} lost the signed minute value`);
			invariant(
				text.includes(
					cell.locale === 'fr' ? '77 identifiants de trajet observés' : '77 trip IDs observed',
				),
				`${cell.path} lost the localized plural`,
			);
		}
	}
}

async function verifyControls(page, cell) {
	if (cell.fixture !== 'rich') return;
	if (cell.surface === 'line') {
		// Five stops first; the one toggle shows every published stop, then five again.
		const weak = page.locator('[data-slot="stop-delays"]');
		const toggle = weak.locator('[data-slot="stop-delays-toggle"]');
		// A chosen range has no stop cut of its own: no list, and the absence said in words.
		const chosenRange = cell.path.includes('from=');
		invariant(
			(await weak.count()) === (chosenRange ? 0 : 1) &&
				(await page
					.locator('[data-slot="worst-stops-empty"] [data-slot="absent-value"]')
					.count()) === (chosenRange ? 1 : 0),
			`${cell.path} stop list ${chosenRange ? 'borrowed the latest day for a range' : 'missing'}`,
		);
		const total = chosenRange ? 0 : Number(await weak.getAttribute('data-total'));
		invariant(
			chosenRange || total === 15,
			`${cell.path} stop list total ${total}, expected the fixture's 15`,
		);
		for (const [expanded, count] of chosenRange
			? []
			: [
					['false', 5],
					['true', total],
					['false', 5],
				]) {
			await page.evaluate((phase) => (window.__b9Phase = phase), `weak-${count}`);
			if ((await toggle.getAttribute('aria-expanded')) !== expanded) await toggle.click();
			invariant(
				(await weak.locator('[data-slot="stop-delay-row"]').count()) === count,
				`${cell.path} stop list did not show ${count} rows`,
			);
		}
		const grain = page.locator('[data-slot="surface-rail"] [data-slot="grain-picker"]').first();
		await page.evaluate(() => (window.__b9Phase = 'week'));
		await grain
			.getByRole('radio', {
				name: cell.locale === 'fr' ? /Dernier jour complet/ : /Latest complete day/,
			})
			.click();
		await page.locator('[data-slot="histogram-mark"]').waitFor({ state: 'attached' });
		await page.evaluate(() => (window.__b9Phase = 'range'));
		await grain
			.getByRole('radio', { name: cell.locale === 'fr' ? 'Plage de dates' : 'Date range' })
			.click();
		const dates = page.locator(
			'[data-slot="surface-rail"] [data-slot="date-range"] input[type="date"]',
		);
		invariant((await dates.count()) === 2, `${cell.path} date-range controls did not mount`);
		const rangeResponse = page.waitForResponse((response) => {
			const path = new URL(response.url()).pathname;
			return (
				response.status() === 200 &&
				path.includes('/historic/history/lines/') &&
				/\/\d{4}-\d{2}\.json$/u.test(path)
			);
		});
		await dates.nth(0).fill('2026-08-28');
		await dates.nth(1).fill('2026-08-29');
		await (await rangeResponse).finished();
		// Kit 3 may schedule the retained read after the input event. Do not let
		// the next grain click abort it while an empty/loading KPI looks absent.
		await page.waitForFunction(() => {
			const caption = document.querySelector('[data-slot="active-window"]')?.textContent ?? '';
			return (
				!document.querySelector('[data-slot="history-loading"]') &&
				caption.includes('2026-08-28') &&
				caption.includes('2026-08-29')
			);
		});
		const rangeKpis = await readValues(
			page,
			'[data-section="verdict"] [data-slot="verdict-kpis"] > [data-slot="metric-bullet"]',
			'.metric-bullet__value',
		);
		invariant(
			rangeKpis[2] == null && rangeKpis[3] == null,
			`${cell.path} multi-day percentiles did not stand down`,
		);
		await grain
			.getByRole('radio', {
				name: cell.locale === 'fr' ? /Dernier jour complet/ : /Latest complete day/,
			})
			.click();
	} else if (cell.surface === 'stop') {
		const grain = page.locator('[data-slot="surface-rail"] [data-slot="grain-picker"]').first();
		await grain.getByRole('radio', { name: cell.locale === 'fr' ? 'Semaine' : 'Week' }).click();
		invariant(
			(await page.locator('[data-slot="stop-percentiles"]').count()) === 0,
			`${cell.path} week percentiles did not stand down`,
		);
		await grain.getByRole('radio', { name: cell.locale === 'fr' ? 'Jour' : 'Day' }).click();
		await page.locator('[data-slot="stop-percentiles"]').waitFor({ state: 'attached' });
	}
}

async function verifyResponsiveRailFocus(page, cell) {
	const desktopViewport = page.viewportSize();
	for (let attempt = 0; attempt < 2; attempt += 1) {
		await page.setViewportSize({ width: 390, height: 844 });
		const pill = page.locator('[data-slot="app-frame"] .surface-rail-pill:visible');
		await pill.focus();
		await page.keyboard.press('Enter');
		const sheet = page
			.getByRole('dialog')
			.filter({ has: page.locator('[data-slot="surface-rail"]') });
		await sheet.waitFor();
		await sheet.locator('button:visible:not([disabled])').first().focus();
		await page.setViewportSize(desktopViewport);
		await sheet.waitFor({ state: 'detached' });
		invariant(
			await page
				.locator('.app-frame-controls-rail')
				.evaluate((rail) => rail.contains(document.activeElement)),
			`${cell.path} lost keyboard focus when the mobile controls moved to desktop`,
		);
	}
}

const MARK_SELECTORS = Object.freeze({
	// The network history trend is the surviving two-measure trend: chosen by its row, never by
	// whichever trend mark a page happens to render first.
	trend: [
		'[data-slot="network-history-trend-row"] figure[data-slot="trend-mark"]',
		'.dv-trendmark-otp, .dv-trendmark-retard',
	],
	histogram: ['[data-slot="histogram-mark"]', 'rect.dv-histmark-bar'],
	'dot-strip': ['[data-slot="dot-strip-mark"]', 'circle[class*="dv-stripmark-"]'],
	'magnitude-bars': ['[data-slot="magnitude-bars-mark"]', 'rect[class*="dv-barmark-"]'],
	line: ['[data-slot="line-mark"]', '.dv-line-spline'],
	sparkline: ['[data-slot="sparkline-mark"]', '.dv-sparkline-spline'],
	bullet: ['[data-slot="bullet-mark"]', 'rect[class*="dv-bullet--"]'],
	heatmap: ['[data-slot="heatmap-mark"]', 'rect.dv-heatmap-cell'],
	'stacked-share': ['[data-slot="stacked-share-mark"]', 'rect.dv-share-seg'],
	'service-span': ['[data-slot="service-span-timeline"]', 'rect.dv-span-bar'],
});

const MARK_SIGNATURES = Object.freeze({
	// The network history trend on the rich fixture's chosen range (August 27 to 29): retained
	// on-time 5/10, 2/10, 9/10 give otpTrendDomain([50, 20, 90]) = [18, 92] with the 80% reference
	// inside; the delay series is DELAY_DIST_DOMAIN. The stop record draws its days without this
	// mark (UX-T6.3), so the line and stop no longer represent it.
	trend: {
		domain: [
			[18, 92],
			[0, 15],
		],
		unit: ['%', 'min'],
		axis: ['20', '40', '60', '80', '2026-08-27', '2026-08-28', '2026-08-29', '0', '5', '10', '15'],
		// Axis titles sit in HTML above the plot so long EN/FR labels never clip. They are pinned as
		// rendered: the network labels already carry their unit, which the mark repeats.
		titles: ['On-time % (%)', 'Slowest 10% (min) (min)'],
	},
	histogram: {
		domain: [-300, 1800],
		unit: 's',
		// -1 and 1 min are thinned next to the pinned zero at this width.
		axis: ['Delay (min)', '-5', '0', '5', '10', '30'],
	},
	lineHistogram: {
		domain: [-300, 1800],
		unit: 's',
		axis: ['Delay, early to late (min)', '-5', '0', '5', '10', '30'],
	},
	// First drawn on the French closed-day cell: a chosen range shows no time-of-day cut.
	'dot-strip': {
		domain: [0, 100],
		unit: '%',
		axis: [
			'Retards graves par période (%)',
			'0',
			'20',
			'40',
			'60',
			'80',
			'100',
			'Pointe AM',
			'Pointe PM',
		],
	},
	// The range cell's only magnitude bars are delay by crowding, the chosen range's own mix.
	'magnitude-bars': {
		domain: [0, 8],
		unit: 'min',
		axis: [
			'Avg delay',
			'0',
			'2',
			'4',
			'6',
			'8',
			'Empty',
			'Many seats · No data',
			'Few seats · No data',
			'Standing',
			'Full',
		],
	},
	line: {
		domain: [0, 100],
		unit: '%',
		axis: [
			'Période',
			'AM',
			'Jour',
			'PM',
			'Soir',
			'Nuit',
			'Ponctualité',
			'0',
			'20',
			'40',
			'60',
			'80',
			'100',
		],
	},
	sparkline: { domain: [4, 8], unit: 'count', axis: [] },
	// The line record states its on-time share as its answer, not as a bullet: the first bullet
	// on the line page is the record's severe-delay share (SEVERE_DOMAIN, 0 to 100 %).
	bullet: { domain: [0, 100], unit: '%', axis: ['Severe-delay share', '0', '100'] },
	heatmap: {
		domain: [0, 1],
		unit: 'relative',
		axis: [
			'Mon',
			'Tue',
			'Wed',
			'Thu',
			'Fri',
			'Sat',
			'Sun',
			'Hour of day',
			'00:00',
			'03:00',
			'06:00',
			'09:00',
			'12:00',
			'15:00',
			'18:00',
			'21:00',
			'◆',
			'◆',
			'◆',
		],
	},
	'stacked-share': { domain: [0, 100], unit: '%', axis: [] },
	'service-span': {
		domain: [0, 1440],
		unit: 'min',
		axis: ['+0h', '+6h', '+12h', '+18h', '+24h'],
	},
});

async function verifyGeometry(page, seen, cell) {
	for (const [kind, [rootSelector, markSelector]] of Object.entries(MARK_SELECTORS)) {
		if (
			(seen.has(kind) &&
				(kind !== 'histogram' || seen.get(kind).surfaces.includes(cell.surface))) ||
			(await page.locator(rootSelector).count()) === 0
		)
			continue;
		const root = page.locator(rootSelector).first();
		await root.scrollIntoViewIfNeeded();
		const frame = root.locator('[data-slot="chart-frame"]').first();
		if ((await frame.count()) > 0) await frame.scrollIntoViewIfNeeded();
		await page.waitForTimeout(400);
		const mark = root.locator(markSelector).first();
		invariant((await mark.count()) > 0, `${kind} representative mark did not render`);
		const box = await mark.boundingBox();
		invariant(
			box && box.width > 0 && box.height > 0,
			`${kind} representative mark has zero geometry`,
		);
		const signature =
			kind === 'histogram' && cell.surface === 'line'
				? MARK_SIGNATURES.lineHistogram
				: MARK_SIGNATURES[kind];
		const axis = (await root.locator('svg text').allTextContents())
			.map((value) => value.trim())
			.filter((value) => kind !== 'trend' || !/^[A-Z][a-z]{2} \d{1,2}$/u.test(value));
		invariant(
			JSON.stringify(axis) === JSON.stringify(signature.axis),
			`${kind} domain/unit signature drift: ${JSON.stringify(axis)}`,
		);
		if (signature.titles) {
			const titles = (await root.locator('.axis-titles span').allTextContents()).map((value) =>
				value.trim(),
			);
			invariant(
				JSON.stringify(titles) === JSON.stringify(signature.titles),
				`${kind} axis title drift: ${JSON.stringify(titles)}`,
			);
		}
		if (kind === 'stacked-share') {
			const frameBox = await frame.boundingBox();
			const widths = await root
				.locator('rect.dv-share-seg')
				.evaluateAll((rects) => rects.map((rect) => rect.getBoundingClientRect().width));
			invariant(
				frameBox && widths.reduce((sum, width) => sum + width, 0) / frameBox.width > 0.95,
				'stacked-share no longer spans its 0-100 domain',
			);
		}
		if (kind === 'sparkline') {
			const frameBox = await root.boundingBox();
			invariant(
				frameBox && box.height / frameBox.height > 0.25,
				'sparkline no longer uses its [4,8] representative domain',
			);
		}
		seen.set(kind, {
			domain: signature.domain,
			unit: signature.unit,
			surfaces: [...(seen.get(kind)?.surfaces ?? []), cell.surface],
		});
	}
	if ((await page.locator('[data-slot="histogram-mark"]').count()) > 0) {
		const figure = page.locator('[data-slot="histogram-mark"]').first();
		const counts = await figure
			.locator('table tbody tr')
			.evaluateAll((rows) =>
				rows.flatMap((row) =>
					(row.querySelector('th')?.textContent ?? '').includes('∞')
						? []
						: [Number(row.querySelector('td')?.textContent ?? Number.NaN)],
				),
			);
		const boxes = (
			await figure.locator('rect.dv-histmark-bar').evaluateAll((rects) =>
				rects.map((rect) => {
					const box = rect.getBoundingClientRect();
					return { x: box.x, width: box.width, height: box.height };
				}),
			)
		).sort((a, b) => a.x - b.x);
		invariant(
			boxes.length === counts.length && boxes.length > 2,
			`histogram bin geometry/count mismatch (${boxes.length} bars, ${counts.length} rows)`,
		);
		const ratios = boxes.map((box, index) => (box.width * box.height) / counts[index]);
		const mean = ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
		invariant(
			Math.max(...ratios.map((value) => Math.abs(value - mean) / mean)) < 0.08,
			'histogram is not bin-width x density geometry',
		);
		invariant(
			new Set(boxes.map((box) => Math.round(box.width))).size > 1,
			'histogram collapsed true bin widths',
		);
	}
	// English clocks; the French cells now reach this pass for the first day cuts only.
	if (
		cell.locale === 'en' &&
		(await page.locator('[data-slot="service-span-timeline"]').count()) > 0
	) {
		const clocks = await page
			.locator('[data-slot="service-span-timeline"] .dv-span-end-clock')
			.allTextContents();
		invariant(
			clocks[0] === 'Aug 29, 2026, 05:00:00 GMT-4' && clocks[1] === 'Aug 30, 2026, 01:30:00 GMT-4',
			'service-span representative does not cross midnight',
		);
		const timeline = page.locator('[data-slot="service-span-timeline"]');
		const barWidth = await timeline
			.locator('rect.dv-span-bar')
			.evaluate((element) => element.getBoundingClientRect().width);
		const trackWidth = await timeline
			.locator('line.dv-span-track')
			.evaluate((element) => element.getBoundingClientRect().width);
		invariant(
			trackWidth > 0 && Math.abs(barWidth / trackWidth - 1230 / 1440) < 0.001,
			`service-span must show 20.5 elapsed hours on its 24-hour axis: ${barWidth}/${trackWidth}`,
		);
	}
	if ((await page.locator('[data-slot="weak-stops"] [data-slot="ci-whisker"]').count()) > 0) {
		const whisker = page.locator('[data-slot="weak-stops"] [data-slot="ci-whisker"]').first();
		invariant(
			(await whisker.locator('line').count()) === 3,
			'magnitude CI whisker is not a line plus two caps',
		);
	}
}

async function settleVisibleChartText(page) {
	for (const frame of await page.locator('[data-slot="chart-frame"]').all()) {
		await frame.scrollIntoViewIfNeeded();
		await page.waitForFunction(
			(element) => {
				const box = element.querySelector('svg')?.getBoundingClientRect();
				return box && box.width > 0 && box.height > 0;
			},
			await frame.elementHandle(),
			{ timeout: 5000 },
		);
		await page.evaluate(
			() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
		);
	}
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
					PUBLIC_V1_BASE: replay.base,
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

async function settleSurface(page, cell, fixture) {
	const selector = {
		line: '[data-section="verdict"]',
		stop: '[data-slot="stop-reliability-sections"]',
		network: '[data-network-section="network-live-headline"]',
	}[cell.surface];
	await page.locator(selector).waitFor({ state: 'attached', timeout: 30_000 });
	const expected = expectedSurfaceState(cell, fixture);
	const needsRichNetwork = cell.fixture === 'rich' && cell.surface === 'network';
	const expectedNetworkFreshnessSeconds =
		cell.surface === 'network'
			? Math.max(
					0,
					Math.round(
						(Date.parse(fixture.frozen_utc) -
							Date.parse(fixture.files['live/network.json'].generated_utc)) /
							1000,
					),
				)
			: null;
	await page.waitForFunction(
		({ representativeDate, terminalSelector, needsNetworkDetails, networkFreshnessSeconds }) => {
			const main = document.querySelector('main');
			if (!main || main.querySelector('[data-slot="edge-state"][data-variant="skeleton"]')) {
				return false;
			}
			if (representativeDate && !main.textContent?.includes(representativeDate)) return false;
			if (terminalSelector && !main.querySelector(terminalSelector)) return false;
			if (
				networkFreshnessSeconds != null &&
				!main.querySelector(
					`[data-slot="freshness-stamp"][data-variant="live"][data-age-seconds="${networkFreshnessSeconds}"]`,
				)
			)
				return false;
			if (
				needsNetworkDetails &&
				[
					'[data-slot="completeness-section"]:not(:has([data-slot="absent-value"]))',
					'[data-slot="verdict-delta"]',
					'[data-slot="network-shift"]',
					'[data-network-section="network-weekday-weekend"]',
				].some((required) => !main.querySelector(required))
			) {
				return false;
			}
			return true;
		},
		{
			...expected,
			needsNetworkDetails: needsRichNetwork,
			networkFreshnessSeconds: expectedNetworkFreshnessSeconds,
		},
		{ timeout: 30_000 },
	);
	await page.evaluate(() => document.fonts.ready);
	await page.evaluate(
		() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
	);
}

async function verifyEngineRecord(page, cell, replay, errors, html) {
	const label = `${cell.fixture}/${cell.locale}/${cell.surface}`;
	const section = page.locator('#punctuality');
	const bands = section.locator('dl');
	const missing = cell.fixture === 'sparse';
	if (missing) {
		await section.getByText('Not measured', { exact: true }).waitFor();
		invariant((await bands.count()) === 0, `${label} gave an unmeasured record numeric bands`);
		invariant(
			!/\b0\s*%/u.test(await section.innerText()),
			`${label} replaced missing data with zero`,
		);
	} else {
		await bands.waitFor();
		const early = cell.surface === 'line' ? 10 : 5;
		const onTime = new URL(page.url()).searchParams.get('direction') === '1' ? 40 : 80;
		const counts = [early, onTime, 100 - early - onTime];
		const displayedLabels = await bands.locator('dt').evaluateAll((terms) =>
			terms.map((term) => {
				const label = term.cloneNode(true);
				label.querySelectorAll('[aria-hidden="true"]').forEach((decoration) => decoration.remove());
				return label.textContent.trim();
			}),
		);
		const expectedLabels =
			cell.locale === 'fr' ? ['En avance', 'À l’heure', 'En retard'] : ['Early', 'On time', 'Late'];
		invariant(
			JSON.stringify(displayedLabels) === JSON.stringify(expectedLabels),
			`${label} mislabeled or reordered the punctuality bands: ${displayedLabels}`,
		);
		const readings = (await bands.locator('dd').allTextContents()).map((text) =>
			Array.from(text.matchAll(/\d+(?:[.,]\d+)?/gu), ([number]) => parseNumber(number)),
		);
		invariant(
			JSON.stringify(readings) ===
				JSON.stringify(
					counts.map((count) =>
						cell.surface === 'line' ? [count, count, 100, 50, 200] : [count, count, 100],
					),
				),
			`${label} punctuality shares or denominators drifted: ${JSON.stringify(readings)}`,
		);
		await page.locator('#daily table tbody tr').first().waitFor();
		const csv = await section.getByRole('link', { name: /CSV/u }).getAttribute('href');
		invariant(csv != null, `${label} missing CSV link`);
		const exportUrl = new URL(csv, page.url());
		invariant(
			exportUrl.searchParams.get('section') === 'punctuality' &&
				exportUrl.searchParams.get('recordFrom') === '2026-11-08' &&
				exportUrl.searchParams.get('recordTo') === '2026-11-14',
			`${label} CSV lost the displayed measure or dates: ${exportUrl}`,
		);
	}
	await verifyAccessibility(page, cell);
	await page.locator('#daily a[href*="section=daily"]').first().waitFor({ state: 'attached' });
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
	const isLine = cell.surface === 'line';
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
				{ measure: 'alert_counts' },
			]
		: [
				{ measure: 'punctuality' },
				{ measure: 'on_time', group: 'line' },
				{ measure: 'waiting_and_gaps', group: 'line' },
				{ measure: 'on_time', group: 'hour' },
				{ measure: 'on_time', group: 'day' },
				{ measure: 'accessible_stops' },
				{ measure: 'alert_counts' },
			];
	const expectedPaths = expectedQueries.map((query) => {
		const params = new URLSearchParams({
			from: '2026-11-08',
			to: '2026-11-14',
			...(isLine ? { line: '24' } : { stop: 'S1' }),
			...query,
		});
		if (isLine && direction && query.group !== 'direction' && query.measure !== 'alert_counts')
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
		actual: missing ? ['not_measured'] : await bands.locator('dd').allTextContents(),
		ssr: ssrText(html),
		hydrated,
		ledger: data.map(({ lane, path, status }) => `${lane}|${path}|${status}`).sort(),
	};
}

async function runGate({ fixtures = FIXTURES, cells = CELLS, runs = 2, synthetic = true } = {}) {
	const selfCheck = runRunnerSelfCheck();
	const built = await ensureBuild();
	const replay = await startReplay(fixtures, cells[0]?.fixture);
	const displayFailures = new Map();
	const geometrySeen = new Map();
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
				const original = fixtures[cell.fixture];
				const fixture =
					cell.surface === 'network'
						? {
								...original,
								files: {
									...original.files,
									'live/network.json': b9LiveFixture(original).expectation,
								},
							}
						: original;
				const context = await browser.newContext({
					bypassCSP: true,
					locale: cell.locale === 'fr' ? 'fr-CA' : 'en-CA',
					serviceWorkers: 'block',
					viewport: { width: 1440, height: 1000 },
				});
				await context.addInitScript({
					content: freezeClockScript(
						cell.surface === 'network' ? fixture.frozen_utc : '2026-11-22T12:00:00Z',
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
				if (cell.surface !== 'network') {
					const record = await verifyEngineRecord(page, cell, replay, errors, ssrHtml);
					transcript.push(record);
					observationCount += record.actual.length;
					requestCount += replay.state.ledger.length;
					await context.close();
					continue;
				}
				try {
					await settleSurface(page, cell, fixture);
				} catch (error) {
					throw new Error(
						`run ${run + 1} ${cell.fixture}/${cell.locale}/${cell.surface} did not settle\nbrowser errors ${JSON.stringify(errors)}\nreplay ledger ${JSON.stringify(replay.state.ledger)}`,
						{ cause: error },
					);
				}
				await verifySsr(page, cell, fixture, ssrHtml);
				// B9 measures the rendered data. Reveal content through its bulk control
				// before interacting with detail controls inside the collapsed sections.
				await page.waitForFunction(
					() =>
						document.querySelector('[data-sections-control][data-sections-ready]') &&
						[...document.querySelectorAll('[data-section-bulk]')].every((card) =>
							card.hasAttribute('data-section-ready'),
						),
				);
				const bulk = page.locator('[data-sections-control]:not([data-sections-hidden]) button');
				if ((await bulk.count()) > 0) {
					await bulk.waitFor({ state: 'visible' });
					if ((await bulk.getAttribute('data-collapsed')) === 'true') await bulk.click();
					await page.waitForFunction(() =>
						[...document.querySelectorAll('[data-section-bulk]')].every(
							(card) =>
								card.querySelector('[data-section-trigger]')?.getAttribute('aria-expanded') ===
								'true',
						),
					);
				}
				for (const toggle of await page.locator('[data-slot="detail-toggle"]').all()) {
					const control = await toggle.elementHandle();
					invariant(control != null, `${cell.path} detail control disappeared`);
					try {
						if ((await control.getAttribute('aria-expanded')) === 'false') await control.click();
						await page.waitForFunction(
							(button) =>
								button.isConnected &&
								!button.disabled &&
								button.getAttribute('aria-expanded') === 'true',
							control,
							{ timeout: 5_000 },
						);
					} catch (error) {
						throw new Error(
							`${cell.fixture}/${cell.locale}/${cell.surface} detail did not open\nbrowser errors ${JSON.stringify(errors)}\nreplay ledger ${JSON.stringify(replay.state.ledger)}`,
							{ cause: error },
						);
					} finally {
						await control.dispose();
					}
				}
				// Geometry checks scroll the page. Park the pointer and switch hover preloading
				// off: content pages scroll the document, so any link can pass under the
				// parked pointer and start a preload for an unrelated fixture route.
				await page.mouse.move(0, 0);
				await page.evaluate(() => {
					for (const element of document.querySelectorAll('[data-sveltekit-preload-data]'))
						element.setAttribute('data-sveltekit-preload-data', 'off');
				});
				await verifyAccessibility(page, cell);
				await verifyTextSemantics(page, cell, fixture);
				let actual;
				try {
					actual = await collectNetwork(page, cell.locale);
				} catch (error) {
					throw new Error(
						`${String(error)}\nbrowser errors ${JSON.stringify(errors)}\nreplay ledger ${JSON.stringify(replay.state.ledger)}`,
						{ cause: error },
					);
				}
				await settleVisibleChartText(page);
				const initialHydrated = normalizeObservation(await page.locator('main').innerText());
				await verifyAccessibleMirrors(page, cell);
				observationCount += actual.length;
				try {
					invariant(
						JSON.stringify(actual.map((row) => row.id)) ===
							JSON.stringify(OBSERVATION_IDS[cell.surface]),
						`${cell.surface} collector observation contract changed`,
					);
					compareObservations(
						expectedDomainObservationsFromFixture(fixture, cell.surface, cell.locale, cell.path),
						actual,
						`${cell.fixture}/${cell.locale}/${cell.surface}`,
					);
				} catch (error) {
					displayFailures.set(`${cell.fixture}/${cell.locale}/${cell.surface}`, String(error));
				}
				// Every rich cell: the closed-day line cell (French) is the first to draw the day's cuts.
				if (run === 0 && cell.fixture === 'rich') {
					await verifyGeometry(page, geometrySeen, cell);
				}
				await verifyControls(page, cell);
				await verifyResponsiveRailFocus(page, cell);
				const expected404 = replay.state.ledger.some((entry) => entry.status === 404);
				const svgViolations = await page.evaluate(() => window.__b9SvgViolations ?? []);
				const geometryErrors = errors.filter((error) =>
					/(?:NaN|Infinity).*(?:svg|attribute)|attribute.*(?:NaN|Infinity)/iu.test(error),
				);
				if (geometryErrors.length > 0 || svgViolations.length > 0) {
					const key = `${cell.fixture}/${cell.locale}/${cell.surface}`;
					const message = `non-finite SVG geometry: ${JSON.stringify(svgViolations[0]) ?? geometryErrors[0]}`;
					displayFailures.set(key, [displayFailures.get(key), message].filter(Boolean).join('\n'));
				}
				const unexpectedErrors = errors.filter(
					(error) =>
						!geometryErrors.includes(error) &&
						!(expected404 && /Failed to load resource:.*404 \(Not Found\)/u.test(error)),
				);
				invariant(
					unexpectedErrors.length === 0,
					`${cell.path} browser errors: ${unexpectedErrors.join(' | ')}`,
				);
				invariant(
					replay.state.outbound.length === 0,
					`${cell.path} outbound: ${replay.state.outbound}`,
				);
				invariant(
					replay.state.ledger.some(
						(entry) => entry.lane === 'ssr' && entry.path === '/v2/stm/live',
					),
					`${cell.path} preview did not read the v2 capture fixture`,
				);
				invariant(
					replay.state.ledger.every((entry) => entry.status !== 599),
					`${cell.path} unknown replay request: ${JSON.stringify(replay.state.ledger)}`,
				);
				verifyLedger(cell, fixture, replay.state.ledger);
				requestCount += replay.state.ledger.length;
				transcript.push({
					cell: `${cell.fixture}/${cell.locale}/${cell.surface}`,
					actual,
					ssr: ssrText(ssrHtml),
					hydrated: initialHydrated,
					ledger: replay.state.ledger
						.map((entry) => `${entry.lane}|${entry.path}|${entry.status}`)
						.sort(),
				});
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
			invariant(
				JSON.stringify([...geometrySeen.keys()].sort()) === JSON.stringify(NETWORK_MARKS),
				`mark branch coverage mismatch: ${JSON.stringify([...geometrySeen.keys()].sort())}`,
			);
		}
		if (displayFailures.size > 0) {
			const evidence = {
				cells: cells.length,
				runs,
				observations: observationCount,
				requests: requestCount,
				marks: geometrySeen.size,
				...selfCheck,
			};
			throw new Error(
				`B9 displayed-value gate RED ${JSON.stringify(evidence)}\n${[...displayFailures].map(([cell, error]) => `\n[${cell}]\n${error}`).join('\n')}`,
			);
		}
		return {
			built,
			cells: cells.length,
			runs,
			observations: observationCount,
			requests: requestCount,
			marks: geometrySeen.size,
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
