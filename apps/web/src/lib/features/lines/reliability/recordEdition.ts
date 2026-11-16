import type { RecordPublication } from './selectors/lineRecord';

/**
 * The three optional Record-link hints, in the order a generated link writes them.
 * They are bounded metadata, never addresses, and are mapped field by field to a publication.
 */
export const EDITION_QUERY_KEYS = ['generation', 'published', 'method'] as const;

/** A comparison the Record view can state without guessing an edition's age or contents. */
export type EditionComparison = 'none' | 'match' | 'corrected' | 'different' | 'unverifiable';

const MAX_HINT_LENGTH = 512;

/**
 * Opaque identity text: one non-empty trimmed value, at most 512 characters. Controls and lone
 * surrogates are not a usable identifier, so that hint is ignored rather than truncated.
 */
function usableText(value: string | null | undefined): string | null {
	if (value == null) return null;
	const text = value.trim();
	if (!text || text.length > MAX_HINT_LENGTH) return null;
	if (/\p{Cc}/u.test(text)) return null;
	try {
		encodeURIComponent(text);
	} catch {
		return null;
	}
	return text;
}

/**
 * A usable absolute publication timestamp: a real calendar date and time with an explicit zone.
 * Its instant is what compares; the written string is only carried forward.
 */
function usableInstant(value: string | null | undefined): string | null {
	const text = usableText(value);
	if (!text) return null;
	const match =
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u.exec(
			text,
		);
	if (!match) return null;
	const [year, month, day, hour, minute, second] = match
		.slice(1, 7)
		.map((part) => (part == null ? 0 : Number(part)));
	if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59)
		return null;
	const calendar = new Date(Date.UTC(year, month - 1, day));
	if (
		calendar.getUTCFullYear() !== year ||
		calendar.getUTCMonth() !== month - 1 ||
		calendar.getUTCDate() !== day
	)
		return null;
	return Number.isFinite(Date.parse(text)) ? text : null;
}

/** The read-only query surface a page URL supplies. */
export interface EditionQuery {
	getAll(key: string): readonly string[];
}

/** One field, only when the URL supplies it exactly once. A duplicate hint is ignored. */
function singleHint(params: EditionQuery, key: string): string | null {
	const values = params.getAll(key);
	return values.length === 1 ? usableText(values[0]) : null;
}

/**
 * The usable hint a Record link carries. An absent, duplicate, malformed or unencodable field
 * simply stays unknown; nothing here fetches, resolves or orders an identifier.
 */
export function parseEditionRequest(params: EditionQuery): RecordPublication {
	const generationId = singleHint(params, 'generation');
	const published = singleHint(params, 'published');
	return {
		generatedUtc: published == null ? null : usableInstant(published),
		generationId,
		methodVersion: singleHint(params, 'method'),
	};
}

/** Whether any field the reader supplied survives parsing. No hint means no notice. */
export function hasEditionRequest(publication: RecordPublication): boolean {
	return (
		publication.generationId != null ||
		publication.generatedUtc != null ||
		publication.methodVersion != null
	);
}

/** Remove every copy of the three hints, including duplicates the URL inherited. */
export function clearEditionParams(params: URLSearchParams): void {
	for (const key of EDITION_QUERY_KEYS) params.delete(key);
}

/**
 * Write only the actual publication's usable fields, field by field. The caller's link has already
 * removed stale copies; nothing falls back to a requested hint or another source's identity.
 */
export function applyEditionParams(
	params: URLSearchParams,
	publication: RecordPublication | null | undefined,
): void {
	clearEditionParams(params);
	if (!publication) return;
	const generation = usableText(publication.generationId);
	if (generation) params.set('generation', generation);
	const published = usableInstant(publication.generatedUtc);
	if (published) params.set('published', published);
	const method = usableText(publication.methodVersion);
	if (method) params.set('method', method);
}

const instantOf = (value: string | null): number | null => {
	const usable = usableInstant(value);
	return usable == null ? null : Date.parse(usable);
};

/**
 * Compare the link's requested publication with the one actually displayed. A field the selected
 * source does not supply makes the identity unverifiable, never a difference borrowed from another
 * source. Corrected requires two known, different generation IDs and a strictly newer actual
 * instant; an opaque ID's spelling never establishes age.
 */
export function compareEdition(
	requested: RecordPublication,
	actual: RecordPublication,
): EditionComparison {
	if (!hasEditionRequest(requested)) return 'none';
	if (
		(requested.generationId != null && actual.generationId == null) ||
		(requested.generatedUtc != null && actual.generatedUtc == null) ||
		(requested.methodVersion != null && actual.methodVersion == null)
	)
		return 'unverifiable';
	const generationDiffers =
		requested.generationId != null && requested.generationId !== actual.generationId;
	const publishedDiffers =
		requested.generatedUtc != null &&
		instantOf(requested.generatedUtc) !== instantOf(actual.generatedUtc);
	const methodDiffers =
		requested.methodVersion != null && requested.methodVersion !== actual.methodVersion;
	if (!generationDiffers && !publishedDiffers && !methodDiffers) return 'match';
	if (generationDiffers && requested.generationId && actual.generationId) {
		const requestedInstant = instantOf(requested.generatedUtc);
		const actualInstant = instantOf(actual.generatedUtc);
		if (requestedInstant != null && actualInstant != null && actualInstant > requestedInstant)
			return 'corrected';
	}
	return 'different';
}
