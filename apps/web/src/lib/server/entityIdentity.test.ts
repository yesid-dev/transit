import { beforeEach, expect, it, vi } from 'vitest';
import { captureSnapshotSchema } from '#lib/live/captureSnapshot.ts';
import { lineIdentity, vehicleIdentity } from './entityIdentity.ts';

const engine = vi.hoisted(() => ({ getCachedVehicleIndex: vi.fn(), getRecordAnswer: vi.fn() }));
vi.mock('./engine.ts', () => engine);

const clock = { today: '2026-11-27', recordThrough: '2026-11-24' };
const scope = { city: 'stm' };
const held = <T>() => new Promise<T>(() => {});

function capture(ids: string[]) {
	const now = new Date().toISOString();
	return captureSnapshotSchema.parse({
		version: 2,
		city: 'stm',
		published_at: now,
		stable_vehicle_ids: true,
		alerts: null,
		feeds: {
			positions: {
				family: 'vehicle_positions',
				captured_at: now,
				source_at: now,
				read_failed: false,
				fresh_for_seconds: 60,
				source_lag_seconds: 0,
			},
		},
		vehicle_positions: ids.map((id) => ({
			id,
			vehicle_id: id,
			trip_id: null,
			start_date: null,
			start_time: null,
			route_id: null,
			direction_id: null,
			latitude: 45.5,
			longitude: -73.6,
			bearing: null,
			speed_mps: null,
			stop_id: null,
			stop_sequence: null,
			status: null,
			occupancy: null,
			occupancy_percentage: null,
			observed_at: now,
			delay: null,
		})),
	});
}

function recentVehicleIds(ids: string[], stale = false) {
	return {
		kind: 'answer',
		cacheStale: stale,
		answer: { vehicle_state: 'ready', vehicles: ids.map((id) => ({ id })) },
	};
}

beforeEach(() => {
	engine.getCachedVehicleIndex.mockReset().mockResolvedValue({ kind: 'unreachable' });
	engine.getRecordAnswer.mockReset().mockResolvedValue({
		kind: 'answer',
		answer: { cells: [], evidence: { days_included: ['2026-11-24'] } },
	});
});

it('uses a current vehicle without waiting for the index or asking the archive', async () => {
	engine.getCachedVehicleIndex.mockReturnValueOnce(held());
	await expect(
		vehicleIdentity('V1', clock, scope, true, async () => capture(['V1'])),
	).resolves.toBe('available');
	expect(engine.getRecordAnswer).not.toHaveBeenCalled();
});

it('uses a cached vehicle without waiting for live positions or asking the archive', async () => {
	engine.getCachedVehicleIndex.mockResolvedValueOnce(recentVehicleIds(['V1'], true));
	await expect(vehicleIdentity('V1', clock, scope, true, held)).resolves.toBe('available');
	expect(engine.getRecordAnswer).not.toHaveBeenCalled();
});

it('uses the closed published Record for an ID missing from the cheap sources', async () => {
	engine.getCachedVehicleIndex.mockResolvedValueOnce(recentVehicleIds([]));
	await expect(vehicleIdentity('V1', clock, scope, true, async () => capture([]))).resolves.toBe(
		'missing',
	);
	expect(engine.getRecordAnswer).toHaveBeenCalledExactlyOnceWith(
		{
			path: '/measure',
			parameters: { measure: 'vehicle_days_in_service', group: 'vehicle', vehicle: 'V1' },
		},
		{ city: 'stm', from: '2026-10-13', to: '2026-11-24' },
	);
});

it('uses a recent miss to look for an archived vehicle without declaring absence during a live outage', async () => {
	engine.getCachedVehicleIndex.mockResolvedValueOnce(recentVehicleIds([]));
	await expect(vehicleIdentity('V1', clock, scope, true, async () => null)).resolves.toBe(
		'unconfirmed',
	);
	expect(engine.getRecordAnswer).toHaveBeenCalledOnce();
});

it('leaves identity unconfirmed during simultaneous live and timetable outages without asking the archive', async () => {
	engine.getCachedVehicleIndex.mockResolvedValueOnce(recentVehicleIds([], true));
	await expect(vehicleIdentity('V1', clock, scope, true, async () => null)).resolves.toBe(
		'unconfirmed',
	);
	await expect(lineIdentity('L1', clock, scope, null)).resolves.toBe('unconfirmed');
	expect(engine.getRecordAnswer).not.toHaveBeenCalled();
});
