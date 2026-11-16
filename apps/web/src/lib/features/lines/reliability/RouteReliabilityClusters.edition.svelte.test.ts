import { render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RouteReliability } from '#lib/v1/index.ts';
import { withClosedPeriods } from './__fixtures__/closedWeek';

const harness = vi.hoisted(() => ({
	page: {
		url: new URL('http://localhost/lines/6?provider=octranspo'),
		state: {},
	},
}));

vi.mock('$app/state', () => ({ page: harness.page }));
vi.mock('$app/navigation', () => ({ afterNavigate: () => {} }));
vi.mock('@yesid/motion/stores/reducedMotion', () => ({
	prefersReducedMotion: {
		subscribe(run: (value: boolean) => void) {
			run(false);
			return () => {};
		},
	},
	isPrefersReducedMotion: () => false,
}));
vi.mock('#lib/v1/index.ts', async () => ({
	...(await import('#lib/v1/history/index.ts')),
	wilsonBounds: (await import('#lib/v1/stats.ts')).wilsonBounds,
}));

import RouteReliabilityClusters from './RouteReliabilityClusters.svelte';
import { reliabilityCopy } from './reliability.copy';

const identity = {
	publish_generation_id: 'octranspo@2026-11-11T06:00:00Z',
	methodology_version: 'reliability-2',
};

function thirtyDays(overrides: Partial<RouteReliability> = identity): RouteReliability {
	const end = Date.parse('2026-11-10T00:00:00Z');
	return withClosedPeriods({
		id: '6',
		generated_utc: '2026-11-11T06:00:00Z',
		...overrides,
		periods: Array.from({ length: 30 }, (_, index) => ({
			grain: 'day',
			date: new Date(end - (29 - index) * 86_400_000).toISOString().slice(0, 10),
			observation_count: 100,
			on_time: index >= 23 ? [70, 72, 68, 65, 71, 79, 73][index - 23] : 80,
			otp_pct: index >= 23 ? [70, 72, 68, 65, 71, 79, 73][index - 23] : 80,
			avg_delay_min: 2.5,
		})),
	} as RouteReliability);
}

const citation = {
	line: '6 Greenboro / Rockcliffe',
	providerId: 'octranspo',
	providerName: 'OC Transpo',
};

function url(query: string): void {
	harness.page.url = new URL(`http://localhost/lines/6?provider=octranspo&${query}`);
}

const notice = (container: HTMLElement): string =>
	container.querySelector('[data-slot="record-edition"]')?.textContent?.trim() ?? '';

beforeEach(() => {
	harness.page.url = new URL('http://localhost/lines/6?provider=octranspo');
});

afterEach(() => vi.unstubAllGlobals());

describe('Record edition notice from the settled current file', () => {
	it('says nothing without a hint or when every supplied field matches', () => {
		const empty = render(RouteReliabilityClusters, {
			data: thirtyDays(),
			locale: 'en',
			citation,
		});
		expect(notice(empty.container)).toBe('');
		empty.unmount();

		url(
			'generation=octranspo%402026-11-11T06%3A00%3A00Z&published=2026-11-11T06%3A00%3A00Z&method=reliability-2',
		);
		const matching = render(RouteReliabilityClusters, {
			data: thirtyDays(),
			locale: 'en',
			citation,
		});
		expect(notice(matching.container)).toBe('');
	});

	it('states a corrected edition with the actual localized date in both languages', () => {
		url('generation=old-g&published=2026-11-04T06%3A00%3A00Z&method=reliability-1');
		const en = render(RouteReliabilityClusters, {
			data: thirtyDays(),
			locale: 'en',
			citation,
		});
		expect(notice(en.container)).toBe(
			'This record was corrected after this link was made. Showing the current edition, published Nov 11, 2026.',
		);
		en.unmount();

		url('generation=old-g&published=2026-11-04T06%3A00%3A00Z&method=reliability-1');
		const fr = render(RouteReliabilityClusters, {
			data: thirtyDays(),
			locale: 'fr',
			citation,
		});
		expect(notice(fr.container)).toBe(
			'Ce bilan a été corrigé après la création de ce lien. Voici l’édition actuelle, publiée le 11 nov. 2026.',
		);
	});

	it('keeps a same-generation metadata conflict neutral, never corrected', () => {
		url(
			'generation=octranspo%402026-11-11T06%3A00%3A00Z&published=2026-11-11T06%3A00%3A00Z&method=reliability-1',
		);
		const view = render(RouteReliabilityClusters, {
			data: thirtyDays(),
			locale: 'en',
			citation,
		});
		expect(notice(view.container)).toBe(reliabilityCopy.en.record.edition.different);
	});

	it('marks a requested generation unverifiable when the available file supplies none', () => {
		url(
			'generation=octranspo%402026-11-11T06%3A00%3A00Z&published=2026-11-11T06%3A00%3A00Z&method=reliability-2',
		);
		const view = render(RouteReliabilityClusters, {
			data: thirtyDays({ methodology_version: 'reliability-2' }),
			locale: 'en',
			citation,
		});
		expect(notice(view.container)).toBe(reliabilityCopy.en.record.edition.unverifiable);
	});

	it('ignores duplicate and malformed hints instead of guessing an edition', () => {
		url('generation=a&generation=b&published=not-a-date&method=reliability-2');
		const view = render(RouteReliabilityClusters, {
			data: thirtyDays(),
			locale: 'en',
			citation,
		});
		expect(notice(view.container)).toBe('');
	});

	it('updates the conclusion after a refresh without borrowing the previous file', async () => {
		url('generation=old-g&published=2026-11-04T06%3A00%3A00Z&method=reliability-1');
		const view = render(RouteReliabilityClusters, {
			data: thirtyDays(),
			locale: 'en',
			citation,
		});
		expect(notice(view.container)).toContain('published Nov 11, 2026.');

		await view.rerender({
			data: thirtyDays({
				generated_utc: '2026-12-02T06:00:00Z' as RouteReliability['generated_utc'],
				publish_generation_id: 'octranspo@2026-12-02T06:00:00Z',
				methodology_version: 'reliability-2',
			}),
			locale: 'en',
			citation,
		});
		await waitFor(() => expect(notice(view.container)).toContain('published Dec 2, 2026.'));
	});
});
