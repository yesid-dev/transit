import { writeFile } from 'node:fs/promises';
import type { CDPSession, Page, TestInfo, TestType } from '@playwright/test';

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

interface StackFrame {
	readonly functionName: string;
	readonly url: string;
	readonly line: number;
	readonly column: number;
	readonly source?: string;
}

interface Probe {
	readonly cdp: CDPSession;
	readonly rows: Map<string, ProbedRequest>;
}

const probes = new WeakMap<Page, Probe>();

function within<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
	return Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(resolve, ms))]);
}

async function startProbe(page: Page): Promise<void> {
	if (page.context().browser()?.browserType().name() !== 'chromium') return;
	const cdp = await page.context().newCDPSession(page);
	const start = Date.now();
	const rows = new Map<string, ProbedRequest>();
	const since = () => Date.now() - start;
	const row = (id: string) => rows.get(id);
	probes.set(page, { cdp, rows });
	cdp.on('Network.requestWillBeSent', (event) => {
		rows.set(event.requestId, {
			url: event.request.url.replace(/^https?:\/\/[^/]+/, ''),
			type: event.type ?? 'Other',
			priority: event.request.initialPriority,
			created: since(),
		});
	});
	// The network service emits ExtraInfo with the headers it wrote to the connection. The other
	// events come from the page's renderer, so a busy page thread stops reporting them.
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
	// Enabled up front: a stuck page thread cannot answer Debugger.enable later, only Debugger.pause.
	await cdp.send('Debugger.enable');
}

interface PausedFrame {
	readonly functionName: string;
	readonly url: string;
	readonly location: { scriptId: string; lineNumber: number; columnNumber?: number };
}

/**
 * Pause the page's JavaScript and read where it is. DevTools interrupts running script, so this
 * answers even when the page thread is stuck in a loop and Playwright cannot evaluate anything.
 */
async function pausedStack(cdp: CDPSession): Promise<StackFrame[] | undefined> {
	const paused = new Promise<PausedFrame[]>((resolve) =>
		cdp.once('Debugger.paused', (event) => resolve(event.callFrames)),
	);
	await within(cdp.send('Debugger.pause'), 3000);
	const frames = await within(paused, 5000);
	if (!frames) return undefined;
	const stack: StackFrame[] = [];
	for (const [index, frame] of frames.slice(0, 25).entries()) {
		const { scriptId, lineNumber, columnNumber = 0 } = frame.location;
		let source: string | undefined;
		// Bundles are minified onto long lines, so keep the code around the paused column.
		if (index < 8) {
			const script = await within(cdp.send('Debugger.getScriptSource', { scriptId }), 2000);
			const line = script?.scriptSource.split('\n')[lineNumber];
			source = line?.slice(Math.max(0, columnNumber - 200), columnNumber + 200);
		}
		stack.push({
			functionName: frame.functionName,
			url: frame.url.replace(/^https?:\/\/[^/]+/, ''),
			line: lineNumber,
			column: columnNumber,
			source,
		});
	}
	await within(cdp.send('Debugger.resume'), 2000);
	return stack;
}

async function reportProbe(page: Page, testInfo: TestInfo): Promise<void> {
	if (testInfo.status === testInfo.expectedStatus) return;
	const probe = probes.get(page);
	if (!probe) return;
	const rows = [...probe.rows.values()];
	const open = rows.filter((row) => row.finished === undefined && row.failed === undefined);
	const answer = await within(
		page.evaluate(() => document.readyState).catch((error: unknown) => `error: ${String(error)}`),
		2000,
	);
	const summary = {
		requests: rows.length,
		unfinished: open.length,
		unfinishedSent: open.filter((row) => row.sent !== undefined).length,
		unfinishedWithResponse: open.filter((row) => row.response !== undefined).length,
		lastFinished: Math.max(0, ...rows.map((row) => row.finished ?? 0)),
		pageThread: answer === undefined ? 'no answer within 2 s' : `answers (${answer})`,
	};
	const stack =
		answer === undefined ? await pausedStack(probe.cdp).catch(() => undefined) : undefined;
	// A file in the test's output folder travels with CI's uploaded failure evidence.
	const path = testInfo.outputPath('request-probe.json');
	await writeFile(path, JSON.stringify({ ...summary, stack, rows }, null, 1));
	await testInfo.attach('request-probe.json', { path, contentType: 'application/json' });
	if (open.length || answer === undefined) {
		const top = stack
			?.slice(0, 3)
			.map(
				(frame) =>
					`${frame.functionName || '(anonymous)'} ${frame.url}:${frame.line}:${frame.column}`,
			);
		console.log(`request probe (${testInfo.title}): ${JSON.stringify({ ...summary, top })}`);
	}
}

/**
 * On an unexpected result, attach every request of the test's page and whether Chromium sent it.
 * When the page thread does not answer, also attach where its JavaScript is running, so a page
 * that never hydrates shows whether a script is stuck or the network never delivered.
 */
export function probeRequests(test: TestType<{ page: Page }, object>): void {
	test.beforeEach(async ({ page }) => startProbe(page));
	test.afterEach(async ({ page }, testInfo) => reportProbe(page, testInfo));
}
