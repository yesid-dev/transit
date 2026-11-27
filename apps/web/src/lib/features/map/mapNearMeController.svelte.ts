import type { GeocodedLocation, GeocodeSuggestion } from '#lib/geocode/types.ts';
import { isInsideBounds } from '#lib/geocode/types.ts';
import type { Locale } from '#lib/i18n/index.ts';
import type { MapNearTarget } from '#lib/search/mapNear.ts';
import { parseCoordinateQuery } from './mapNearMe';

export type NearMeOrigin = MapNearTarget;

export interface NearMeTranslations {
	readonly nearMeUseLocation: string;
	readonly nearMeError: string;
	readonly nearMeLookupUnavailable?: string;
	readonly nearMeGeoDenied: string;
	readonly nearMeGeoTimeout: string;
	readonly nearMeGeoUnavailable: string;
	readonly nearMeGeoInsecure: string;
}

export interface MapNearMeControllerDependencies {
	readonly providerId: string;
	readonly bbox: readonly number[];
	readonly locale: Locale;
	readonly goto: (target: string, options: { replace: true; reset: false }) => unknown;
	readonly currentUrl: () => URL;
	readonly readTarget: (searchParams: URLSearchParams) => NearMeOrigin | null;
	readonly targetKey: (origin: NearMeOrigin) => string;
	readonly buildTargetSearch: (
		current: URLSearchParams,
		pathname: string,
		origin: NearMeOrigin,
	) => string;
	readonly clearTargetSearch: (current: URLSearchParams, pathname: string) => string;
	readonly focusOrigin: (origin: NearMeOrigin) => void;
	readonly onOrigin?: () => void;
	readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
	readonly getGeolocation: () => Geolocation | null;
	readonly isSecureContext: () => boolean;
	readonly translations: NearMeTranslations;
}

export interface MapNearMeController {
	get open(): boolean;
	set open(next: boolean);
	get query(): string;
	set query(next: string);
	get loading(): boolean;
	get error(): string | null;
	get origin(): NearMeOrigin | null;
	get usingDeviceLocation(): boolean;
	get urlKey(): string;
	dispose(): void;
	setOrigin(origin: NearMeOrigin, options?: { syncUrl?: boolean; urlBacked?: boolean }): void;
	syncFromUrl(searchParams: URLSearchParams): void;
	refocus(): void;
	clear(): void;
	useLocation(): void;
	search(event: SubmitEvent): Promise<void>;
	selectSuggestion(result: GeocodeSuggestion): Promise<void>;
}

const NAVIGATION_OPTIONS = {
	replace: true,
	reset: false,
} as const;

