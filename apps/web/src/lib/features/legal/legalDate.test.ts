import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { LEGAL_EFFECTIVE_DATES, legalDocument } from './legal.copy';

// Register a new fingerprint with the date when either translation changes.
const reviewed = {
	privacy: {
		date: '2026-11-27',
		fingerprint: '4d57c226ba4a25078680a39df194c7cfe32cbe013ffd71d95138e67f9197d857',
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
