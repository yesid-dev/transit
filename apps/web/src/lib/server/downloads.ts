import { z } from 'zod';
import { query } from './engine.ts';
import { cityQuestion, QUESTION_ORIGIN } from './engineQuestion.ts';

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
