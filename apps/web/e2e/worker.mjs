import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fixtureWorkerBindings } from './fixture-worker-bindings.js';
import config from './wrangler.json' with { type: 'json' };

const require = createRequire(import.meta.url);
const wrangler = require.resolve('wrangler/package.json');
// Use the same pinned workerd and asset handling as Wrangler.
const { Miniflare, convertV4MiniflareOptions } = createRequire(wrangler)('miniflare');

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

const application = {
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
};
const fixtureWorkers = Object.entries(fixtureWorkerBindings).map(([scope, binding]) => ({
	binding,
	name: `${config.name}-${scope}`,
}));
const serviceBindings = Object.fromEntries(
	fixtureWorkers.map(({ binding, name }) => [binding, name]),
);

// Wrangler dev's HTTP proxy decodes and recompresses gzip, losing the Worker flush boundaries.
const worker = new Miniflare(
	convertV4MiniflareOptions({
		host: '127.0.0.1',
		port,
		workers: [
			{
				...application,
				name: config.name,
				serviceBindings,
			},
			...fixtureWorkers.map(({ name }) => ({ ...application, name })),
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
