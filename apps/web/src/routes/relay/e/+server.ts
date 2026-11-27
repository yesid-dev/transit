// Plausible events arrive here from Transit's own address, so blockers of plausible.io don't drop
// them. The relay forwards each one to Plausible once, with the visitor's IP and user agent.

import * as env from '$app/env/public';
import { sanitizeAnalyticsUrl } from '@yesid/analytics/client';
import { RELAY_MAX_BODY_BYTES, relayAnalyticsEvent } from '@yesid/analytics/relay';
import { ANALYTICS_DIMENSIONS, ANALYTICS_EVENTS } from '#lib/site/analytics.ts';
import { publishedNetwork } from '#lib/site/providerDisplay.ts';
import { admitTelemetry, readTelemetryJson } from '#lib/server/telemetry.ts';
import type { RequestHandler } from './$types';

export const prerender = false;

const eventNames = new Set<string>(['pageview', ...ANALYTICS_EVENTS]);
const allowed = (values: readonly string[], value: unknown): value is string =>
	typeof value === 'string' && values.includes(value);
const reply = (status: number) =>
	new Response(null, { status, headers: { 'cache-control': 'no-store' } });

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	// Previews and local builds measure nothing, so they have nothing to relay.
	const domain = env.PUBLIC_PLAUSIBLE_DOMAIN;
	const site = new URL(request.url);
	if (!domain || (site.hostname !== domain && !site.hostname.endsWith(`.${domain}`)))
		return reply(404);
	const clientAddress = getClientAddress();
	const denied = await admitTelemetry('relay', clientAddress);
	if (denied) return denied;

	const body = await readTelemetryJson(request, RELAY_MAX_BODY_BYTES);
	if ('error' in body) return reply(body.error === 'payload_too_large' ? 413 : 400);
	const event = transitEvent(body.value, site, domain);
	if (!event) return reply(400);
	const headers = new Headers();
	for (const name of ['user-agent', 'cf-connecting-ip']) {
		const value = request.headers.get(name);
		if (value !== null) headers.set(name, value);
	}
	const forwarded = new Request(request.url, {
		method: 'POST',
		headers,
		body: JSON.stringify(event),
		signal: request.signal,
	});
	return relayAnalyticsEvent(forwarded, { domain, clientAddress });
};

function transitEvent(input: unknown, site: URL, domain: string) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
	const { n, d, u, r, p } = input as Record<string, unknown>;
	if (typeof n !== 'string' || !eventNames.has(n) || d !== domain || typeof u !== 'string')
		return null;
	const page = httpUrl(u);
	if (!page || page.origin !== site.origin) return null;
	const props: Record<string, string> = {};
	if (p && typeof p === 'object' && !Array.isArray(p)) {
		const { locale, provider, kind, placement } = p as Record<string, unknown>;
		if (allowed(ANALYTICS_DIMENSIONS.locale, locale)) props.locale = locale;
		if (typeof provider === 'string' && publishedNetwork(provider)) props.provider = provider;
		if (n === 'Search Result' && allowed(ANALYTICS_DIMENSIONS.kind, kind)) props.kind = kind;
		if (
			(n === 'Portfolio Click' || n === 'Repo Click') &&
			allowed(ANALYTICS_DIMENSIONS.placement, placement)
		)
			props.placement = placement;
	}
	const referrer = typeof r === 'string' ? httpUrl(r) : null;
	return {
		n,
		d,
		u: sanitizeAnalyticsUrl(page),
		r: referrer ? `${referrer.origin}/` : null,
		p: props,
	};
}

function httpUrl(value: string): URL | null {
	try {
		const url = new URL(value);
		if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
		return url;
	} catch {
		return null;
	}
}
