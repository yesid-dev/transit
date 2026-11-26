import { describe, expect, it, vi } from 'vitest';
import type { r2Adapter } from './r2';

vi.mock('$app/env', () => ({ browser: true }));

const evaluated = vi.hoisted(() => ({
	live: 0,
	static: 0,
}));

vi.mock('#lib/v1/schemas/data_health.ts', async (importOriginal) => {
	evaluated.live += 1;
	return importOriginal<typeof import('#lib/v1/schemas/data_health.ts')>();
});

vi.mock('#lib/v1/schemas/routes_index.ts', async (importOriginal) => {
	evaluated.static += 1;
	return importOriginal<typeof import('#lib/v1/schemas/routes_index.ts')>();
});

const PORT_METHODS = {
	live: ['vehicles', 'trips', 'stopDepartures', 'alerts', 'network'],
	static: ['routesIndex', 'route', 'stopsIndex', 'stop'],
	basemap: ['get'],
} as const satisfies Record<keyof typeof r2Adapter, readonly string[]>;

interface ObjectSnapshot {
	keys: readonly PropertyKey[];
	values: ReadonlyMap<PropertyKey, unknown>;
}

function expectOrdinaryValueObject(value: object, expectedKeys: readonly string[]): void {
	const ownKeys = Reflect.ownKeys(value);

	expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
	expect(Object.isFrozen(value)).toBe(false);
	expect(new Set(ownKeys)).toEqual(new Set(expectedKeys));
	for (const key of expectedKeys) {
		expect(Object.getOwnPropertyDescriptor(value, key)).toEqual({
			value: Reflect.get(value, key),
			writable: true,
			enumerable: true,
			configurable: true,
		});
	}
}

function snapshotObject(value: object): ObjectSnapshot {
	const keys = Reflect.ownKeys(value);
	return {
		keys,
		values: new Map(keys.map((key) => [key, Reflect.get(value, key)])),
	};
}

function expectUnchanged(value: object, snapshot: ObjectSnapshot): void {
	expect(new Set(Reflect.ownKeys(value))).toEqual(new Set(snapshot.keys));
	for (const key of snapshot.keys) {
		expect(Reflect.get(value, key)).toBe(snapshot.values.get(key));
	}
}

describe('r2 lazy adapter boundaries', () => {
	it('does not evaluate tier schemas when only the adapter root is imported', async () => {
		const { r2Adapter } = await import('./r2');

		expect(evaluated).toEqual({
			live: 0,
			static: 0,
		});
		expect(r2Adapter).toBeDefined();
	});

	it('exposes stable ordinary value objects for the facade and its capture and schedule ports', async () => {
		const { r2Adapter } = await import('./r2');
		const facade = r2Adapter as unknown as Record<string, object>;

		expectOrdinaryValueObject(r2Adapter, Object.keys(PORT_METHODS));
		const facadeSnapshot = snapshotObject(r2Adapter);
		for (const [portName, methodNames] of Object.entries(PORT_METHODS)) {
			const port = facade[portName];
			expectOrdinaryValueObject(port, methodNames);
			expectUnchanged(port, snapshotObject(port));
		}
		expectUnchanged(r2Adapter, facadeSnapshot);
	});
});
