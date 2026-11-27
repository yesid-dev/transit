import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
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

/** Ask the renderer directly, outside Playwright's execution-context bookkeeping. */
async function rendererAnswer(cdp: CDPSession, expression: string, ms: number): Promise<string> {
	const answer = await within(
		cdp
			.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
			.then((result) => String(result.result.value))
			.catch((error: unknown) => `error: ${String(error)}`),
		ms,
	);
	return answer ?? `no answer within ${ms / 1000} s`;
}

interface ProcessInfo {
	readonly type: string;
	readonly id: number;
	readonly cpuTime: number;
}

/** Seconds of CPU each Chromium process used over one second: busy versus blocked or idle. */
async function processCpu(
	browser: CDPSession,
): Promise<{ type: string; pid: number; cpu: number }[]> {
	const read = async () =>
		((await browser.send('SystemInfo.getProcessInfo')) as { processInfo: ProcessInfo[] })
			.processInfo;
	const before = await read();
	await new Promise((resolve) => setTimeout(resolve, 1000));
	return (await read()).map((process) => ({
		type: process.type,
		pid: process.id,
		cpu:
			Math.round(
				(process.cpuTime - (before.find((old) => old.id === process.id)?.cpuTime ?? 0)) * 100,
			) / 100,
	}));
}

const TRACE_CATEGORIES = [
	'toplevel',
	'cc',
	'viz',
	'blink',
	'gpu',
	'renderer.scheduler',
	'disabled-by-default-cc.debug',
	'disabled-by-default-cc.debug.scheduler',
	'disabled-by-default-devtools.timeline',
];

interface TraceEvent {
	readonly name: string;
	readonly ph: string;
	readonly pid: number;
	readonly tid: number;
	readonly args?: Record<string, unknown>;
}

/**
 * Record a few seconds of Chromium's own trace while the page is stuck. Compositor state names a
 * stuck frame pipeline: whether the renderer still receives frames, has a committed tree that never
 * activates, or waits on its main thread.
 */
async function stallTrace(
	browser: CDPSession,
	ms: number,
): Promise<{ events: TraceEvent[]; raw: string } | undefined> {
	const complete = new Promise<string | undefined>((resolve) =>
		browser.once('Tracing.tracingComplete', (event) => resolve(event.stream)),
	);
	await browser.send('Tracing.start', {
		transferMode: 'ReturnAsStream',
		traceConfig: { recordMode: 'recordUntilFull', includedCategories: TRACE_CATEGORIES },
	});
	await new Promise((resolve) => setTimeout(resolve, ms));
	await browser.send('Tracing.end');
	const stream = await within(complete, 10_000);
	if (!stream) return undefined;
	const parts: string[] = [];
	for (;;) {
		const chunk = await browser.send('IO.read', { handle: stream, size: 1 << 20 });
		parts.push(chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString() : chunk.data);
		if (chunk.eof) break;
	}
	await browser.send('IO.close', { handle: stream });
	const raw = parts.join('');
	const parsed = JSON.parse(raw) as { traceEvents?: TraceEvent[] } | TraceEvent[];
	return { events: Array.isArray(parsed) ? parsed : (parsed.traceEvents ?? []), raw };
}

const SCHEDULER_FIELDS = [
	'has_pending_tree',
	'pending_tree_is_ready_for_activation',
	'active_tree_is_ready_to_draw',
	'needs_begin_main_frame',
	'needs_prepare_tiles',
	'visible',
	'commit_count',
	'current_frame_number',
	'last_frame_number_draw_performed',
	'last_frame_number_begin_main_frame_sent',
];

/** What each renderer's main and compositor threads did during the trace, in a few fields. */
function summarizeTrace(events: readonly TraceEvent[], renderers: ReadonlySet<number>) {
	const threads = new Map<string, string>();
	for (const event of events) {
		if (event.ph === 'M' && event.name === 'thread_name' && renderers.has(event.pid)) {
			threads.set(`${event.pid}:${event.tid}`, String(event.args?.name));
		}
	}
	return [...renderers].map((pid) => {
		const counts: Record<string, Record<string, number>> = {};
		let scheduler: Record<string, unknown> | undefined;
		for (const event of events) {
			if (event.pid !== pid || event.ph === 'M') continue;
			const thread = threads.get(`${pid}:${event.tid}`) ?? String(event.tid);
			if (thread !== 'CrRendererMain' && thread !== 'Compositor') continue;
			counts[thread] ??= {};
			counts[thread][event.name] = (counts[thread][event.name] ?? 0) + 1;
			if (event.name === 'SchedulerStateMachine') {
				const machine = (
					event.args?.cc_scheduler_state as {
						state_machine?: {
							major_state?: Record<string, unknown>;
							minor_state?: Record<string, unknown>;
						};
					}
				)?.state_machine;
				scheduler = {
					...machine?.major_state,
					...Object.fromEntries(
						SCHEDULER_FIELDS.map((field) => [field, machine?.minor_state?.[field]]),
					),
				};
			}
		}
		const top = (thread: string) =>
			Object.entries(counts[thread] ?? {})
				.sort((a, b) => b[1] - a[1])
				.slice(0, 12);
		return { pid, scheduler, compositor: top('Compositor'), main: top('CrRendererMain') };
	});
}

