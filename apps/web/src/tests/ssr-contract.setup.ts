import { createServer } from 'vite';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
	export interface ProvidedContext {
		methodologySsr: string;
		detailSsr: { open: boolean; html: string }[];
	}
}

export default async function setup(project: TestProject) {
	async function prepareFixtures() {
		// The contracts exercise both the server and DOM builds. Reuse a single
		// SSR module graph for their HTML fixtures, with no browser mocks.
		const server = await createServer({
			configFile: 'vite.config.ts',
			appType: 'custom',
			logLevel: 'silent',
			optimizeDeps: { noDiscovery: true },
			server: { middlewareMode: true, ws: false, watch: null },
		});
		try {
			const { render } = (await server.ssrLoadModule(
				'svelte/server',
			)) as typeof import('svelte/server');
			const { createRawSnippet } = (await server.ssrLoadModule(
				'svelte',
			)) as typeof import('svelte');

			const { default: MetricsExplainer } = await server.ssrLoadModule(
				'/src/lib/features/metrics/MetricsExplainer.svelte',
			);
			project.provide('methodologySsr', render(MetricsExplainer).body);

			const { default: Detail } = await server.ssrLoadModule(
				'/src/lib/components/shared/Detail.svelte',
			);
			project.provide(
				'detailSsr',
				[false, true].map((open) => ({
					open,
					html: render(Detail, {
						props: {
							label: 'More',
							open,
							children: createRawSnippet(() => ({ render: () => '<p>Server analyst detail</p>' })),
						},
					}).body,
				})),
			);
		} finally {
			await server.close();
		}
	}

	await prepareFixtures();
	project.onTestsRerun(prepareFixtures);
}
