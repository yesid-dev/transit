import type { GeocodedLocation, GeocodePrecision, GeocodeArea } from './types';
import { isInsideBounds } from './types';
import { foldDiacritics } from '#lib/search/normalize.ts';

export type { GeocodedLocation, GeocodePrecision } from './types';

export type GeocodeFetcher = (input: URL, init?: RequestInit) => Promise<Response>;

/** Geo.ca could not answer (HTTP, network or payload failure): not the same as finding nothing. */
export class GeocodeUnavailable extends Error {
	constructor(readonly reason: 'unavailable' | 'timeout' | 'cancelled' = 'unavailable') {
		super(`geocoder_${reason}`);
		this.name = 'GeocodeUnavailable';
	}
}

const GEO_CA_KEYS = 'locate,nominatim,fsa,geonames';
const GEO_CA_DEADLINE_MS = 4_000;
const CANADIAN_POSTAL_CODE_RE =
	/\b([ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z])\s*(\d[ABCEGHJ-NPRSTV-Z]\d)\b/i;

interface GeoCaResult {
	key?: unknown;
	name?: unknown;
	category?: unknown;
	province?: unknown;
	lat?: unknown;
	lng?: unknown;
	tag?: unknown;
}

interface RankedLocation {
	location: GeocodedLocation;
	score: number;
}

export function geoCaSearchUrl(query: string, area: GeocodeArea): URL {
	const url = new URL('https://geolocator.api.geo.ca/');
	url.searchParams.set('q', withAreaContext(normalizeAddressIntentInQuery(query), area.context));
	url.searchParams.set('lang', area.lang);
	url.searchParams.set('keys', GEO_CA_KEYS);
	return url;
}

export async function geocode(
	query: string,
	area: GeocodeArea,
	fetcher: GeocodeFetcher = fetch,
	signal?: AbortSignal,
): Promise<GeocodedLocation | null> {
	const [first] = await geocodeSuggestions(query, area, fetcher, 1, signal);
	return first ?? null;
}

export async function geocodeSuggestions(
	query: string,
	area: GeocodeArea,
	fetcher: GeocodeFetcher = fetch,
	limit = 5,
	signal?: AbortSignal,
): Promise<GeocodedLocation[]> {
	if (!query.trim() || limit <= 0) return [];

	return (await geocodeGeoCa(query, area, fetcher, signal)).slice(0, limit);
}

async function geocodeGeoCa(
	query: string,
	area: GeocodeArea,
	fetcher: GeocodeFetcher,
	caller?: AbortSignal,
): Promise<GeocodedLocation[]> {
	const deadline = AbortSignal.timeout(GEO_CA_DEADLINE_MS);
	const signal = caller ? AbortSignal.any([caller, deadline]) : deadline;
	let payload: unknown;
	try {
		signal.throwIfAborted();
		const response = await fetcher(geoCaSearchUrl(query, area), {
			signal,
			headers: {
				accept: 'application/json',
				'accept-language': `${area.lang}-CA,${area.lang};q=0.8`,
				'user-agent': 'transit1.yesid.dev citizen map (https://transit1.yesid.dev)',
			},
		});
		if (!response.ok) {
			void response.body?.cancel().catch(() => {});
			throw new GeocodeUnavailable();
		}
		payload = await response.json();
		signal.throwIfAborted();
	} catch {
		throw new GeocodeUnavailable(
			caller?.aborted ? 'cancelled' : deadline.aborted ? 'timeout' : 'unavailable',
		);
	}
	if (!Array.isArray(payload)) throw new GeocodeUnavailable();

	return rankedGeoCaLocations(query, payload, area.bbox);
}

function rankedGeoCaLocations(
	query: string,
	payload: unknown[],
	bbox: readonly number[],
): GeocodedLocation[] {
	const ranked: RankedLocation[] = [];
	let hasValidRow = false;
	for (const item of payload) {
		if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
		const result = item as GeoCaResult;
		const lat = coordinate(result.lat);
		const lon = coordinate(result.lng);
		if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180)
			continue;
		hasValidRow = true;
		if (!isInsideBounds(lat, lon, bbox)) continue;

		const label = typeof result.name === 'string' ? result.name : query.trim();
		const category = typeof result.category === 'string' ? result.category : '';
		const key = typeof result.key === 'string' ? result.key : '';
		const tags = Array.isArray(result.tag)
			? result.tag.filter((tag): tag is string => typeof tag === 'string')
			: [];
		const precision = geoCaPrecision(label, category, tags);
		ranked.push({
			location: {
				lat,
				lon,
				label,
				source: 'geo_ca',
				precision,
			},
			score: precisionScore(precision) + geoCaSourceScore(key) + geoCaRelevanceScore(query, label),
		});
	}

	if (payload.length && !hasValidRow) throw new GeocodeUnavailable();
	return rankedLocations(ranked);
}

