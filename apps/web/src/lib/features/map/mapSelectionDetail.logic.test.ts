// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { detailStopName, timeLabel } from './mapSelectionDetail.logic';

it('localizes a selected stop with no published name', () => {
	const stop = { id: 'stop-missing-name', name: 'ignored', nameAbsent: true };
	expect(detailStopName(stop, 'en')).toBe('Stop stop-missing-name (name unavailable)');
	expect(detailStopName(stop, 'fr')).toBe('Arrêt stop-missing-name (nom indisponible)');
});

describe('timeLabel', () => {
	it.each([
		['2026-07-14T23:21:00Z', 'America/Toronto', 'en', '19:21'],
		['2026-07-14T23:21:00Z', 'America/Toronto', 'fr', '19\u00a0h\u00a021'],
		['2026-07-14T23:21:00Z', 'America/Vancouver', 'en', '16:21'],
		['2026-07-14T23:21:00Z', 'America/Vancouver', 'fr', '16\u00a0h\u00a021'],
		['2026-11-14T05:00:00Z', 'America/Toronto', 'en', '00:00'],
		['2026-11-14T05:00:00Z', 'America/Toronto', 'fr', '0\u00a0h'],
	] as const)('reads %s in %s for %s as %s', (iso, timeZone, locale, expected) => {
		expect(timeLabel(iso, locale, timeZone)).toBe(expected);
	});

	it('keeps absent instants as empty text', () => {
		expect(timeLabel(null, 'en', 'America/Toronto')).toBe('');
		expect(timeLabel(undefined, 'fr', 'America/Toronto')).toBe('');
		expect(timeLabel('', 'en', 'America/Toronto')).toBe('');
	});

	it('shows the existing dot for an invalid instant or a missing network zone', () => {
		expect(timeLabel('not-a-date', 'en', 'America/Toronto')).toBe('·');
		expect(timeLabel('2026-07-14T23:21:00Z', 'en', undefined)).toBe('·');
		expect(timeLabel('2026-07-14T23:21:00Z', 'fr', '')).toBe('·');
	});

	it('does not read the host clock when the network zone is missing', () => {
		expect(timeLabel('2026-07-14T23:21:00Z', 'en')).toBe('·');
		expect(timeLabel('2026-11-14T05:00:00Z', 'fr')).toBe('·');
	});

	it('keeps the invalid-instant dot before refusing an explicitly invalid zone', () => {
		expect(timeLabel('not-a-date', 'en', 'Not/AZone')).toBe('·');
	});

	it('refuses an explicitly invalid network zone instead of repairing it', () => {
		expect(() => timeLabel('2026-07-14T23:21:00Z', 'en', 'Not/AZone')).toThrow(RangeError);
	});
});
