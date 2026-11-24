import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';

export function dailyMessageHold(request: APIRequestContext) {
	const scope = `daily-messages-${randomUUID()}`;
	const port = process.env.TRANSIT_E2E_DATA_PORT ?? '4318';
	const action = (name: 'hold' | 'release') =>
		request.post(`http://127.0.0.1:${port}/__overview/${name}?fixture=${scope}`);
	return {
		headers: { 'x-transit-fixture-scope': scope },
		start: () => action('hold'),
		release: () => action('release'),
	};
}
