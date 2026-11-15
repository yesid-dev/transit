import { describe, expect, it } from 'vitest';
import type { Alert } from '#lib/v1/schemas/index.ts';
import { stopAccess, stopNotices } from './stopIdentity';

describe('stopAccess: unknown access is unknown, never "not accessible"', () => {
	it.each([
		[{ wheelchair_boarding: 'yes', wheelchair: true }, 'yes'],
		[{ wheelchair_boarding: 'no', wheelchair: false }, 'no'],
		// The publisher writes wheelchair=false for both "no" and "not supplied".
		[{ wheelchair_boarding: null, wheelchair: false }, 'unknown'],
		[{ wheelchair: false }, 'unknown'],
		[{}, 'unknown'],
		// Older files carry only the boolean; true was only ever written for "yes".
		[{ wheelchair: true }, 'yes'],
		[null, 'unknown'],
	] as const)('%o reads as %s', (stop, expected) => {
		expect(stopAccess(stop)).toBe(expected);
	});
});

const NOW = Date.parse('2026-11-13T15:00:00Z');
// A fresh alert report read at NOW.
const LIVE = { now: NOW, reportLive: true };

function alert(id: string, extra: Record<string, unknown> = {}): Alert {
	return { id, severity: 'watch', header_key: id, ...extra } as Alert;
}

const STOP = { id: '52409', code: '10254', routesServed: ['51', '80'] };

describe('stopNotices: scope comes from what the notice names', () => {
	it('separates notices naming the stop (by id or code) from notices naming its lines', () => {
		const notices = stopNotices(
			[
				alert('route-80', { routes: ['80', '999'] }),
				alert('by-code', { stops: ['10254'] }),
				alert('elsewhere', { routes: ['999'], stops: ['1'] }),
				alert('by-id', { stops: ['52409'], routes: ['51'] }),
				alert('route-both', { routes: ['51', '80'], severity: 'critical' }),
			],
			STOP,
			LIVE,
		);
		expect(notices.direct.map((n) => n.alert.id)).toEqual(['by-code', 'by-id']);
		expect(notices.lines.map((n) => [n.alert.id, n.lines])).toEqual([
			['route-both', ['51', '80']],
			['route-80', ['80']],
		]);
	});

	it('names only lines that serve this stop, never the notice’s other lines', () => {
		const notices = stopNotices([alert('wide', { routes: ['999', '80'] })], STOP, LIVE);
		expect(notices.lines[0].lines).toEqual(['80']);
	});

	it('counts as current only notices in effect now, leading with notices that name the stop', () => {
		const notices = stopNotices(
			[
				alert('future-direct', { stops: ['52409'], start_utc: '2026-11-20T00:00:00Z' }),
				alert('ended-line', { routes: ['51'], end_utc: '2026-11-01T00:00:00Z' }),
				alert('open-line', { routes: ['51'], severity: 'critical' }),
				alert('window-direct', {
					stops: ['52409'],
					active_periods: [{ start_utc: '2026-11-01T00:00:00Z', end_utc: '2026-11-14T00:00:00Z' }],
				}),
			],
			STOP,
			LIVE,
		);
		expect(notices.current.map((n) => [n.alert.id, n.scope])).toEqual([
			['window-direct', 'stop'],
			['open-line', 'lines'],
		]);
		expect(notices.direct.map((n) => n.alert.id)).toEqual(['future-direct', 'window-direct']);
	});

	it('uses the active periods over the outer window when the feed supplies both', () => {
		const notices = stopNotices(
			[
				alert('periods', {
					stops: ['52409'],
					start_utc: '2026-11-01T00:00:00Z',
					active_periods: [{ start_utc: '2026-11-20T00:00:00Z', end_utc: null }],
				}),
			],
			STOP,
			LIVE,
		);
		expect(notices.current).toEqual([]);
	});

	it('matches only by stop id when the stop file is unavailable', () => {
		const notices = stopNotices(
			[alert('by-id', { stops: ['52409'] }), alert('route', { routes: ['51'] })],
			{ id: '52409', code: null, routesServed: null },
			LIVE,
		);
		expect(notices.direct.map((n) => n.alert.id)).toEqual(['by-id']);
		expect(notices.lines).toEqual([]);
	});

	it('calls nothing current when the alert report is retained, stale or failed', () => {
		const notices = stopNotices(
			[alert('open-direct', { stops: ['52409'] }), alert('open-line', { routes: ['51'] })],
			STOP,
			{ now: NOW, reportLive: false },
		);
		expect(notices.current).toEqual([]);
		// The retained notices stay listed with their scope; only the "current" claim is withheld.
		expect(notices.direct.map((n) => n.alert.id)).toEqual(['open-direct']);
		expect(notices.lines.map((n) => n.alert.id)).toEqual(['open-line']);
	});

	it('returns nothing for a missing feed', () => {
		expect(stopNotices(null, STOP, LIVE)).toEqual({ direct: [], lines: [], current: [] });
	});
});
