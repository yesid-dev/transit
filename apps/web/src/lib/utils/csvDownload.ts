export function csvDataHref(csv: string): string {
	const text = csv.startsWith('\ufeff') ? csv : '\ufeff' + csv;
	return 'data:text/csv;charset=utf-8,' + encodeURIComponent(text);
}