const run = promisify(execFile);

/**
 * Native stacks of a renderer's threads, where the host lets a test attach a debugger (Linux CI
 * runners allow passwordless sudo). Chromium ships stripped, so frames inside it are addresses,
 * but the system frames still tell a lock or sync wait from an idle message loop.
 */
async function nativeStacks(pid: number | undefined): Promise<string> {
	if (pid === undefined) return 'no renderer';
	if (process.platform !== 'linux') return 'not linux';
	const gdb = await run('sh', ['-c', 'command -v gdb && sudo -n true']).catch(() => undefined);
	if (!gdb) return 'gdb or passwordless sudo unavailable';
	const args = ['-n', 'gdb', '-batch', '-nx', '-p', String(pid), '-ex', 'thread apply all bt 12'];
	const result = await run('sudo', args, { timeout: 12_000, maxBuffer: 4 << 20 }).catch(
		(error: { stdout?: string; message?: string }) => ({ stdout: error.stdout ?? error.message }),
	);
	return String(result.stdout)
		.split('\n')
		.filter((line) => /^(Thread |#)/.test(line))
		.join('\n');
}

/**
 * Evidence about the renderer when a page stops responding to Playwright. The test is already
 * failing, so every step is bounded and a failing step only drops its own field.
 */
async function rendererEvidence(page: Page, probe: Probe, testInfo: TestInfo) {
	const raw = await rendererAnswer(
		probe.cdp,
		'document.readyState + (document.documentElement.hasAttribute("data-hydrated") ? " hydrated" : " not hydrated")',
		2000,
	);
	// Playwright's visible/stable checks wait on animation frames, as does any repaint.
	const frames = await rendererAnswer(
		probe.cdp,
		'new Promise((resolve) => { requestAnimationFrame(() => resolve("frames run")); setTimeout(() => resolve("no animation frame within 1 s"), 1000); })',
		2500,
	);
	const browser = await page.context().browser()?.newBrowserCDPSession();
	if (!browser) return { raw, frames };
	try {
		const cpu = await within(processCpu(browser), 5000).catch(() => undefined);
		const renderers = (cpu ?? []).filter((process) => process.type === 'renderer');
		const trace = await stallTrace(browser, 3000).catch(() => undefined);
		let tracePath: string | undefined;
		if (trace) {
			tracePath = testInfo.outputPath('stall-trace.json.gz');
			await writeFile(tracePath, gzipSync(trace.raw));
			await testInfo.attach('stall-trace.json.gz', {
				path: tracePath,
				contentType: 'application/gzip',
			});
		}
		const pids = renderers.map((process) => process.pid);
		// The test's own renderer is the one still using CPU, or the only one left.
		const busiest = [...renderers].sort((a, b) => b.cpu - a.cpu)[0]?.pid;
		return {
			raw,
			frames,
			cpu,
			trace: trace ? summarizeTrace(trace.events, new Set(pids)) : 'trace unavailable',
			native: await nativeStacks(busiest).catch((error: unknown) => String(error)),
		};
	} finally {
		await browser.detach().catch(() => undefined);
	}
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
	const renderer =
		testInfo.status === 'timedOut' || answer === undefined
			? await rendererEvidence(page, probe, testInfo).catch((error: unknown) => String(error))
			: undefined;
	// A file in the test's output folder travels with CI's uploaded failure evidence.
	const path = testInfo.outputPath('request-probe.json');
	await writeFile(path, JSON.stringify({ ...summary, stack, renderer, rows }, null, 1));
	await testInfo.attach('request-probe.json', { path, contentType: 'application/json' });
	if (open.length || answer === undefined || renderer) {
		const top = stack
			?.slice(0, 3)
			.map(
				(frame) =>
					`${frame.functionName || '(anonymous)'} ${frame.url}:${frame.line}:${frame.column}`,
			);
		const brief =
			typeof renderer === 'object'
				? {
						raw: renderer.raw,
						frames: renderer.frames,
						scheduler: Array.isArray(renderer.trace)
							? renderer.trace.map((thread) => thread.scheduler)
							: renderer.trace,
					}
				: renderer;
		console.log(
			`request probe (${testInfo.title}): ${JSON.stringify({ ...summary, top, renderer: brief })}`,
		);
	}
}

/**
 * On an unexpected result, attach every request of the test's page and whether Chromium sent it.
 * When the page thread does not answer, also attach where its JavaScript is running. When the test
 * timed out, also attach the renderer's state: whether it answers DevTools directly, whether it
 * still runs animation frames, its CPU use, a short compositor trace and, where possible, native
 * stacks, so a stalled page names the stage that stopped.
 */
export function probeRequests(test: TestType<{ page: Page }, object>): void {
	test.beforeEach(async ({ page }) => startProbe(page));
	test.afterEach(async ({ page }, testInfo) => reportProbe(page, testInfo));
}
