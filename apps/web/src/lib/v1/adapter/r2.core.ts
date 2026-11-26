import { v1Provider } from '#lib/v1/config.ts';
import { browserAdapterManifest } from './browserManifest';
import type { AdapterCtx } from './types';

export function fetchOf(ctx?: AdapterCtx): typeof fetch {
	return ctx?.fetch ?? fetch;
}

export function providerOf(ctx?: AdapterCtx): string {
	return (
		ctx?.providerId ?? ctx?.manifest?.provider ?? browserAdapterManifest()?.provider ?? v1Provider()
	);
}
