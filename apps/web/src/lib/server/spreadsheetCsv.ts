import {
	engineColumns as columns,
	measureLabel,
	spreadsheetColumns,
} from '#lib/site/csvColumns.ts';

type Lang = 'en' | 'fr';

function parseJson(text: string): unknown {
	if (!/^[[{]/u.test(text.trim())) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** One cell, one value: lists read "a; b", keyed values read "line=51". */
export function scalarCell(text: string): string {
	const parsed = parseJson(text);
	if (parsed === undefined) return text;
	const flat = (value: unknown): string =>
		value === null || value === undefined
			? ''
			: typeof value === 'object'
				? Array.isArray(value)
					? value.map(flat).join('; ')
					: Object.entries(value)
							.map(([key, item]) => `${key}=${flat(item)}`)
							.join('; ')
				: String(value);
	return flat(parsed);
}

function csvField(text: string) {
	return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Turns the engine's export into one a spreadsheet sorts and filters: every cell holds one value,
 * a measure's stable ID sits beside its name in the reader's language, and every row names its
 * source, licence and licence address. A row that carries several measures as JSON objects in
 * Value, Unit and State becomes one row per measure.
 */
export function spreadsheetRows(
	lang: Lang,
	source: string,
	licenceUrl: string,
): (record: string[]) => string[][] {
	let header: string[] | null = null;
	let at = { measure: -1, value: -1, unit: -1, state: -1 };
	return (record) => {
		if (!header) {
			header = record;
			const find = (names: readonly string[]) => record.findIndex((name) => names.includes(name));
			at = {
				measure: find(columns.measure),
				value: find(columns.value),
				unit: find(columns.unit),
				state: find(columns.state),
			};
			return [spreadsheetColumns(record, lang)];
		}
		const finish = (cells: string[], id: string | null) => {
			const out = cells.map(scalarCell);
			if (at.measure >= 0 && id !== null) out.splice(at.measure, 1, id, measureLabel(id, lang));
			return [...out, source, licenceUrl];
		};
		const measure = at.measure >= 0 ? (record[at.measure] ?? '') : null;
		const values = at.value >= 0 ? parseJson(record[at.value] ?? '') : undefined;
		if (!values || typeof values !== 'object' || Array.isArray(values))
			return [finish(record, measure)];
		const units = at.unit >= 0 ? parseJson(record[at.unit] ?? '') : undefined;
		const states = at.state >= 0 ? parseJson(record[at.state] ?? '') : undefined;
		const pick = (from: unknown, key: string, index: number) =>
			from && typeof from === 'object' && !Array.isArray(from)
				? String((from as Record<string, unknown>)[key] ?? '')
				: (record[index] ?? '');
		return Object.entries(values as Record<string, unknown>).map(([key, value]) => {
			const cells = [...record];
			cells[at.value] = value === null ? '' : String(value);
			if (at.unit >= 0) cells[at.unit] = pick(units, key, at.unit);
			if (at.state >= 0) cells[at.state] = pick(states, key, at.state);
			return finish(cells, key);
		});
	};
}

/**
 * Streams the engine's CSV through `spreadsheetRows`: one UTF-8 BOM, CRLF line ends, and quoted
 * line breaks inside a field kept. A record ends at a line break outside quotes.
 */
export function spreadsheetCsv(lang: Lang, source: string, licenceUrl: string) {
	const rows = spreadsheetRows(lang, source, licenceUrl);
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let record: string[] = [];
	let field = '';
	let quoted = false;
	let quoteSeen = false;
	let started = false;
	let pendingReturn = false;
	const write = () => {
		record.push(field);
		const out = rows(record)
			.map((cells) => cells.map(csvField).join(',') + '\r\n')
			.join('');
		record = [];
		field = '';
		started = false;
		return out;
	};
	const read = (text: string) => {
		let out = '';
		for (const char of text) {
			if (pendingReturn) {
				pendingReturn = false;
				if (char === '\n') continue;
			}
			if (quoted) {
				if (char === '"') {
					quoted = false;
					quoteSeen = true;
				} else field += char;
				continue;
			}
			if (char === '"') {
				// A doubled quote inside a quoted field is one quote.
				if (quoteSeen) field += '"';
				quoted = true;
				quoteSeen = false;
				started = true;
				continue;
			}
			quoteSeen = false;
			if (char === ',') {
				record.push(field);
				field = '';
				started = true;
				continue;
			}
			if (char === '\r' || char === '\n') {
				if (started || field) out += write();
				if (char === '\r') pendingReturn = true;
				continue;
			}
			field += char;
			started = true;
		}
		return out;
	};
	return new TransformStream<Uint8Array, Uint8Array>({
		start(controller) {
			controller.enqueue(Uint8Array.of(0xef, 0xbb, 0xbf));
		},
		transform(chunk, controller) {
			const out = read(decoder.decode(chunk, { stream: true }));
			if (out) controller.enqueue(encoder.encode(out));
		},
		flush(controller) {
			let out = read(decoder.decode());
			if (started || field) out += write();
			if (out) controller.enqueue(encoder.encode(out));
		},
	});
}
