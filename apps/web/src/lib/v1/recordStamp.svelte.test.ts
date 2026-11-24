import { afterEach, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import fixture from '../../../scripts/__fixtures__/b9/rich.json';
import { HistoricAvailabilityIndexSchema, ManifestSchema } from './schemas';
import { recordStamp, stampText } from './stamp';
import {
	installBrowserAdapterManifest,
	clearBrowserAdapterManifestForTests,
} from './adapter/browserManifest';
import { createRecordStamp, showRecord, shownRecord } from './recordStamp.svelte';
import { createStopHistoryResource } from '#lib/features/stops/reliability/data/stopHistoryResource.svelte.ts';
import { historyRangeRequestFromSearchParams } from './history/rangeResource.svelte';

const manifest = ManifestSchema.parse(fixture.files['manifest.json']);
it('a mounted record stamp is the shown record until it unmounts', () => {
	let generatedUtc = $state('2026-11-11T00:00:00Z');
	const dispose = $effect.root(() => {
		createRecordStamp(
			() => null,
			() => generatedUtc,
		);
	});
	flushSync();
	const page = shownRecord();
	expect(page?.stamp.form).toBe('record');
	expect(shownRecord()).toBe(page);
	generatedUtc = '2026-11-18T00:00:00Z';
	flushSync();
	expect(shownRecord()).toBe(page);
	expect(page?.stamp.publishedOn).toBe('2026-11-18');
	const other = recordStamp({ manifest: null, historyIndex: null, day: '2026-11-11' });
	const disposeOther = $effect.root(() => {
		showRecord(() => other);
	});
	flushSync();
	expect(shownRecord()?.stamp).toBe(other);
	dispose();
	expect(shownRecord()?.stamp).toBe(other);
	disposeOther();
	expect(shownRecord()).toBeNull();
});
afterEach(() => {
	vi.unstubAllGlobals();
	clearBrowserAdapterManifestForTests();
});
it.each(['stop', 'P12a'] as const)(
	'reads the root index once for %s and its record stamp',
	async (path) => {
		const files: Record<string, unknown> = fixture.files;
		const request = vi.fn(async (input: RequestInfo | URL) => {
			const key = new URL(String(input), 'https://fixture.test').pathname.split(
				'/' + manifest.provider + '/',
			)[1];
			return new Response(JSON.stringify(files[key] ?? {}), { status: key in files ? 200 : 404 });
		});
		vi.stubGlobal('fetch', request);
		installBrowserAdapterManifest(() => manifest);
		const selection = historyRangeRequestFromSearchParams(
			new URLSearchParams('from=2026-08-27&to=2026-08-29'),
		);
		let history: ReturnType<typeof createStopHistoryResource> | undefined;
		let stamp!: ReturnType<typeof createRecordStamp>;
		const dispose = $effect.root(() => {
			if (path === 'stop') history = createStopHistoryResource('52095', selection);
			stamp = createRecordStamp(
				() => manifest,
				() => fixture.frozen_utc,
				history ? () => history! : undefined,
			);
		});
		try {
			flushSync();
			await vi.waitFor(() => expect(stamp.pending).toBe(false));
			expect(history?.error ?? null).toBeNull();
			expect(stamp.meta('en')?.datetime).toBe(fixture.frozen_utc.slice(0, 10));
			expect(stamp.meta('en')?.text).toBe(
				stampText(
					recordStamp({
						manifest,
						historyIndex: HistoricAvailabilityIndexSchema.parse(
							files['historic/history/index.json'],
						),
						fileGeneratedUtc: fixture.frozen_utc,
					}),
					'en',
					manifest.tz,
				),
			);
			expect(
				request.mock.calls.filter(([url]) => String(url).endsWith('/historic/history/index.json')),
			).toHaveLength(1);
		} finally {
			history?.destroy();
			dispose();
		}
	},
);

const rollup = (verdict: string | null, published: string | null = fixture.frozen_utc) => ({
	generated_utc: fixture.frozen_utc,
	lanes: [{ lane: 'rollup', last_publish_utc: published, gate: verdict && { verdict } }],
});
const W10 = 'Ce bilan a été publié avec un avertissement. Voir Santé des données.';
it.each([
	['warned on this publication', true, rollup('warn'), W10],
	['failed', true, rollup('fail'), null],
	['passed', true, rollup('pass'), null],
	['ran no check', true, rollup(null), null],
	[
		'is stale: it warned on the publication a week before',
		true,
		rollup('warn', '2026-08-23T16:00:00Z'),
		null,
	],
	[
		'is stale: it warned on an earlier publication the same day',
		true,
		rollup('warn', '2026-08-30T01:00:00Z'),
		null,
	],
	['warned on a later publication', true, rollup('warn', '2026-08-30T17:00:00Z'), null],
	['warned without saying which publication', true, rollup('warn', null), null],
	['is missing', true, 404, null],
	['cannot be read', true, 'offline', null],
	['warned, on another tab', false, rollup('warn'), null],
	['warned, on a page without the row', undefined, rollup('warn'), null],
] as const)(
	'record data health that %s: the warning row and its read',
	async (_, shown, health, notice) => {
		const reads: string[] = [];
		vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
			if (!String(input).endsWith('/status/data_health.json'))
				return new Response('{}', { status: 404 });
			reads.push(String(input));
			if (health === 'offline') throw new TypeError('offline');
			return health === 404
				? new Response('{}', { status: 404 })
				: new Response(JSON.stringify(health));
		});
		installBrowserAdapterManifest(() => manifest);
		let stamp!: ReturnType<typeof createRecordStamp>;
		const dispose = $effect.root(() => {
			stamp = createRecordStamp(
				() => manifest,
				() => fixture.frozen_utc,
				undefined,
				shown === undefined ? undefined : () => shown,
			);
		});
		try {
			flushSync();
			await vi.waitFor(() => expect(stamp.pending).toBe(false));
			expect(reads).toHaveLength(shown ? 1 : 0);
			expect(stamp.notice('fr')).toBe(notice);
			expect(stamp.notice('en')).toBe(
				notice && 'This record was published with a warning. See Data health.',
			);
			// Whatever data health says, the stamp itself reads exactly as without it.
			expect(stamp.meta('en')).toEqual({
				text: stampText(
					recordStamp({ manifest, historyIndex: null, fileGeneratedUtc: fixture.frozen_utc }),
					'en',
					manifest.tz,
				),
				datetime: fixture.frozen_utc.slice(0, 10),
				// Where the row can show, the header holds the warning's room whether it shows or not.
				recordStamp: {
					pending: false,
					reserve: 'Record · data through Sep 30, 1999 · published Sep 30, 1999',
					noticeReserve: shown
						? 'This record was published with a warning. See Data health.'
						: null,
				},
			});
		} finally {
			dispose();
		}
	},
);

it.each(['settled', 'in flight'] as const)(
	'keeps one data health read across Record, another tab and Record again (left while %s)',
	async (when) => {
		let shown = $state(true);
		const reads: string[] = [];
		let release = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
			if (!String(input).endsWith('/status/data_health.json'))
				return new Response('{}', { status: 404 });
			reads.push(String(input));
			if (when === 'in flight') await held;
			return new Response(JSON.stringify(rollup('warn')));
		});
		installBrowserAdapterManifest(() => manifest);
		let stamp!: ReturnType<typeof createRecordStamp>;
		const dispose = $effect.root(() => {
			stamp = createRecordStamp(
				() => manifest,
				() => fixture.frozen_utc,
				undefined,
				() => shown,
			);
		});
		try {
			flushSync();
			if (when === 'settled') await vi.waitFor(() => expect(stamp.pending).toBe(false));
			else await vi.waitFor(() => expect(reads).toHaveLength(1));
			shown = false;
			flushSync();
			shown = true;
			flushSync();
			release();
			await vi.waitFor(() => expect(stamp.pending).toBe(false));
			expect(reads).toHaveLength(1);
			expect(stamp.notice('en')).toBe('This record was published with a warning. See Data health.');
		} finally {
			dispose();
		}
	},
);
