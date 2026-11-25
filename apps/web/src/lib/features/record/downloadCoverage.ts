import type { DownloadListing } from '#lib/server/downloads.ts';
import { addIsoDays } from '#lib/v1/history/selection.ts';
import type { DateWindow } from '#lib/v1/history/window.ts';
import { downloadLayouts } from './downloadTables.ts';

type Table = keyof typeof downloadLayouts;

function expectsFile(table: Table, day: DownloadListing) {
	if (table === 'alerts') return !day.alerts_not_tracked;
	if (table === 'segment_runs') return Number(day.cleaning_version) >= 12;
	return true;
}

export function downloadCoverage(window: DateWindow | null, listings: DownloadListing[]) {
	const byDate = new Map(listings.map((day) => [day.service_date, day]));
	const dates: string[] = [];
	if (window) {
		for (let date = window.from; date <= window.to; date = addIsoDays(date, 1)) dates.push(date);
	}
	const tables = (Object.keys(downloadLayouts) as Table[])
		.filter((table) => listings.some((day) => expectsFile(table, day)))
		.map((table) => {
			const files = [];
			const gaps = [];
			const sources = [];
			for (const date of dates) {
				const day = byDate.get(date);
				if (day && !expectsFile(table, day)) {
					gaps.push({ date, status: 'not_published' as const });
					continue;
				}
				if (day) sources.push(day);
				const file =
					day?.status === 'complete'
						? day.files.find(({ name }) => name === table + '.parquet')
						: null;
				if (file && day) files.push({ file, day });
				else
					gaps.push({
						date,
						status: !day
							? ('unavailable' as const)
							: day.status === 'not_measured'
								? ('not_measured' as const)
								: ('missing' as const),
					});
			}
			return { table, files, gaps, sources };
		});
	return {
		tables,
		days: dates.length,
		count: tables.reduce((total, { files }) => total + files.length, 0),
		missing: tables.reduce(
			(total, { gaps }) =>
				total +
				gaps.filter(({ status }) => status === 'missing' || status === 'not_measured').length,
			0,
		),
	};
}
