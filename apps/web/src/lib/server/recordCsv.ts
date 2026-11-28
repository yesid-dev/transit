import { citationSource, citationSourceText } from '#lib/site/presenter.ts';
import { frameDateLimit, frameClock, periodError, recordStart } from '#lib/site/frameState.ts';
import type { DateWindow } from '#lib/v1/history/window.ts';
import { getCityCatalog, getRecordCsv, type RecordQuery } from './engine.ts';
import type { EntityIdentity, IdentityScope } from './entityIdentity.ts';
import type { PublicCity } from '#lib/v1/schemas/providers.ts';
import { detailNotFoundCopy } from '#lib/site/errorPage.ts';
import { spreadsheetCsv } from './spreadsheetCsv.ts';

const unavailableText = {
	en: 'The record is temporarily unavailable. Try the download again in a few minutes.',
	fr: 'Le bilan est temporairement indisponible. Réessayez le téléchargement dans quelques minutes.',
};
const invalidText = {
	en: 'This selection cannot be downloaded. Check the city, dates and reading.',
	fr: 'Cette sélection ne peut pas être téléchargée. Vérifiez la ville, les dates et la mesure.',
};

/** A failed reading answers with a sentence to read, never a file that looks like data. */
function csvFailure(status: number, message: string, retryAfter?: string | null) {
	const headers = new Headers({
		'content-type': 'text/plain; charset=utf-8',
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
	});
	if (retryAfter) headers.set('retry-after', retryAfter);
	return new Response(`${message}\n`, { status, headers });
}

type DetailCode = keyof typeof detailNotFoundCopy | 'STOP_NOT_FOUND';
// A missing stop names where to find it, as the stop page does.
const missingStop = {
	en: 'This stop could not be found. Find it in the list of stops and download again.',
	fr: 'Cet arrêt est introuvable. Cherchez-le dans la liste des arrêts, puis téléchargez de nouveau le fichier.',
};
type CsvOptions = {
	selectPeriod?: (period: DateWindow) => DateWindow;
	identity?: {
		code: DetailCode;
		check: (provider: PublicCity, scope: IdentityScope) => Promise<EntityIdentity>;
		canonicalHref?: string | null;
	};
};

export function missingRecordCsv(lang: 'en' | 'fr', code: DetailCode) {
	return csvFailure(
		404,
		code === 'STOP_NOT_FOUND' ? missingStop[lang] : `${detailNotFoundCopy[code][lang].heading}.`,
	);
}

const invalidInput = {
	section: { en: 'Choose which reading to download.', fr: 'Choisissez la mesure à télécharger.' },
	city: {
		en: 'Choose a transit network for this download.',
		fr: 'Choisissez un réseau de transport pour ce téléchargement.',
	},
	dates: {
		en: 'Choose a valid date range for this download.',
		fr: 'Choisissez une période valide pour ce téléchargement.',
	},
};

export function invalidRecordCsv(lang: 'en' | 'fr', field: keyof typeof invalidInput = 'section') {
	return csvFailure(400, invalidInput[field][lang]);
}

function downloadError(lang: 'en' | 'fr', status: number, retryAfter?: string | null) {
	return csvFailure(status, status === 503 ? unavailableText[lang] : invalidText[lang], retryAfter);
}

/**
 * A file name that two downloads never share: the network, what the page shows (`line-51-punctuality`),
 * the dates and the language, as `stm-line-51-punctuality-2026-11-19-to-2026-11-25-en.csv`.
 */
export function csvFilename(city: string, name: string, period: DateWindow, lang: 'en' | 'fr') {
	const slug = (text: string) =>
		text
			.normalize('NFKD')
			.replace(/\p{M}+/gu, '')
			.replace(/[^A-Za-z0-9._-]+/gu, '-')
			.replace(/-+/gu, '-')
			.replace(/^-|-$/gu, '');
	const base = slug(name.replace(/.csv$/u, ''));
	const dates = period.from === period.to ? period.from : `${period.from}-to-${period.to}`;
	return `${slug(city)}-${base}-${dates}-${lang}.csv`;
}

export async function recordCsvResponse(
	query: RecordQuery,
	url: URL,
	request: Request,
	lang: 'en' | 'fr',
	filename: string,
	{ selectPeriod, identity }: CsvOptions = {},
) {
	const search = url.searchParams;
	const city = search.get('provider') ?? '';
	const period = { from: search.get('recordFrom') ?? '', to: search.get('recordTo') ?? '' };
	if (!city) return invalidRecordCsv(lang, 'city');
	if (!period.from || !period.to) return invalidRecordCsv(lang, 'dates');
	if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(city)) return downloadError(lang, 400);
	const visitorIp = request.headers.get('cf-connecting-ip');
	const catalog = await getCityCatalog(visitorIp).catch(() => null);
	if (!catalog) return downloadError(lang, 503);
	const provider = catalog.providers.find(({ id }) => id === city);
	if (!provider) return downloadError(lang, 400);
	const limit = frameDateLimit(frameClock(provider));
	const start = recordStart(provider);
	if (periodError(period, limit, start)) return downloadError(lang, 400);
	const selected = selectPeriod?.(period) ?? period;
	if (periodError(selected, limit, start)) return downloadError(lang, 400);
	const scope = { city, visitorIp };
	if (identity) {
		const state = await identity.check(provider, scope).catch(() => 'unconfirmed');
		if (state === 'missing') return missingRecordCsv(lang, identity.code);
		if (state === 'unconfirmed') return downloadError(lang, 503);
		if (identity.canonicalHref)
			return new Response(null, { status: 308, headers: { location: identity.canonicalHref } });
	}
	const upstream = await getRecordCsv(query, { ...selected, ...scope }, lang, request.signal).catch(
		() => null,
	);
	if (
		!upstream?.ok ||
		!upstream.body ||
		!upstream.headers.get('content-type')?.startsWith('text/csv')
	) {
		const status = upstream?.status ?? 503;
		const retryAfter = status === 503 ? upstream?.headers.get('retry-after') : null;
		await upstream?.body?.cancel().catch(() => {});
		return downloadError(lang, [400, 404, 409, 422].includes(status) ? status : 503, retryAfter);
	}
	const headers = new Headers({
		'content-type': 'text/csv; charset=utf-8',
		'content-disposition': `attachment; filename="${csvFilename(provider.id, filename, selected, lang)}"`,
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
	});
	if (upstream.headers.get('x-transit-answer') === 'last-good')
		headers.set('x-transit-answer', 'last-good');
	const operator = provider.labels[lang].operator;
	// Every row says whose data it is, under which licence and where to read it, as the licence asks.
	const source = citationSourceText(citationSource(operator, provider, lang), lang);
	const licenceUrl = provider.download_licence?.url?.[lang] ?? '';
	return new Response(upstream.body.pipeThrough(spreadsheetCsv(lang, source, licenceUrl)), {
		headers,
	});
}
