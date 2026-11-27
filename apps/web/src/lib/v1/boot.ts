import { getContext, setContext } from 'svelte';
import { browser } from '$app/env';
import type { Locale } from '#lib/i18n/index.ts';
import type { Manifest } from '#lib/v1/schemas/manifest.ts';
import { installBrowserAdapterManifest } from '#lib/v1/adapter/browserManifest.ts';
import { resolveProvider } from './providers';
import { v1Provider } from './config';
import type { CityCatalog, PublicCity } from './schemas/providers';
import type { ApproximateLocation } from './requestLocation';

export interface V1Context {
	readonly manifest: Manifest;
	readonly labels: Record<string, string>;
	readonly lang: Locale;
	readonly provider?: PublicCity;
}

const RESOLVABLE_NAMESPACES = [
	'metric.',
	'status.',
	'severity.',
	'occupancy.',
	'methodology.',
] as const;

const KEY = Symbol.for('transit.v1.context');

export async function bootProvider(
	url: URL,
	loadCatalog: () => Promise<CityCatalog>,
	location?: ApproximateLocation | null,
	lastCatalog?: CityCatalog,
) {
	const requested = url.searchParams.getAll('provider');
	let defaultProviderId = v1Provider();
	let providerId = requested[0] ?? defaultProviderId;
	let provider: PublicCity | null = null;
	let providers: PublicCity[] = [];
	let cleaningVersion: number | undefined;
	let redirectHref: string | null = null;
	let discoveryError = false;
	let catalog: CityCatalog | undefined;
	try {
		catalog = await loadCatalog();
	} catch {
		discoveryError = true;
		catalog = lastCatalog;
	}
	if (catalog) {
		const selected = resolveProvider(url, catalog, location);
		defaultProviderId = catalog.default_provider;
		provider = selected.provider;
		providerId = provider.id;
		providers = catalog.providers;
		cleaningVersion = catalog.cleaning_version;
		if (!discoveryError && selected.url.href !== url.href) {
			redirectHref = selected.url.pathname + selected.url.search;
		}
	}
	return {
		providerId,
		defaultProviderId,
		provider,
		providers,
		...(cleaningVersion === undefined ? {} : { cleaningVersion }),
		discoveryError,
		redirectHref,
	};
}

export function resolveLabel(code: string, labels: Record<string, string>): string {
	if (!code) return code;
	const resolvable = RESOLVABLE_NAMESPACES.some((ns) => code.startsWith(ns));
	if (!resolvable) return code;
	const text = labels[code];
	return text !== undefined && text !== '' ? text : code;
}

export function setV1Context(reader: () => V1Context | undefined): void {
	setContext(KEY, reader);
	if (browser) installBrowserAdapterManifest(() => reader()?.manifest);
}

export function getV1Context(): V1Context;
export function getV1Context(optional: true): V1Context | undefined;
export function getV1Context(optional = false): V1Context | undefined {
	const reader = getContext<(() => V1Context | undefined) | undefined>(KEY);
	const context = reader?.();
	if (!context && !optional) {
		throw new Error(
			'[v1] getV1Context() called before setV1Context(), boot the v1 context in the root layout first.',
		);
	}
	return context;
}
