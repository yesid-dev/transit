import { beforeEach, expect, it, vi } from 'vitest';
import { GET } from './+server';

const { getSearchIndex, getScheduleEdition } = vi.hoisted(() => ({
	getSearchIndex: vi.fn(),
	getScheduleEdition: vi.fn(),
}));
vi.mock('#lib/server/engine.ts', () => ({ getSearchIndex, getScheduleEdition }));

const url = new URL('https://transit.test/api/search-index?city=demo');
const event = { url, request: new Request(url) } as Parameters<typeof GET>[0];
const answer = { schedule: null, vehicles: null, vehicle_state: 'not_tracked' };

beforeEach(() => {
	getSearchIndex.mockReset();
	getScheduleEdition.mockResolvedValue(null);
});

it('lets the browser reuse a checked index for five minutes, including the last copy', async () => {
	getSearchIndex.mockResolvedValue({ kind: 'answer', lastGood: true, answer });
	const response = await GET(event);
	expect(response.status).toBe(200);
	expect(response.headers.get('cache-control')).toBe('private, max-age=300');
	await expect(response.json()).resolves.toEqual(answer);
});

it('does not cache an unavailable index', async () => {
	getSearchIndex.mockResolvedValue({ kind: 'busy' });
	const response = await GET(event);
	expect(response.status).toBe(503);
	expect(response.headers.get('cache-control')).toBeNull();
});
