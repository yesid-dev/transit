import { z } from 'zod';
import { query } from './engine.ts';
import { cityQuestion, QUESTION_ORIGIN } from './engineQuestion.ts';
import { addIsoDays } from '#lib/v1/history/selection.ts';
import type { DateWindow } from '#lib/v1/history/window.ts';

const bilingual = z.object({ en: z.string(), fr: z.string() });
const links = z.object({ en: z.url(), fr: z.url() });
const fileUrl = z
	.string()
	.regex(/^\/v2\/[a-z0-9_-]+\/download\/[\d-]+\/[\w.]+\?version=\d+$/)
	.transform((path) => new URL(path, QUESTION_ORIGIN).href);
const listing = z.object({
	city: z.string(),
	service_date: z.iso.date(),
	cleaning_version: z.string(),
	status: z.enum(['complete', 'missing', 'not_measured']),
	reason: z
		.enum(['no_manifest', 'no_raw_captures', 'no_schedule_edition', 'schedule_archive_unreadable'])
		.optional(),
	alerts_not_tracked: z.boolean(),
	files: z.array(
		z.object({
			name: z.string(),
			byte_size: z.int().positive(),
			sha256: z.string().regex(/^[a-f0-9]{64}$/),
			url: fileUrl,
		}),
	),
	readme_url: fileUrl.nullable(),
	licence: z.object({
		name: bilingual,
		checked_on: z.iso.date(),
		attribution: bilingual,
		url: links,
		changes: bilingual,
		non_endorsement: bilingual,
		limits: bilingual,
		contact: z.email(),
	}),
});

export type DownloadListing = z.infer<typeof listing>;

export function getDownloadListing(city: string, date: string | null, visitorIp?: string | null) {
	return query(
		{
			...cityQuestion(city, '/download'),
			parameters: date ? { date } : {},
		},
		listing,
		visitorIp,
	);
}

// The proxy lists one date per request and admits 30 questions per visitor per minute.
// Page long periods so a single visit cannot exhaust the allowance.
export function downloadWindow(period: DateWindow, requested: string | null) {
	const daysPerPage = 7;
	const lastPage = Math.floor(
		(Date.parse(period.to) - Date.parse(period.from)) / (86_400_000 * daysPerPage),
	);
	const page = Math.min(lastPage, /^\d+$/.test(requested ?? '') ? Number(requested) : 0);
	const to = addIsoDays(period.to, -page * daysPerPage);
	const from = [period.from, addIsoDays(to, 1 - daysPerPage)].sort()[1];
	return { from, to, page, lastPage };
}

export async function getDownloadWindow(
	city: string,
	window: DateWindow,
	visitorIp?: string | null,
) {
	const days: string[] = [];
	for (let day = window.from; day <= window.to; day = addIsoDays(day, 1)) days.push(day);
	const results = await Promise.all(days.map((day) => getDownloadListing(city, day, visitorIp)));
	const listings = results.flatMap((result, i) =>
		result.kind === 'answer' &&
		!result.lastGood &&
		result.answer.city === city &&
		result.answer.service_date === days[i]
			? [result.answer]
			: [],
	);
	return {
		kind: results.every(({ kind }) => kind === 'busy' || kind === 'timeout')
			? ('busy' as const)
			: ('answer' as const),
		listings,
		unavailable: listings.length < days.length,
		busy: results.some(({ kind }) => kind === 'busy'),
	};
}
