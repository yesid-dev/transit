import { env as cloudflareEnv } from 'cloudflare:workers';
import { PUBLIC_VITALS_ENABLED } from '$app/env/public';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { admitTelemetry, readTelemetryJson } from '#lib/server/telemetry.ts';
import { PATHS } from '#lib/site/seoFiles.ts';
import {
	MAX_VITALS_BODY_BYTES,
	parseVitalsBeacon,
	type VitalsSample,
} from '@yesid/analytics/vitals';

export const prerender = false;

const NO_CONTENT = () => new Response(null, { status: 204 });
const publicPaths = new Set<string>([...PATHS, '/download', '/metrics/archive']);
const connectionTypes = new Set(['slow-2g', '2g', '3g', '4g']);

export const POST: RequestHandler = async ({ request }) => {
	const dataset = cloudflareEnv.WEB_VITALS;
	if (PUBLIC_VITALS_ENABLED !== 'true' || !dataset) return NO_CONTENT();
	const denied = await admitTelemetry('vitals', request.headers.get('cf-connecting-ip'));
	if (denied) return denied;

	const body = await readTelemetryJson(request, MAX_VITALS_BODY_BYTES);
	if ('error' in body)
		return json(body, { status: body.error === 'payload_too_large' ? 413 : 400 });
	const samples = parseVitalsBeacon(body.value);
	if (samples === null) {
		return json({ error: 'invalid_shape' }, { status: 400 });
	}
	try {
		for (const sample of samples) {
			const route = routeTemplate(sample.path);
			if (route) dataset.writeDataPoint(toDataPoint(sample, route));
		}
	} catch {
		// Analytics Engine writes are best effort; still return 204.
	}

	return NO_CONTENT();
};

function routeTemplate(value: string): string | null {
	if (/[?#\\\p{Cc}]/u.test(value)) return null;
	const path = value.replace(/^\/fr(?=\/|$)/u, '').replace(/\/$/u, '') || '/';
	if (publicPaths.has(path)) return path;
	const detail = /^\/(lines|stop|vehicle|trip|departure)\/[^/]+$/u.exec(path);
	if (!detail) return null;
	return `/${detail[1]}/[${detail[1] === 'departure' ? 'key' : 'id'}]`;
}

function toDataPoint(
	sample: VitalsSample,
	route: string,
): {
	indexes: string[];
	blobs: (string | null)[];
	doubles: number[];
} {
	return {
		indexes: [sample.name],
		blobs: [
			sample.name,
			sample.rating,
			route,
			sample.navType,
			sample.conn && connectionTypes.has(sample.conn) ? sample.conn : null,
		],
		doubles: [sample.value],
	};
}
