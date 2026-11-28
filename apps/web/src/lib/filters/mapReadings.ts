export const MAP_TIME_BANDS = [
	{ id: 'overnight', from: 0, to: 5, en: 'Overnight', fr: 'Nuit' },
	{ id: 'morning', from: 5, to: 9, en: 'Morning', fr: 'Matin' },
	{ id: 'midday', from: 9, to: 15, en: 'Midday', fr: 'Milieu de journée' },
	{ id: 'afternoon', from: 15, to: 19, en: 'Afternoon', fr: 'Après-midi' },
	{ id: 'evening', from: 19, to: 24, en: 'Evening', fr: 'Soirée' },
] as const;

export type MapTimeBand = (typeof MAP_TIME_BANDS)[number]['id'];
export type MapTimeChoice = MapTimeBand | `${number}-${number}`;

export interface MapReadingFilters {
	readonly vehicleType?: number;
	readonly timeOfDay?: MapTimeChoice;
	readonly direction?: 0 | 1;
}

export const MAP_READING_KEYS = ['vehicleType', 'timeOfDay', 'mapDirection'] as const;

export function readMapVehicleType(value: string | null): number | undefined {
	if (value === null || !/^\d{1,4}$/u.test(value)) return undefined;
	const type = Number(value);
	return type <= 1702 ? type : undefined;
}

export function readMapHours(
	from: string | null,
	to: string | null,
): readonly [number, number] | undefined {
	if (from === null || to === null || !/^\d{1,2}$/u.test(from) || !/^\d{1,2}$/u.test(to))
		return undefined;
	const start = Number(from);
	const end = Number(to);
	return start < 24 && end <= 24 && start !== end ? [start, end] : undefined;
}

export function mapReadingHours(
	timeOfDay: MapTimeChoice | undefined,
): readonly [number, number] | undefined {
	const band = MAP_TIME_BANDS.find((item) => item.id === timeOfDay);
	if (band) return [band.from, band.to];
	const [from, to] = timeOfDay?.split('-') ?? [];
	return readMapHours(from ?? null, to ?? null);
}

export function hasMapReadingFilters(filters?: MapReadingFilters): boolean {
	return (
		filters?.vehicleType !== undefined ||
		filters?.timeOfDay !== undefined ||
		filters?.direction !== undefined
	);
}

export function readMapReadingFilters(params: URLSearchParams): MapReadingFilters | undefined {
	const vehicleType = readMapVehicleType(params.get('vehicleType'));
	const value = params.get('timeOfDay');
	const band = MAP_TIME_BANDS.find((item) => item.id === value);
	const [from, to] = value?.split('-') ?? [];
	const hours = from && to && `${from}-${to}` === value ? readMapHours(from, to) : undefined;
	const timeOfDay = band?.id ?? (hours ? (`${hours[0]}-${hours[1]}` as const) : undefined);
	const rawDirection = params.get('mapDirection');
	const direction = rawDirection === '0' ? 0 : rawDirection === '1' ? 1 : undefined;
	const filters: MapReadingFilters = { vehicleType, timeOfDay, direction };
	return hasMapReadingFilters(filters) ? filters : undefined;
}

export function writeMapReadingFilters(params: URLSearchParams, filters?: MapReadingFilters): void {
	if (filters?.vehicleType !== undefined) params.set('vehicleType', String(filters.vehicleType));
	if (filters?.timeOfDay !== undefined) params.set('timeOfDay', filters.timeOfDay);
	if (filters?.direction !== undefined) params.set('mapDirection', String(filters.direction));
}
import type { Vehicle } from '#lib/v1/schemas/vehicles.ts';

export function matchMapVehicleReading(
	filters: MapReadingFilters,
	routeType: (id: string) => number | null | undefined,
	timeZone: string,
): (vehicle: Vehicle) => boolean {
	const range = mapReadingHours(filters.timeOfDay);
	const localHour = range
		? new Intl.DateTimeFormat('en', { hour: 'numeric', hourCycle: 'h23', timeZone })
		: undefined;
	return (vehicle) => {
		if (
			filters.vehicleType !== undefined &&
			(!vehicle.route || routeType(vehicle.route) !== filters.vehicleType)
		)
			return false;
		if (filters.direction !== undefined && vehicle.direction_id !== filters.direction) return false;
		if (!range || !localHour) return true;
		const time = Date.parse(vehicle.reported_utc ?? vehicle.updated_utc);
		if (!Number.isFinite(time)) return false;
		const hour = Number(localHour.format(time));
		const [from, to] = range;
		return from < to ? hour >= from && hour < to : hour >= from || hour < to;
	};
}
