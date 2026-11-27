import { beforeEach, expect, it, vi } from 'vitest';
import { load } from './+page.server';

const getRecordAnswer = vi.hoisted(() => vi.fn());
vi.mock('#lib/server/engine.ts', () => ({
	getRecordAnswer,
	getCachedVehicleIndex: async () => ({ kind: 'unconfigured' }),
}));

function loadVehicle(id: string) {
	const url = new URL('https://transit.yesid.dev/vehicle/' + id + '?frameMode=live');
	return load({
		params: { id },
		url,
		request: new Request(url),
		parent: async () => ({
			providerId: 'stm',
			lang: 'en',
			provider: { inputs: { vehicle_positions: false } },
		}),
	} as unknown as Parameters<typeof load>[0]);
}

beforeEach(() => getRecordAnswer.mockReset());

it('distinguishes unknown vehicles from vehicles in the archive', async () => {
	const archive = (cells: unknown[]) => ({
		kind: 'answer',
		answer: { cells, evidence: { days_included: ['2026-11-15'] } },
	});
	getRecordAnswer.mockResolvedValueOnce(archive([]));
	await expect(loadVehicle('unknown')).rejects.toMatchObject({ status: 404 });
	getRecordAnswer.mockResolvedValueOnce(archive([{ key: { vehicle: 'retired' } }]));
	await expect(loadVehicle('retired')).resolves.toMatchObject({ id: 'retired' });
});
