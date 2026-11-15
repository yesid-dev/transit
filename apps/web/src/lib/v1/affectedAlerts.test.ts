import { describe, expect, it } from 'vitest';
import type { Alert } from './schemas';
import { alertsForRoute } from './affectedAlerts';

const ALERTS = [
	{ id: 'a1', severity: 'high', header_key: 'A1', stops: ['S1'] },
	{ id: 'a2', severity: 'critical', header_key: 'A2', routes: ['R1'] },
	{ id: 'a3', severity: 'watch', header_key: 'A3', routes: ['R9'], stops: ['S9'] },
	{ id: 'a4', severity: 'high', header_key: 'A4', routes: ['R1'], stops: ['S2'] },
] as unknown as Alert[];

describe('alertsForRoute', () => {
	it('returns alerts whose routes[] lists the route id, severity-first', () => {
		const out = alertsForRoute(ALERTS, 'R1');
		expect(out.map((a) => a.id)).toEqual(['a2', 'a4']);
	});

	it('does not match a route-less or differently-scoped alert', () => {
		expect(alertsForRoute(ALERTS, 'R9').map((a) => a.id)).toEqual(['a3']);
		expect(alertsForRoute(ALERTS, 'R404')).toEqual([]);
	});

	it('sorts by severity desc, stable (source order) within a tier', () => {
		const set = [
			{ id: 'w', severity: 'watch', header_key: 'W', routes: ['R'] },
			{ id: 'h1', severity: 'high', header_key: 'H1', routes: ['R'] },
			{ id: 'c', severity: 'critical', header_key: 'C', routes: ['R'] },
			{ id: 'h2', severity: 'high', header_key: 'H2', routes: ['R'] },
		] as unknown as Alert[];
		expect(alertsForRoute(set, 'R').map((a) => a.id)).toEqual(['c', 'h1', 'h2', 'w']);
	});

	it('stands down (empty) for null/empty inputs — never throws', () => {
		expect(alertsForRoute(null, 'R1')).toEqual([]);
		expect(alertsForRoute(undefined, 'R1')).toEqual([]);
		expect(alertsForRoute(ALERTS, '')).toEqual([]);
	});
});
