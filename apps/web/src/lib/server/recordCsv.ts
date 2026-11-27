import { citationSource, citationSourceText } from '#lib/site/presenter.ts';
import { frameDateLimit, frameClock, periodError, recordStart } from '#lib/site/frameState.ts';
import type { DateWindow } from '#lib/v1/history/window.ts';
import { getCityCatalog, getRecordCsv, type RecordQuery } from './engine.ts';

// Distinct from a "source" column the engine may already export, such as a notice's source.
const sourceHeader = { en: 'Data source and licence', fr: 'Source des données et licence' };

const unavailableText = {
	en: 'The record is temporarily unavailable. Try the download again in a few minutes.',
	fr: 'Le bilan est temporairement indisponible. Réessayez le téléchargement dans quelques minutes.',
};
const invalidText = {
	en: 'This selection cannot be downloaded. Check the city, dates and reading.',
	fr: 'Cette sélection ne peut pas être téléchargée. Vérifiez la ville, les dates et la mesure.',
};

/** A failed reading answers with a sentence to read, never a file that looks like data. */
function downloadError(lang: 'en' | 'fr', status: number, retryAfter?: string | null) {
	const headers = new Headers({
		'content-type': 'text/plain; charset=utf-8',
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
	});
	if (retryAfter) headers.set('retry-after', retryAfter);
	const message = status === 503 ? unavailableText[lang] : invalidText[lang];
	return new Response(`${message}\n`, { status, headers });
}

function csvField(text: string) {
	return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Adds one last column to a CSV stream: `header` on the first record, `value` on every other.
 * Records end at a line break outside quotes, so quoted line breaks inside a field are kept.
 */
export function appendCsvColumn(header: string, value: string) {
	// Keep the byte order mark: spreadsheet programs read the file as UTF-8 by it.
	const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
	const encoder = new TextEncoder();
	const head = `,${csvField(header)}`;
	const cell = `,${csvField(value)}`;
	let quoted = false;
	let first = true;
	let atRecordStart = true;
	let pendingReturn = false;
	const recordEnd = () => {
		const text = first ? head : cell;
		first = false;
		return text;
	};
	return new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			const text = decoder.decode(chunk, { stream: true });
			let out = '';
			for (const char of text) {
				if (pendingReturn) {
					pendingReturn = false;
					if (char === '\n') {
						out += '\r\n';
						continue;
					}
					out += '\r';
				}
				if (char === '"') quoted = !quoted;
				if (!quoted && (char === '\n' || char === '\r')) {
					if (!atRecordStart) out += recordEnd();
					atRecordStart = true;
					if (char === '\r') {
						pendingReturn = true;
						continue;
					}
					out += char;
					continue;
				}
				// A byte order mark opens the file; it does not start a record.
				if (char !== '﻿') atRecordStart = false;
				out += char;
			}
			if (out) controller.enqueue(encoder.encode(out));
		},
		flush(controller) {
			let out = decoder.decode();
			if (pendingReturn) out += '\r';
			if (!atRecordStart) out += recordEnd();
			if (out) controller.enqueue(encoder.encode(out));
		},
	});
}

export async function recordCsvResponse(
	query: RecordQuery,
	url: URL,
	request: Request,
	lang: 'en' | 'fr',
	filename: string,
	selectPeriod?: (period: DateWindow) => DateWindow,
) {
	const search = url.searchParams;
	const city = search.get('provider') ?? '';
	const period = { from: search.get('recordFrom') ?? '', to: search.get('recordTo') ?? '' };
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
	const upstream = await getRecordCsv(
		query,
		{ ...selected, city, visitorIp },
		lang,
		request.signal,
	).catch(() => null);
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
		'content-disposition': `attachment; filename="${filename}"`,
		'cache-control': 'no-store',
		'x-content-type-options': 'nosniff',
	});
	if (upstream.headers.get('x-transit-answer') === 'last-good')
		headers.set('x-transit-answer', 'last-good');
	const operator = provider.labels[lang].operator;
	// Every row says whose data it is and under which licence, as the licence asks.
	const source = citationSourceText(citationSource(operator, provider, lang), lang);
	return new Response(upstream.body.pipeThrough(appendCsvColumn(sourceHeader[lang], source)), {
		headers,
	});
}
