// @vitest-environment node

const workers = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock('cloudflare:workers', () => workers);
const flags = vi.hoisted(() => ({ PUBLIC_VITALS_ENABLED: 'true' }));
vi.mock('$app/env/public', () => flags);
import { describe, expect, it, vi } from 'vitest';
import { POST } from './+server';

type Handler = typeof POST;

const sample = {
	name: 'LCP',
	value: 1200,
	id: 'v3-1718900000000-1',
	rating: 'good',
	navType: 'navigate',
	path: '/lines/11',
	conn: '4g',
};

function event(opts: {
	body?: string | ReadableStream<Uint8Array>;
	binding?: unknown;
	contentLength?: string;
	enabled?: boolean;
	allowed?: boolean;
}): Parameters<Handler>[0] {
	flags.PUBLIC_VITALS_ENABLED = opts.enabled === false ? '' : 'true';
	const headers = new Headers({
		'content-type': 'application/json',
		'cf-connecting-ip': '192.0.2.14',
	});
	if (opts.contentLength !== undefined) headers.set('content-length', opts.contentLength);
	workers.env = {
		WEB_VITALS: opts.binding,
		TELEMETRY_RATE_LIMITER: { limit: async () => ({ success: opts.allowed !== false }) },
	};
	const request = new Request('https://transit.yesid.dev/api/vitals', {
		method: 'POST',
		headers,
		body: opts.body,
		duplex: 'half',
	} as RequestInit & { duplex: 'half' });
	return {
		request,
	} as unknown as Parameters<Handler>[0];
}

describe('/api/vitals POST handler', () => {
	it('204 no-op when the WEB_VITALS binding is absent (inert default)', async () => {
		const res = await POST(event({ body: JSON.stringify({ samples: [sample] }) }));
		expect(res.status).toBe(204);
		expect(await res.text()).toBe('');
	});

	it('writes one data point per sample when the binding is present', async () => {
		const writeDataPoint = vi.fn();
		const res = await POST(
			event({
				body: JSON.stringify({
					samples: [sample, { ...sample, name: 'CLS', value: 0.02, id: 'c-1' }],
				}),
				binding: { writeDataPoint },
			}),
		);
		expect(res.status).toBe(204);
		expect(writeDataPoint).toHaveBeenCalledTimes(2);

		const firstArg = writeDataPoint.mock.calls[0][0];
		expect(firstArg.indexes).toEqual(['LCP']);
		expect(firstArg.blobs).toEqual(['LCP', 'good', '/lines/[id]', 'navigate', '4g']);
		expect(firstArg.doubles).toEqual([1200]);
	});

	it('persists conn as null when absent (no PII, no undefined leak)', async () => {
		const writeDataPoint = vi.fn();
		const { conn, ...noConn } = sample;
		void conn;
		await POST(event({ body: JSON.stringify({ samples: [noConn] }), binding: { writeDataPoint } }));
		expect(writeDataPoint.mock.calls[0][0].blobs[4]).toBeNull();
	});

	it('400 on invalid JSON, never a 500', async () => {
		const res = await POST(event({ body: '{not json', binding: { writeDataPoint: vi.fn() } }));
		expect(res.status).toBe(400);
	});

	it('400 on a malformed envelope shape', async () => {
		const res = await POST(
			event({ body: JSON.stringify({ nope: true }), binding: { writeDataPoint: vi.fn() } }),
		);
		expect(res.status).toBe(400);
	});

	it('204 (quiet) when all samples are malformed — binding never called', async () => {
		const writeDataPoint = vi.fn();
		const res = await POST(
			event({ body: JSON.stringify({ samples: [{ name: 'FID' }] }), binding: { writeDataPoint } }),
		);
		expect(res.status).toBe(204);
		expect(writeDataPoint).not.toHaveBeenCalled();
	});

	it('413 when the body exceeds the byte cap', async () => {
		const huge = JSON.stringify({
			samples: [{ ...sample, path: '/' + 'a'.repeat(5000) }],
		});
		const res = await POST(event({ body: huge, binding: { writeDataPoint: vi.fn() } }));
		expect(res.status).toBe(413);
	});

	it('413 when content-length declares an oversized payload', async () => {
		const res = await POST(
			event({
				body: JSON.stringify({ samples: [sample] }),
				contentLength: '999999',
				binding: { writeDataPoint: vi.fn() },
			}),
		);
		expect(res.status).toBe(413);
	});

	it('enforces the UTF-8 byte cap while pulling chunks and cancels without buffering the rest', async () => {
		const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) =>
			controller.enqueue(new TextEncoder().encode('é'.repeat(1100))),
		);
		const cancel = vi.fn();
		const writeDataPoint = vi.fn();
		const body = new ReadableStream({ pull, cancel }, { highWaterMark: 0 });
		const response = await POST(event({ body, binding: { writeDataPoint } }));
		expect(response.status).toBe(413);
		expect(pull).toHaveBeenCalledTimes(2);
		expect(cancel).toHaveBeenCalledOnce();
		expect(writeDataPoint).not.toHaveBeenCalled();
	});

	it.each([
		[{ enabled: false }, 204],
		[{ allowed: false }, 429],
	] as const)('does not consume a disabled or unadmitted body', async (options, status) => {
		const pull = vi.fn();
		const writeDataPoint = vi.fn();
		const body = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
		const response = await POST(event({ ...options, body, binding: { writeDataPoint } }));
		expect(response.status).toBe(status);
		expect(pull).not.toHaveBeenCalled();
		expect(writeDataPoint).not.toHaveBeenCalled();
	});

	it('drops unmatched paths and keeps only fixed route and connection dimensions', async () => {
		const writeDataPoint = vi.fn();
		await POST(
			event({
				binding: { writeDataPoint },
				body: JSON.stringify({
					samples: [
						{ ...sample, path: '/fr/stop/identifier', conn: 'unexpected value' },
						{ ...sample, path: '/arbitrary/path' },
						{ ...sample, path: '/lines/11?q=search' },
					],
				}),
			}),
		);
		expect(writeDataPoint).toHaveBeenCalledOnce();
		expect(writeDataPoint.mock.calls[0][0].blobs).toEqual([
			'LCP',
			'good',
			'/stop/[id]',
			'navigate',
			null,
		]);
	});

	it('still 204 when writeDataPoint throws (best-effort RUM)', async () => {
		const writeDataPoint = vi.fn(() => {
			throw new Error('AE down');
		});
		const res = await POST(
			event({ body: JSON.stringify({ samples: [sample] }), binding: { writeDataPoint } }),
		);
		expect(res.status).toBe(204);
	});
});
