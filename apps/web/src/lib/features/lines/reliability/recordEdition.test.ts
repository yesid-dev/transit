import { describe, expect, it } from 'vitest';
import type { RecordPublication } from './selectors/lineRecord';
import {
	applyEditionParams,
	clearEditionParams,
	compareEdition,
	hasEditionRequest,
	parseEditionRequest,
} from './recordEdition';

const NONE: RecordPublication = { generatedUtc: null, generationId: null, methodVersion: null };

const params = (query: string): URLSearchParams => new URLSearchParams(query);

const publication = (
	generationId: string | null,
	generatedUtc: string | null,
	methodVersion: string | null,
): RecordPublication => ({ generatedUtc, generationId, methodVersion });

describe('Record edition hints', () => {
	it('parses omitted, supplied, partial and mixed identity field by field', () => {
		expect(parseEditionRequest(params('provider=stm'))).toEqual(NONE);
		expect(hasEditionRequest(parseEditionRequest(params('provider=stm')))).toBe(false);
		expect(
			parseEditionRequest(
				params(
					'generation=stm%402026-11-11T06%3A00%3A00Z&published=2026-11-11T06%3A00%3A00Z&method=reliability-2',
				),
			),
		).toEqual(publication('stm@2026-11-11T06:00:00Z', '2026-11-11T06:00:00Z', 'reliability-2'));
		expect(
			parseEditionRequest(
				params('generation=retained-g&published=not-a-date&method=reliability-2'),
			),
		).toEqual(publication('retained-g', null, 'reliability-2'));
	});

	it('ignores duplicate, blank, overlong, control-bearing and malformed hints without truncating', () => {
		expect(
			parseEditionRequest(params('generation=a&generation=a&published=2026-11-11T06:00:00Z')),
		).toEqual(publication(null, '2026-11-11T06:00:00Z', null));
		expect(
			parseEditionRequest(
				params(
					`generation=${encodeURIComponent('  ')}&method=${encodeURIComponent('x'.repeat(513))}`,
				),
			),
		).toEqual(NONE);
		expect(parseEditionRequest(params(`generation=${encodeURIComponent('bad\u0007id')}`))).toEqual(
			NONE,
		);
		expect(parseEditionRequest(params('published=2026-02-30T00:00:00Z'))).toEqual(NONE);
		expect(parseEditionRequest(params('published=2026-11-11T25:00:00Z'))).toEqual(NONE);
		expect(parseEditionRequest(params('published=2026-11-11'))).toEqual(NONE);
	});

	it('keeps opaque Unicode and reserved characters as text, never as a path or address', () => {
		const opaque = 'Ligné/中央 ?#&=01 🚌';
		const query = new URLSearchParams({ generation: opaque, method: 'méthode/2 ?a=b#c' });
		expect(parseEditionRequest(query)).toEqual(publication(opaque, null, 'méthode/2 ?a=b#c'));
		const applied = new URLSearchParams();
		applyEditionParams(applied, publication(opaque, null, 'méthode/2 ?a=b#c'));
		expect(applied.get('generation')).toBe(opaque);
		expect(applied.get('method')).toBe('méthode/2 ?a=b#c');
		expect(applied.get('path')).toBeNull();
		expect(applied.toString()).not.toContain('Ligné/中央');
	});

	it('deletes every stale or duplicate copy before writing only the actual usable fields', () => {
		const stale = params(
			'provider=stm&keep=1&generation=old&generation=old-2&published=2020-01-01T00%3A00%3A00Z&method=old-method',
		);
		applyEditionParams(stale, publication('new-g', '2026-11-11T06:00:00Z', 'reliability-2'));
		expect(stale.getAll('generation')).toEqual(['new-g']);
		expect(stale.get('published')).toBe('2026-11-11T06:00:00Z');
		expect(stale.get('method')).toBe('reliability-2');
		expect(stale.get('provider')).toBe('stm');
		expect(stale.get('keep')).toBe('1');
		applyEditionParams(stale, publication(null, null, null));
		expect(stale.toString()).toBe('provider=stm&keep=1');
		clearEditionParams(stale);
		expect(stale.toString()).toBe('provider=stm&keep=1');
	});

	it('omits unusable actual fields instead of truncating or borrowing a requested hint', () => {
		const applied = params(
			'generation=requested&published=2020-01-01T00%3A00%3A00Z&method=requested',
		);
		applyEditionParams(
			applied,
			publication('x'.repeat(513), '2026-02-30T00:00:00Z', 'bad\u0000method'),
		);
		expect(applied.toString()).toBe('');
		applyEditionParams(applied, publication('\uD800', null, null));
		expect(applied.toString()).toBe('');
	});
});

