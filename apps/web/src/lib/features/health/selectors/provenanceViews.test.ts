import { describe, it, expect } from 'vitest';
import {
	verdictFor,
	feedFreshness,
	pipelineNotesOf,
	retentionOf,
	type StatusVerdictLabels,
} from './provenanceViews';
import type { DataHealth, Provenance, IsoUtc } from '#lib/v1/schemas/index.ts';

const iso = (s: string) => s as unknown as IsoUtc;

const verdictLabels: StatusVerdictLabels = {
	ok: 'loaded',
	running: 'loading',
	failed: 'load failed',
	unknown: 'unknown',
};

describe('verdictFor', () => {
	it('maps run statuses to a signal lamp + label', () => {
		expect(verdictFor('succeeded', verdictLabels)).toEqual({ aspect: 'green', label: 'loaded' });
		expect(verdictFor('failed', verdictLabels)).toEqual({ aspect: 'stop', label: 'load failed' });
		expect(verdictFor('running', verdictLabels)).toEqual({ aspect: 'unknown', label: 'loading' });
		expect(verdictFor('pending', verdictLabels)).toEqual({ aspect: 'unknown', label: 'loading' });
	});

	it('falls back to the neutral unknown aspect for an unrecognized / absent status', () => {
		expect(verdictFor('weird', verdictLabels)).toEqual({ aspect: 'unknown', label: 'unknown' });
		expect(verdictFor(null, verdictLabels)).toEqual({ aspect: 'unknown', label: 'unknown' });
		expect(verdictFor(undefined, verdictLabels)).toEqual({ aspect: 'unknown', label: 'unknown' });
	});
});

describe('pipelineNotesOf', () => {
	const threaded = { otp_definition: 'otp', cancellation: 'cancellation' };
	const labels = { network_no_data: 'Network no-data honesty', wilson_z: 'CI z-score' };

	it('iterates the FULL dict, dropping threaded keys and keeping every un-threaded string', () => {
		const p = {
			generated_utc: iso('2026-07-02T12:00:00Z'),
			methodology: {
				otp_definition: 'threaded — excluded',
				network_no_data: 'null not 0',
				wilson_z: 'z = 1.96',
				brand_new_key: 'a note with no explicit label',
			},
		} as unknown as Provenance;
		const notes = pipelineNotesOf(p, threaded, labels);
		const keys = notes.map((n) => n.key);
		expect(keys).toContain('network_no_data');
		expect(keys).toContain('wilson_z');
		expect(keys).toContain('brand_new_key');
		expect(keys).not.toContain('otp_definition');
		expect(notes.find((n) => n.key === 'network_no_data')?.label).toBe('Network no-data honesty');
		expect(notes.find((n) => n.key === 'brand_new_key')?.label).toBe('brand new key');
	});

	it('drops non-string and empty-string values, and returns [] when the dict is absent', () => {
		const p = {
			generated_utc: iso('2026-07-02T12:00:00Z'),
			methodology: { a: '', b: 42, c: '   ', d: 'kept' },
		} as unknown as Provenance;
		const notes = pipelineNotesOf(p, {}, {});
		expect(notes.map((n) => n.key)).toEqual(['d']);
		expect(pipelineNotesOf({ generated_utc: iso('x') } as unknown as Provenance, {}, {})).toEqual(
			[],
		);
	});

	it('assigns explicit kinds by key and gives unknown keys the pipeline-note fallback', () => {
		const p = {
			generated_utc: iso('2026-07-10T12:00:00Z'),
			methodology: {
				network_no_data: 'same words',
				wilson_z: 'same words',
				brand_new_key: 'same words',
			},
		} as unknown as Provenance;
		const notes = pipelineNotesOf(p, {}, {}, { network_no_data: 'caveat', wilson_z: 'math' });
		expect(notes.find((note) => note.key === 'network_no_data')?.kind).toBe('caveat');
		expect(notes.find((note) => note.key === 'wilson_z')?.kind).toBe('math');
		expect(notes.find((note) => note.key === 'brand_new_key')?.kind).toBe('pipeline-note');
	});
});

describe('retentionOf', () => {
	it('returns present day-counts and null for missing keys', () => {
		expect(
			retentionOf({
				generated_utc: iso('x'),
				retention: { detail_days: 14, aggregate_days: 365 },
			} as unknown as Provenance),
		).toEqual({ detail: 14, aggregate: 365 });
		expect(
			retentionOf({
				generated_utc: iso('x'),
				retention: { detail_days: 7 },
			} as unknown as Provenance),
		).toEqual({
			detail: 7,
			aggregate: null,
		});
		expect(retentionOf({ generated_utc: iso('x') } as unknown as Provenance)).toEqual({
			detail: null,
			aggregate: null,
		});
	});
});

describe('feedFreshness', () => {
	const now = Date.parse('2026-06-19T14:00:00Z');
	const daily = {
		generated_utc: iso('2026-06-19T12:00:00Z'),
		freshness: [
			{ feed: 'vehicle_positions', status: 'succeeded', age_s: 240 },
			{ feed: 'static_schedule', status: 'failed', age_s: null },
		],
	} as Provenance;

	it('reads data health’s feeds, republished every live cycle, as they are', () => {
		const feeds = [{ feed: 'vehicle_positions', status: 'succeeded', age_s: 40 }];
		const dataHealth = { generated_utc: iso('2026-06-19T13:59:30Z'), feeds } as DataHealth;
		expect(feedFreshness(dataHealth, daily, now)).toEqual({ items: feeds, atPublication: false });
	});

	it('falls back to the daily record: statuses as of its publication, ages counted to now', () => {
		// 240 s old at the 12:00 publication, read two hours later: 240 + 7,200 s.
		const atPublication = {
			atPublication: true,
			items: [
				{ feed: 'vehicle_positions', status: 'succeeded', age_s: 7440 },
				{ feed: 'static_schedule', status: 'failed', age_s: null },
			],
		};
		expect(feedFreshness(null, daily, now)).toEqual(atPublication);
		expect(feedFreshness({ feeds: [] } as unknown as DataHealth, daily, now)).toEqual(
			atPublication,
		);
		// Without its publication time the age is unknown, never the frozen publication-time age.
		const undated = { ...daily, generated_utc: null } as unknown as Provenance;
		expect(feedFreshness(null, undated, now).items[0]).toMatchObject({ age_s: null });
		expect(feedFreshness(null, null, now)).toEqual({ items: [], atPublication: false });
	});
});
