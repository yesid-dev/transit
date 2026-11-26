import { describe, expect, it } from 'vitest';
import config from '../../vite.config';
import type { Rolldown, UserConfig } from 'vite';

describe('vite production chunk contract', () => {
	it('keeps the heavy map runtime isolated behind the map route', async () => {
		const client = await resolveProductionConfig(false);
		const build = Array.isArray(client) ? client[0]?.build : client.build;
		const output = build?.rollupOptions?.output;
		const firstOutput = Array.isArray(output) ? output[0] : output;
		const clientOutput = client.environments?.client?.build?.rollupOptions?.output;
		const firstClientOutput = Array.isArray(clientOutput) ? clientOutput[0] : clientOutput;
		const splitting = firstClientOutput?.codeSplitting;
		const groups = typeof splitting === 'object' ? splitting.groups : undefined;
		const mapGroup = groups?.find(
			(group: Rolldown.CodeSplittingGroup) => group.name === 'vendor-maplibre',
		);
		const chunkNameFor = (id: string) =>
			typeof mapGroup?.test === 'function' && mapGroup.test(id) ? mapGroup.name : undefined;

		expect(build?.chunkSizeWarningLimit).toBe(1100);
		expect(typeof mapGroup?.test).toBe('function');
		expect(firstOutput?.codeSplitting).toBeUndefined();
		expect(firstClientOutput?.codeSplitting).toMatchObject({ minSize: 1_500 });
		if (typeof chunkNameFor !== 'function') return;

		expect(chunkNameFor('/repo/node_modules/maplibre-gl/dist/maplibre-gl.mjs')).toBe(
			'vendor-maplibre',
		);
		expect(chunkNameFor('/repo/node_modules/pmtiles/dist/index.js')).toBe('vendor-maplibre');
		expect(chunkNameFor('/repo/node_modules/maplibre-gl/dist/maplibre-gl.css')).toBeUndefined();
		expect(chunkNameFor('/repo/src/lib/features/map/MapHero.svelte')).toBeUndefined();
	});

	it('does not emit the map vendor chunk for the SSR build', async () => {
		const ssr = await resolveProductionConfig(true);
		const build = Array.isArray(ssr) ? ssr[0]?.build : ssr.build;
		const output = build?.rollupOptions?.output;
		const firstOutput = Array.isArray(output) ? output[0] : output;

		expect(firstOutput?.manualChunks).toBeUndefined();
		expect(firstOutput?.codeSplitting).toBeUndefined();
	});

	it('keeps production chunk merging out of the Vitest environment', async () => {
		const testConfig = await resolveConfig(false);
		const output = testConfig.build?.rollupOptions?.output;
		const firstOutput = Array.isArray(output) ? output[0] : output;

		expect(firstOutput?.codeSplitting).toBeUndefined();
		expect(testConfig.environments?.client).toBeUndefined();
	});
});

it('does not register a local legacy snapshot proxy', async () => {
	const config = await resolveConfig(false, 'serve');
	expect(config.server?.proxy?.['/data']).toBeUndefined();
});

async function resolveConfig(
	isSsrBuild: boolean,
	command: 'build' | 'serve' = 'build',
): Promise<UserConfig> {
	if (typeof config === 'function') {
		const resolved = await config({
			command,
			mode: 'production',
			isSsrBuild,
			isPreview: false,
		});
		return Array.isArray(resolved) ? resolved[0] : resolved;
	}
	return Array.isArray(config) ? config[0] : config;
}

async function resolveProductionConfig(isSsrBuild: boolean): Promise<UserConfig> {
	const vitest = process.env.VITEST;
	delete process.env.VITEST;
	try {
		return await resolveConfig(isSsrBuild);
	} finally {
		if (vitest === undefined) delete process.env.VITEST;
		else process.env.VITEST = vitest;
	}
}
