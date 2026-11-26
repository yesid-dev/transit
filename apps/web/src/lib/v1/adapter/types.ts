import type { LiveTripScope } from '#lib/live/captureSnapshot.ts';
import type { Manifest } from '#lib/v1/schemas/manifest.ts';

export interface AdapterCtx {
	readonly providerId?: string;
	fetch?: typeof fetch;
	tripScope?: LiveTripScope | null;
	captureFetch?: (city: string) => Promise<Response | null>;
	onResponseHeaders?: (headers: Headers) => void;
	requestCache?: RequestCache;
	manifest?: Manifest;
	cache?: Map<string, unknown>;
	signal?: AbortSignal;
}
