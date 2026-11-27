import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { LEGAL_EFFECTIVE_DATES, legalDocument } from './legal.copy';

// Register a new fingerprint with the date when either translation changes.
const reviewed = {
	privacy: {
		date: '2026-11-27',
		fingerprint: 'a1200cfacbcc093ff3420c74f5928e98a3f1316e24c7827e4ac96a88c67954e8',
	},
	terms: {
		date: '2026-11-27',
		fingerprint: '266286bc1fee32609803876681c92b16dedf851d8505b748efef8ffddc5ac9ec',
	},
} as const;

it.each(['privacy', 'terms'] as const)('%s copy matches its last reviewed date', (kind) => {
	const copy = (['en', 'fr'] as const).map((locale) => {
		const { effectiveDate: _date, ...document } = legalDocument(locale, kind);
		return document;
	});
	const fingerprint = createHash('sha256').update(JSON.stringify(copy)).digest('hex');
	expect({ date: LEGAL_EFFECTIVE_DATES[kind], fingerprint }).toEqual(reviewed[kind]);
});