function coordinate(value: unknown): number {
	if (typeof value === 'number') return value;
	return typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
}

function rankedLocations(ranked: RankedLocation[]): GeocodedLocation[] {
	return ranked
		.sort((a, b) => b.score - a.score)
		.map((item) => item.location)
		.filter(uniqueLocation);
}

function uniqueLocation(
	location: GeocodedLocation,
	index: number,
	locations: GeocodedLocation[],
): boolean {
	const key = locationKey(location);
	return locations.findIndex((item) => locationKey(item) === key) === index;
}

function locationKey(location: GeocodedLocation): string {
	return `${location.lat.toFixed(6)},${location.lon.toFixed(6)}:${normalizeSearchText(location.label)}`;
}

function geoCaPrecision(
	label: string,
	category: string,
	tags: readonly string[],
): GeocodePrecision {
	const normalizedCategory = category.toLowerCase();
	const normalizedLabel = normalizeSearchText(label);
	const tagText = tags.join(' ').toLowerCase();
	if (
		normalizedCategory.includes('building') ||
		tagText.includes('building') ||
		tagText.includes('interpolated_position') ||
		(/^\d+\s/.test(label) && normalizedCategory.includes('street'))
	) {
		return 'address';
	}
	if (
		normalizedCategory.includes('street') ||
		normalizedCategory.includes('intersection') ||
		hasStreetWord(normalizedLabel)
	) {
		return 'street';
	}
	if (normalizedCategory.includes('postal')) return 'postal';
	if (
		normalizedCategory.includes('neighbourhood') ||
		normalizedCategory.includes('neighborhood') ||
		normalizedCategory.includes('district') ||
		normalizedCategory.includes('borough')
	) {
		return 'neighbourhood';
	}
	return 'place';
}

function hasStreetWord(value: string): boolean {
	return /\b(?:rue|street|saint|sainte|boulevard|avenue|chemin|road|route)\b/.test(value);
}

function precisionScore(precision: GeocodePrecision): number {
	switch (precision) {
		case 'address':
			return 100;
		case 'street':
			return 80;
		case 'neighbourhood':
			return 65;
		case 'postal':
			return 50;
		case 'place':
			return 35;
	}
}

function geoCaSourceScore(key: string): number {
	switch (key.toLowerCase()) {
		case 'locate':
			return 8;
		case 'nominatim':
			return 6;
		case 'fsa':
			return -8;
		case 'geonames':
			return -18;
		default:
			return 0;
	}
}

function geoCaRelevanceScore(query: string, label: string): number {
	const postalCode = extractCanadianPostalCode(query);
	let score = 0;
	if (postalCode && normalizeSearchText(label).includes(normalizeSearchText(postalCode)))
		score += 18;
	if (/^\s*\d+/.test(query) && /^\s*\d+/.test(label)) score += 14;
	return score;
}

function withAreaContext(query: string, context: string): string {
	const trimmed = normalizePostalCodeInQuery(query.trim());
	if (!trimmed) return '';

	const lower = foldDiacritics(trimmed);
	const parts = [trimmed];
	for (const part of [...context.split(',').map((part) => part.trim()), 'Canada']) {
		if (part && !lower.includes(foldDiacritics(part))) parts.push(part);
	}
	return parts.join(' ');
}

function normalizeAddressIntentInQuery(query: string): string {
	return normalizePostalCodeInQuery(query.trim())
		.replace(/[.]/g, ' ')
		.replace(/\b(?:boul|boulv|blvd|bd)\b/gi, 'boulevard')
		.replace(/\b(?:av|ave)\b/gi, 'avenue')
		.replace(/\bch\b/gi, 'chemin')
		.replace(/\bste\b/gi, 'sainte')
		.replace(/\b(rue|boulevard|avenue|chemin)\s+st\b/gi, '$1 saint')
		.replace(/\bst\s*$/gi, 'street')
		.replace(/\bst\b/gi, 'saint')
		.replace(/\s+/g, ' ')
		.trim();
}

function normalizePostalCodeInQuery(query: string): string {
	return query.replace(CANADIAN_POSTAL_CODE_RE, (_, fsa: string, ldu: string) => {
		return `${fsa.toUpperCase()} ${ldu.toUpperCase()}`;
	});
}

function extractCanadianPostalCode(query: string): string | null {
	const match = query.match(CANADIAN_POSTAL_CODE_RE);
	if (!match) return null;
	return `${match[1]?.toUpperCase()} ${match[2]?.toUpperCase()}`;
}

const normalizeSearchText = foldDiacritics;
