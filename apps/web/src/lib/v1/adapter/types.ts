import type { FetchFn } from '#lib/v1/http.ts';
import type { LiveTripScope } from '#lib/live/captureSnapshot.ts';
import type { Manifest } from '#lib/v1/schemas/manifest.ts';

export interface AdapterCtx {
	readonly providerId?: string;
	fetch?: FetchFn;
	tripScope?: LiveTripScope | null;
	captureFetch?: (city: string) => Promise<Response | null>;
	scheduleFetch?: (city: string) => Promise<Response>;
	onResponseHeaders?: (headers: Headers) => void;
	requestCache?: RequestCache;
	manifest?: Manifest;
	cache?: Map<string, unknown>;
	signal?: AbortSignal;
	freshHistoryParent?: boolean;
}
