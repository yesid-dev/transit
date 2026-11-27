import { z } from 'zod';
import { resolveProvider } from '#lib/v1/providers.ts';
import { v1Provider } from '#lib/v1/config.ts';
import { CityCatalogSchema } from '#lib/v1/schemas/providers.ts';
import type { ApproximateLocation } from '#lib/v1/requestLocation.ts';
import { scheduleIndexSchema, type ScheduleEdition } from '#lib/search/searchIndex.ts';
import { query } from './engine.ts';
import { citiesQuestion, scheduleQuestion } from './engineQuestion.ts';

const catalogSchema = CityCatalogSchema.safeExtend({
	answer_revision: z
		.string()
		.regex(/^[a-f0-9]{16}$/)
		.optional()
		.catch(undefined),
});
type Catalog = z.infer<typeof catalogSchema>;
const CATALOG_REFRESH_MS = 30_000;
const TIMETABLE_REFRESH_MS = 60 * 60 * 1000;
const BOOT_BUDGET_MS = 1500;

let catalog: Catalog | undefined;
let catalogRead: Promise<void> | undefined;
let catalogRetryAt = 0;
let discoveryFailed = false;
const timetables = new Map<
	string,
	{
		edition: ScheduleEdition | null;
		revision?: string;
		retryAt: number;
		read?: Promise<void>;
	}
>();

export async function withinBootBudget<T>(
	work: Promise<T>,
	started: number,
): Promise<T | undefined> {
	const remaining = BOOT_BUDGET_MS - (performance.now() - started);
	if (remaining <= 0) return undefined;
	let cancel: (() => void) | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<undefined>((resolve) => {
				const timer = setTimeout(resolve, remaining);
				cancel = () => clearTimeout(timer);
			}),
		]);
	} finally {
		cancel?.();
	}
}

export function readTimetable({
	url,
	location,
	visitorIp,
	needsSchedule,
	waitUntil,
}: {
	url: URL;
	location?: ApproximateLocation | null;
	visitorIp: string | null;
	needsSchedule: boolean;
	waitUntil?: (work: Promise<void>) => void;
}) {
	const started = performance.now();
	if (!catalogRead && Date.now() >= catalogRetryAt) {
		catalogRead = query(citiesQuestion, catalogSchema, visitorIp)
			.then((result) => {
				discoveryFailed = result.kind !== 'answer';
				if (result.kind !== 'answer') return;
				catalog = result.answer;
				for (const city of timetables.keys()) {
					if (!catalog.providers.some(({ id }) => id === city)) timetables.delete(city);
				}
			})
			.finally(() => {
				catalogRetryAt = Date.now() + CATALOG_REFRESH_MS;
				catalogRead = undefined;
			});
		waitUntil?.(catalogRead);
	}

	const lastCatalog = catalog;
	const likelyCity = lastCatalog
		? resolveProvider(url, lastCatalog, location).provider.id
		: v1Provider(url);

	function edition(city: string, knownCatalog: Catalog | undefined) {
		const provider = knownCatalog?.providers.find(({ id }) => id === city);
		const revision =
			provider && knownCatalog?.answer_revision && knownCatalog.cleaning_version !== undefined
				? `${knownCatalog.cleaning_version}/${knownCatalog.answer_revision}/${provider.record_through ?? ''}`
				: undefined;
		const prior = timetables.get(city);
		const state = prior ?? { edition: null, retryAt: 0 };
		if (prior?.read) return prior;
		if (revision && prior && prior.revision === revision && Date.now() < prior.retryAt)
			return prior;
		if (provider) timetables.set(city, state);
		state.read = query(scheduleQuestion(city), scheduleIndexSchema, visitorIp)
			.then((result) => {
				state.revision = revision;
				const fresh = result.kind === 'answer' && !result.lastGood && !result.cacheStale;
				state.retryAt =
					Date.now() + (fresh && revision ? TIMETABLE_REFRESH_MS : CATALOG_REFRESH_MS);
				if (result.kind === 'answer' && (fresh || !state.edition)) {
					state.edition = result.answer.schedule;
				}
			})
			.finally(() => {
				state.read = undefined;
			});
		waitUntil?.(state.read);
		return state;
	}

	// Speculate on the explicit or last-known city while discovery is in flight.
	const speculative = needsSchedule ? edition(likelyCity, lastCatalog) : undefined;
	const loadCatalog = async () => {
		if (catalogRead && !catalog) await withinBootBudget(catalogRead, started);
		if (!catalog || discoveryFailed) throw new Error('Provider catalog unavailable');
		return catalog;
	};

	return {
		loadCatalog,
		lastCatalog,
		async loadEdition(city: string) {
			if (!needsSchedule) return null;
			const state = speculative && city === likelyCity ? speculative : edition(city, catalog);
			// A first read made alongside discovery can be kept as a fallback for this city.
			if (catalog?.providers.some(({ id }) => id === city) && !timetables.has(city)) {
				timetables.set(city, state);
			}
			if ((!state.edition || !catalog?.answer_revision) && state.read)
				await withinBootBudget(state.read, started);
			return state.edition;
		},
	};
}
