/** Read downloaded bytes independently of the export serializer, including embedded CSV newlines. */
export function csvTable(text: string): Record<string, string>[] {
	const rows: string[][] = [];
	let cells: string[] = [],
		cell = '',
		quoted = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '"') {
			if (quoted && text[i + 1] === '"') {
				cell += '"';
				i++;
			} else quoted = !quoted;
		} else if (c === ',' && !quoted) {
			cells.push(cell);
			cell = '';
		} else if (c === '\r' && text[i + 1] === '\n' && !quoted) {
			cells.push(cell);
			rows.push(cells);
			cells = [];
			cell = '';
			i++;
		} else cell += c;
	}
	cells.push(cell);
	rows.push(cells);
	const [header, ...data] = rows;
	return data.map((row) => Object.fromEntries(header.map((key, i) => [key, row[i] ?? ''])));
}

export function downloadedTable(link: HTMLAnchorElement): Record<string, string>[] {
	return csvTable(decodeURIComponent(link.href.slice(link.href.indexOf(',') + 1)));
}
