/** Decode one UTF-8 BOM at the file boundary before inspecting CSV content. */
export function csvText(body: string | Uint8Array): string {
	return typeof body === 'string' ? body.replace(/^\uFEFF/u, '') : new TextDecoder().decode(body);
}

export function csvDataText(href: string): string {
	return csvText(decodeURIComponent(href.slice(href.indexOf(',') + 1)));
}