describe('Record edition comparison', () => {
	it('says nothing without a hint or when every supplied field matches', () => {
		expect(compareEdition(NONE, publication('g1', '2026-11-11T06:00:00Z', 'm1'))).toBe('none');
		expect(
			compareEdition(
				publication('g1', '2026-11-11T06:00:00Z', 'm1'),
				publication('g1', '2026-11-11T06:00:00Z', 'm1'),
			),
		).toBe('match');
		expect(
			compareEdition(
				publication(null, '2026-11-11T06:00:00Z', 'm1'),
				publication('g1', '2026-11-11T06:00:00Z', 'm1'),
			),
		).toBe('match');
	});

	it('calls a known different generation with a strictly newer actual instant corrected', () => {
		expect(
			compareEdition(
				publication('g1', '2026-11-04T06:00:00Z', 'm1'),
				publication('g2', '2026-11-11T06:00:00Z', 'm1'),
			),
		).toBe('corrected');
		// Instants, not strings: the same moment in another zone is not older.
		expect(
			compareEdition(
				publication('g1', '2026-11-11T06:00:00Z', null),
				publication('g2', '2026-11-11T01:00:00-05:00', null),
			),
		).toBe('different');
	});

	it('never derives order from an opaque ID and never calls an equal generation corrected', () => {
		expect(
			compareEdition(
				publication('zzz-old', '2026-11-04T06:00:00Z', 'm1'),
				publication('aaa-new', '2026-11-11T06:00:00Z', 'm1'),
			),
		).toBe('corrected');
		expect(
			compareEdition(
				publication('aaa-old', '2026-11-11T06:00:00Z', 'm1'),
				publication('zzz-new', '2026-11-04T06:00:00Z', 'm1'),
			),
		).toBe('different');
		expect(
			compareEdition(
				publication('g1', '2026-11-04T06:00:00Z', 'm1'),
				publication('g1', '2026-11-11T06:00:00Z', 'm2'),
			),
		).toBe('different');
	});

	it('reports a known difference without chronology as different, never corrected', () => {
		expect(compareEdition(publication('g1', null, 'm1'), publication('g2', null, 'm1'))).toBe(
			'different',
		);
		expect(
			compareEdition(
				publication(null, '2026-11-11T06:00:00Z', 'm1'),
				publication(null, '2026-11-18T06:00:00Z', 'm1'),
			),
		).toBe('different');
		expect(
			compareEdition(
				publication('g1', '2026-11-11T06:00:00Z', 'm1'),
				publication('g1', '2026-11-11T06:00:00Z', 'm2'),
			),
		).toBe('different');
	});

	it('marks a hint unverifiable when the selected source lacks that supplied field', () => {
		// The current-file→retained case: the available record has no generation to verify against.
		expect(
			compareEdition(
				publication('current@2026-11-11T06:00:00Z', '2026-11-11T06:00:00Z', 'm1'),
				publication(null, '2026-11-11T06:00:00Z', 'm1'),
			),
		).toBe('unverifiable');
		expect(
			compareEdition(
				publication(null, '2026-11-11T06:00:00Z', 'm1'),
				publication('g1', null, 'm1'),
			),
		).toBe('unverifiable');
		expect(
			compareEdition(
				publication(null, null, 'm1'),
				publication('g1', '2026-11-11T06:00:00Z', null),
			),
		).toBe('unverifiable');
	});
});
