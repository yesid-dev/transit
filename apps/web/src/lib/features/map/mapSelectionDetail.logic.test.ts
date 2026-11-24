// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { IsoUtc } from '#lib/v1/schemas/index.ts';
import type { MapSelectionDetail } from './selectionSession/mapSelection';
import * as detailLogic from './mapSelectionDetail.logic';
import { timeLabel } from './mapSelectionDetail.logic';

type DetailAction = { href: string; label: string } | null;
const iso = (value: string) => value as IsoUtc;

function actionFor(detail: MapSelectionDetail, locale: 'en' | 'fr' = 'en'): DetailAction {
	const detailActions = (
		detailLogic as {
			detailActions?: (item: MapSelectionDetail, locale: 'en' | 'fr') => DetailAction;
		}
	).detailActions;
	expect(detailActions).toBeTypeOf('function');
	return detailActions?.(detail, locale) ?? null;
}

const routeDetail = {
	kind: 'route',
	id: '24',
	title: 'wrong resolver title',
	route: {
		id: '24',
		generated_utc: iso('2026-06-15T00:00:00Z'),
		long: 'Sherbrooke',
		directions: [],
	},
	direction: null,
	directions: [],
	vehicles: [],
	alerts: [],
} as MapSelectionDetail;

const stopDetail = {
	kind: 'stop',
	id: 'stop-missing-name',
	title: 'wrong resolver title',
	stop: { id: 'stop-missing-name', code: null, name: 'ignored', nameAbsent: true },
	departures: [],
	vehicles: [],
	routeTimes: [],
	alerts: [],
} as unknown as MapSelectionDetail;

describe('detailActions', () => {
	it('uses the entity-specific route and stop action labels', () => {
		expect(actionFor(routeDetail)).toEqual({
			href: '/lines/24',
			label: 'Open the full analysis for line 24',
		});
		expect(actionFor(stopDetail)).toEqual({
			href: '/stop/stop-missing-name',
			label: 'Open the full analysis for stop stop-missing-name',
		});
	});

	it('prefers a vehicle trip action over its route fallback', () => {
		const action = actionFor({
			kind: 'vehicle',
			id: 'veh-trip',
			title: 'ignored',
			vehicle: {
				id: 'veh-trip',
				lat: 45.5,
				lon: -73.6,
				status: 'late',
				updated_utc: iso('2026-06-15T00:00:00Z'),
				route: '24',
				trip: 'trip-24-a',
				next_stop: null,
				bearing: null,
				delay_min: 4,
				occupancy: null,
			},
			trip: null,
			route: null,
			routeDirection: null,
			routeDirectionVariant: null,
			nextStop: null,
			nextStopAbsence: 'not-reported',
			pastStops: [],
			nextStops: [],
			alerts: [],
			routeType: null,
		});

		expect(action).toEqual({
			href: '/trip/trip-24-a',
			label: 'Open the full analysis for trip trip-24-a',
		});
	});
	it('keeps a vehicle without a trip honest by falling back to its known route', () => {
		const action = actionFor({
			kind: 'vehicle',
			id: 'veh-24',
			title: 'Route 24',
			vehicle: {
				id: 'veh-24',
				lat: 45.5,
				lon: -73.6,
				status: 'late',
				updated_utc: iso('2026-06-15T00:00:00Z'),
				route: '24',
				trip: null,
				next_stop: null,
				bearing: null,
				delay_min: 4,
				occupancy: null,
			},
			trip: null,
			route: null,
			routeDirection: null,
			routeDirectionVariant: null,
			nextStop: null,
			nextStopAbsence: 'not-reported',
			pastStops: [],
			nextStops: [],
			alerts: [],
			routeType: null,
		});

		expect(action).toEqual({
			href: '/lines/24',
			label: 'Open the full analysis for line 24',
		});
	});

	it('does not invent an exit for a vehicle with neither trip nor route', () => {
		const action = actionFor({
			kind: 'vehicle',
			id: 'veh-none',
			title: 'Vehicle veh-none',
			vehicle: {
				id: 'veh-none',
				lat: 45.5,
				lon: -73.6,
				status: 'unknown',
				updated_utc: iso('2026-06-15T00:00:00Z'),
				route: null,
				trip: null,
				next_stop: null,
				bearing: null,
				delay_min: null,
				occupancy: null,
			},
			trip: null,
			route: null,
			routeDirection: null,
			routeDirectionVariant: null,
			nextStop: null,
			nextStopAbsence: 'not-reported',
			pastStops: [],
			nextStops: [],
			alerts: [],
			routeType: null,
		});

		expect(action).toBeNull();
	});
});

