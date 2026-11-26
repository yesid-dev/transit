import { writeFile } from 'node:fs/promises';
import type { Page, TestInfo, TestType } from '@playwright/test';

/** One request as Chromium's DevTools protocol saw it, in milliseconds since the probe started. */
interface ProbedRequest {
	readonly url: string;
	readonly type: string;
	readonly priority: string;
	readonly created: number;
	sent?: number;
	response?: number;
	finished?: number;
	failed?: string;
}

const probes = new WeakMap<
	Page,
	{ readonly start: number; readonly rows: Map<string, ProbedRequest> }
>();

async function startProbe(page: Page): Promise<void> {
	if (page.context().browser()?.browserType().name() !== 'chromium') return;
	const cdp = await page.context().newCDPSession(page);
	const start = Date.now();
	const rows = new Map<string, ProbedRequest>();
	const since = () => Date.now() - start;
	const row = (id: string) => rows.get(id);
	probes.set(page, { start, rows });
	cdp.on('Network.requestWillBeSent', (event) => {
		rows.set(event.requestId, {
			url: event.request.url.replace(/^https?:\/\/[^/]+/, ''),
			type: event.type ?? 'Other',
			priority: event.request.initialPriority,
			created: since(),
		});
	});
	// Chromium emits ExtraInfo with the headers it actually wrote to the connection.
	cdp.on('Network.requestWillBeSentExtraInfo', (event) => {
		const probed = row(event.requestId);
		if (probed) probed.sent ??= since();
	});
	cdp.on('Network.responseReceived', (event) => {
		const probed = row(event.requestId);
		if (probed) probed.response ??= since();
	});
	cdp.on('Network.loadingFinished', (event) => {
		const probed = row(event.requestId);
		if (probed) probed.finished = since();
	});
	cdp.on('Network.loadingFailed', (event) => {
		const probed = row(event.requestId);
		if (probed) probed.failed = event.errorText;
	});
	await cdp.send('Network.enable');
}

async function reportProbe(page: Page, testInfo: TestInfo): Promise<void> {
	if (testInfo.status === testInfo.expectedStatus) return;
	const probe = probes.get(page);
	if (!probe) return;
	const rows = [...probe.rows.values()];
	const open = rows.filter((row) => row.finished === undefined && row.failed === undefined);
	const summary = {
		requests: rows.length,
		unfinished: open.length,
		unfinishedSent: open.filter((row) => row.sent !== undefined).length,
		unfinishedWithResponse: open.filter((row) => row.response !== undefined).length,
		lastFinished: Math.max(0, ...rows.map((row) => row.finished ?? 0)),
	};
	// A file in the test's output folder travels with CI's uploaded failure evidence.
	const path = testInfo.outputPath('request-probe.json');
	await writeFile(path, JSON.stringify({ ...summary, rows }, null, 1));
	await testInfo.attach('request-probe.json', { path, contentType: 'application/json' });
	if (open.length) console.log(`request probe (${testInfo.title}): ${JSON.stringify(summary)}`);
}

/**
 * On an unexpected result, attach every request of the test's page and whether Chromium sent it.
 * A page that never hydrates shows here as unfinished requests that were or were not sent, which
 * separates a browser-side hold from a server that never answered. Passing tests attach nothing.
 */
export function probeRequests(test: TestType<{ page: Page }, object>): void {
	test.beforeEach(async ({ page }) => startProbe(page));
	test.afterEach(async ({ page }, testInfo) => reportProbe(page, testInfo));
}
