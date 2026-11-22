export function recordSectionLinks(url: URL, section: string) {
	const share = new URL(url);
	share.hash = section;
	const csv = new URL(url);
	csv.pathname = `${csv.pathname.replace(/\/$/, '')}/record.csv`;
	csv.hash = '';
	csv.searchParams.delete('tab');
	csv.searchParams.set('section', section);
	return { share: share.href, csv: csv.pathname + csv.search };
}
