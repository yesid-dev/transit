import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import config from './wrangler.json' with { type: 'json' };

const require = createRequire(import.meta.url);
const wrangler = require.resolve('wrangler/package.json');
// Use the same pinned workerd and asset handling as Wrangler.
const { Miniflare, convertV4MiniflareOptions, Log, LogLevel } = createRequire(wrangler)('miniflare');

// DIAGNOSTIC (do not merge): log every answered request with a timestamp beside the failure evidence.
class FileLog extends Log {
	log(message) {
		const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
		const line = `${new Date().toISOString()} ${message.replace(ansi, '')}\n`;
		const directory = resolve(import.meta.dirname, '../test-results');
		try {
			mkdirSync(directory, { recursive: true });
			appendFileSync(join(directory, `worker-requests-${port}.log`), line);
		} catch {
			// Diagnostic logging must never break the test server.
		}
	}
}

const port = Number(process.env.TRANSIT_E2E_PORT ?? 4317);
const fixture = `http://127.0.0.1:${process.env.TRANSIT_E2E_DATA_PORT ?? 4318}`;
const bundle = resolve(import.meta.dirname, `../.svelte-kit/e2e-worker-${port}`);
execFileSync(
	process.execPath,
	[
		join(dirname(wrangler), 'bin/wrangler.js'),
		'deploy',
		'--dry-run',
		'--config',
		'wrangler.json',
		'--outdir',
		bundle,
	],
	{ cwd: import.meta.dirname, stdio: 'inherit' },
);

// Wrangler dev's HTTP proxy decodes and recompresses gzip, losing the Worker flush boundaries.
const worker = new Miniflare(
	convertV4MiniflareOptions({
		host: '127.0.0.1',
		port,
		...(process.env.CI ? { log: new FileLog(LogLevel.INFO) } : {}),
		workers: [
			{
				name: config.name,
				modules: true,
				modulesRoot: bundle,
				scriptPath: join(bundle, 'fixture-worker.js'),
				compatibilityDate: config.compatibility_date,
				compatibilityFlags: config.compatibility_flags,
				assets: {
					directory: resolve(import.meta.dirname, config.assets.directory),
					binding: config.assets.binding,
					routerConfig: { has_user_worker: true },
				},
				bindings: {
					...config.vars,
					QUESTION_FIXTURE_ORIGIN: fixture,
				},
			},
		],
	}),
);
process.once('SIGINT', () => worker.dispose());
process.once('SIGTERM', () => worker.dispose());
try {
	console.log(`Test Worker ready at ${await worker.ready}`);
} catch (error) {
	await worker.dispose();
	throw error;
}