describe('detailIdentity', () => {
	it('localizes route identity for the shell heading without using resolver title copy', () => {
		const detailIdentity = (
			detailLogic as { detailIdentity?: (item: MapSelectionDetail, locale: 'en' | 'fr') => string }
		).detailIdentity;
		expect(detailIdentity).toBeTypeOf('function');
		const detail = {
			kind: 'route',
			id: '24',
			title: 'Route 24',
			route: {
				id: '24',
				generated_utc: iso('2026-06-15T00:00:00Z'),
				long: 'Sherbrooke',
				directions: [],
			},
			direction: null,
			directions: [],
			vehicles: [],
			alerts: [],
		} as MapSelectionDetail;

		expect(detailIdentity?.(detail, 'fr')).toBe('Ligne 24');
	});

	it('identifies vehicles by bus id and stops through the honest display fallback in both locales', () => {
		const detailIdentity = (
			detailLogic as { detailIdentity?: (item: MapSelectionDetail, locale: 'en' | 'fr') => string }
		).detailIdentity;
		const vehicle = {
			kind: 'vehicle',
			id: 'veh-24',
			title: 'Route 24',
			vehicle: {
				id: 'veh-24',
				lat: 45.5,
				lon: -73.6,
				status: 'late',
				updated_utc: iso('2026-06-15T00:00:00Z'),
				route: '24',
				trip: null,
				next_stop: null,
				bearing: null,
				delay_min: 4,
				occupancy: null,
			},
			trip: null,
			route: null,
			routeDirection: null,
			routeDirectionVariant: null,
			nextStop: null,
			nextStopAbsence: 'not-reported',
			pastStops: [],
			nextStops: [],
			alerts: [],
			routeType: null,
		} as MapSelectionDetail;

		expect(detailIdentity?.(vehicle, 'en')).toBe('Vehicle veh-24');
		expect(detailIdentity?.(vehicle, 'fr')).toBe('Véhicule veh-24');
		expect(detailIdentity?.(stopDetail, 'en')).toBe('Stop stop-missing-name (name unavailable)');
		expect(detailIdentity?.(stopDetail, 'fr')).toBe('Arrêt stop-missing-name (nom indisponible)');
	});

	it('keeps French action labels entity-specific', () => {
		expect(actionFor(routeDetail, 'fr')?.label).toBe('Voir l’analyse complète de la ligne 24');
		expect(actionFor(stopDetail, 'fr')?.label).toBe(
			'Voir l’analyse complète de l’arrêt stop-missing-name',
		);
	});
});

describe('timeLabel', () => {
	it.each([
		['2026-07-14T23:21:00Z', 'America/Toronto', 'en', '19:21'],
		['2026-07-14T23:21:00Z', 'America/Toronto', 'fr', '19:21'],
		['2026-07-14T23:21:00Z', 'America/Vancouver', 'en', '16:21'],
		['2026-07-14T23:21:00Z', 'America/Vancouver', 'fr', '16:21'],
		['2026-11-14T05:00:00Z', 'America/Toronto', 'en', '00:00'],
		['2026-11-14T05:00:00Z', 'America/Toronto', 'fr', '00:00'],
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