export function createMapNearMeController(
	dependencies: MapNearMeControllerDependencies,
): MapNearMeController {
	let open = $state(false);
	let query = $state('');
	let loading = $state(false);
	let error = $state<string | null>(null);
	let origin = $state<NearMeOrigin | null>(null);
	let urlKey = $state('');
	let disposed = false;
	const lifetime = new AbortController();
	let urlBacked = $state(true);
	let requestVersion = 0;
	const isCurrent = (version: number) => !disposed && version === requestVersion;

	function syncToUrl(nextOrigin: NearMeOrigin): void {
		if (disposed) return;
		const url = dependencies.currentUrl();
		urlKey = dependencies.targetKey(nextOrigin);
		void dependencies.goto(
			dependencies.buildTargetSearch(url.searchParams, url.pathname, nextOrigin),
			NAVIGATION_OPTIONS,
		);
	}

	function setOrigin(
		nextOrigin: NearMeOrigin,
		{ syncUrl = true, urlBacked: nextUrlBacked = true } = {},
	): void {
		if (disposed) return;
		if (!isInsideBounds(nextOrigin.lat, nextOrigin.lon, dependencies.bbox)) {
			error = dependencies.translations.nearMeError;
			return;
		}
		origin = nextOrigin;
		error = null;
		urlBacked = nextUrlBacked;
		if (syncUrl) syncToUrl(nextOrigin);
		dependencies.focusOrigin(nextOrigin);
		dependencies.onOrigin?.();
	}

	function syncFromUrl(searchParams: URLSearchParams): void {
		if (disposed) return;
		const nearTarget = dependencies.readTarget(searchParams);
		if (!nearTarget) {
			urlKey = '';
			if (urlBacked) origin = null;
			return;
		}

		const key = dependencies.targetKey(nearTarget);
		if (urlKey === key) return;

		urlKey = key;
		open = true;
		query = '';
		setOrigin(nearTarget, { syncUrl: false });
	}

	function refocus(): void {
		if (disposed) return;
		if (origin) dependencies.focusOrigin(origin);
	}

	function clear(): void {
		if (disposed) return;
		requestVersion += 1;
		loading = false;
		origin = null;
		query = '';
		error = null;
		urlKey = '';
		urlBacked = true;
		const url = dependencies.currentUrl();
		void dependencies.goto(
			dependencies.clearTargetSearch(url.searchParams, url.pathname),
			NAVIGATION_OPTIONS,
		);
	}

	function useLocation(): void {
		if (disposed) return;
		const version = ++requestVersion;
		loading = false;
		open = true;
		if (!dependencies.isSecureContext()) {
			error = dependencies.translations.nearMeGeoInsecure;
			return;
		}
		const geolocation = dependencies.getGeolocation();
		if (!geolocation) {
			error = dependencies.translations.nearMeGeoUnavailable;
			return;
		}
		loading = true;
		error = null;
		geolocation.getCurrentPosition(
			(position) => {
				if (!isCurrent(version)) return;
				loading = false;
				setOrigin(
					{
						lat: position.coords.latitude,
						lon: position.coords.longitude,
						label: dependencies.translations.nearMeUseLocation,
						precision: 'place',
					},
					{ syncUrl: false, urlBacked: false },
				);
			},
			(geoError) => {
				if (!isCurrent(version)) return;
				loading = false;
				error =
					geoError.code === geoError.PERMISSION_DENIED
						? dependencies.translations.nearMeGeoDenied
						: geoError.code === geoError.TIMEOUT
							? dependencies.translations.nearMeGeoTimeout
							: dependencies.translations.nearMeGeoUnavailable;
			},
			{ enableHighAccuracy: true, timeout: 8_000, maximumAge: 60_000 },
		);
	}

	async function fetchLocation(url: string, version: number): Promise<GeocodedLocation | null> {
		const unavailable =
			dependencies.translations.nearMeLookupUnavailable ?? dependencies.translations.nearMeError;
		loading = true;
		error = null;
		try {
			const response = await dependencies.fetch(url, { signal: lifetime.signal });
			if (!isCurrent(version)) return null;
			if (!response.ok) {
				error = response.status === 404 ? dependencies.translations.nearMeError : unavailable;
				return null;
			}
			const result = (await response.json()) as GeocodedLocation;
			if (!isCurrent(version)) return null;
			return result;
		} catch {
			if (isCurrent(version)) error = unavailable;
			return null;
		} finally {
			if (isCurrent(version)) loading = false;
		}
	}

	async function resolveQuery(nextQuery: string): Promise<void> {
		const version = ++requestVersion;
		const result = await fetchLocation(
			`/api/geocode?provider=${encodeURIComponent(dependencies.providerId)}&lang=${dependencies.locale}&q=${encodeURIComponent(nextQuery)}`,
			version,
		);
		if (!result || !isCurrent(version)) return;
		query = result.label;
		setOrigin(result);
	}

	async function search(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (disposed) return;
		const nextQuery = query.trim();
		if (!nextQuery) return;

		const manual = parseCoordinateQuery(nextQuery, dependencies.bbox);
		if (manual) {
			requestVersion += 1;
			loading = false;
			setOrigin({ ...manual, label: nextQuery, precision: 'address' });
			return;
		}

		await resolveQuery(nextQuery);
	}

	async function selectSuggestion(result: GeocodeSuggestion): Promise<void> {
		if (disposed) return;
		requestVersion += 1;
		loading = false;
		query = result.label;
		setOrigin(result);
	}

	function dispose(): void {
		if (disposed) return;
		disposed = true;
		lifetime.abort();
		loading = false;
	}

	return {
		get open() {
			return open;
		},
		set open(next: boolean) {
			open = next;
		},
		get query() {
			return query;
		},
		set query(next: string) {
			if (query !== next && loading) {
				requestVersion += 1;
				loading = false;
			}
			if (query !== next) error = null;
			query = next;
		},
		get loading() {
			return loading;
		},
		get error() {
			return error;
		},
		get origin() {
			return origin;
		},
		get usingDeviceLocation() {
			return origin !== null && !urlBacked;
		},
		get urlKey() {
			return urlKey;
		},
		dispose,
		setOrigin,
		syncFromUrl,
		refocus,
		clear,
		useLocation,
		search,
		selectSuggestion,
	};
}
