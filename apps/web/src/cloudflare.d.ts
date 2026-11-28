declare module 'cloudflare:workers' {
	export const env: {
		ASSETS?: { fetch(request: Request): Promise<Response> };
		QUESTION_PROXY?: { fetch(request: Request): Promise<Response> };
		QUESTION_FIXTURE_ORIGIN?: string;
		WEB_VITALS?: {
			writeDataPoint(point: {
				indexes?: string[];
				blobs?: (string | null)[];
				doubles?: number[];
			}): void;
		};
		GEOCODE_RATE_LIMITER?: {
			limit(options: { key: string }): Promise<{ success: boolean }>;
		};
		GEOCODE_SHARED_RATE_LIMITER?: {
			limit(options: { key: string }): Promise<{ success: boolean }>;
		};
		TELEMETRY_RATE_LIMITER?: {
			limit(options: { key: string }): Promise<{ success: boolean }>;
		};
		[key: string]: unknown;
	};
	export function waitUntil(promise: Promise<unknown>): void;
}
