import { render, fireEvent, waitFor, within } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StopReliability, IsoUtc } from '#lib/v1/index.ts';
import { assertRailIndependence } from '../../../../../tests/railIndependence';
import { stopReliabilityCopy } from '../stops-reliability.copy';

const motion = vi.hoisted(() => ({ reduced: false }));

let mockUrl = new URL('http://localhost/stop/57191?grain=day');
const replaceState = vi.hoisted(() =>
	vi.fn((u: string | URL) => {
		mockUrl = new URL(u, 'http://localhost');
	}),
);
vi.mock('$app/state', () => ({
	page: {
		get url() {
			return mockUrl;
		},
		state: {},
	},
}));
vi.mock('$app/navigation', () => ({ afterNavigate: () => {}, replaceState }));
vi.mock('#lib/v1/index.ts', async () => ({
	...(await import('#lib/v1/history/index.ts')),
	wilsonBounds: (await import('#lib/v1/stats.ts')).wilsonBounds,
}));
vi.mock('@yesid/motion/stores/reducedMotion', () => ({
	prefersReducedMotion: {
		subscribe(run: (value: boolean) => void) {
			run(motion.reduced);
			return () => {};
		},
	},
	isPrefersReducedMotion: () => motion.reduced,
}));

import StopReliabilitySurface from './StopReliabilitySurface.svelte';

const utc = (v: string): IsoUtc => v as IsoUtc;
const source = () =>
	readFileSync(
		resolve(
			process.cwd(),
			'src/lib/features/stops/reliability/sections/StopReliabilitySurface.svelte',
		),
		'utf-8',
	);

const data: StopReliability = {
	generated_utc: utc('2026-06-19T02:00:00Z'),
	id: '57191',
	periods: [
		{ grain: 'day', p50_min: 2.4, p90_min: 11.6, otp_pct: 82 },
		{ grain: 'week', otp_pct: 71, avg_delay_min: 3.3 },
	],
	daily: [
		{
			date: '2026-06-01',
			observation_count: 40,
			severe_count: 4,
			severe_pct: 10,
			avg_delay_min: 1.5,
		},
		{
			date: '2026-06-02',
			observation_count: 60,
			severe_count: 9,
			severe_pct: 15,
			avg_delay_min: 2.1,
		},
		{
			date: '2026-06-03',
			observation_count: 50,
			severe_count: 5,
			severe_pct: 10,
			avg_delay_min: 1.8,
		},
	],
	by_route: [{ route: '51', avg_delay_min: 6 }],
};

const desktopGroup = (c: HTMLElement): HTMLElement => {
	const rail = c.querySelector('[data-slot="surface-rail"]') as HTMLElement;
	return rail.querySelector('[role="radiogroup"]') as HTMLElement;
};

const PRESENT_SECTIONS = [
	['stop-rel-trend', 'Day by day'],
	['stop-rel-percentiles', 'Typical delay'],
	['stop-rel-pane', 'Predicted delays'],
	['stop-rel-by-route', 'Avg delay by line'],
	['stop-rel-source', 'Source and method'],
] as const;

const disclosure = (container: HTMLElement, id: string): HTMLElement =>
	container.querySelector(`[data-toc="${id}"]`) as HTMLElement;

const disclosureTrigger = (container: HTMLElement, id: string, name: string): HTMLElement =>
	within(disclosure(container, id)).getByRole('button', { name });

/** Breakdowns start closed; open one before reading inside it. */
async function openSection(container: HTMLElement, id: string, name: string) {
	const trigger = disclosureTrigger(container, id, name);
	if (trigger.getAttribute('aria-expanded') !== 'true') await fireEvent.click(trigger);
	return disclosure(container, id);
}

beforeEach(() => {
	sessionStorage.clear();
	motion.reduced = false;
});

describe('StopReliabilitySurface — grain seed + availability (S8A)', () => {
	beforeEach(() => {
		mockUrl = new URL('http://localhost/stop/57191?grain=day');
		replaceState.mockClear();
	});

	it('defaults to the same published week as the home stop ranking', () => {
		mockUrl = new URL('http://localhost/stop/57191');
		const { container } = render(StopReliabilitySurface, { props: { data, locale: 'en' } });
		const group = desktopGroup(container);
		const day = within(group).getByRole('radio', { name: 'Day' });
		const week = within(group).getByRole('radio', { name: 'Week' });
		const month = within(group).getByRole('radio', { name: 'Month' });
		expect(day).toBeEnabled();
		expect(week).toBeEnabled();
		expect(month).toBeDisabled();
		expect(week).toHaveAttribute('aria-checked', 'true');
	});

	it('seeds the rail from ?grain=week', () => {
		mockUrl = new URL('http://localhost/stop/57191?grain=week');
		const { container } = render(StopReliabilitySurface, { props: { data, locale: 'en' } });
		const week = within(desktopGroup(container)).getByRole('radio', { name: 'Week' });
		expect(week).toHaveAttribute('aria-checked', 'true');
	});

	it('keeps an unavailable explicitly selected month absent', () => {
		mockUrl = new URL('http://localhost/stop/57191?grain=month');
		const { container } = render(StopReliabilitySurface, { props: { data, locale: 'en' } });
		const month = within(desktopGroup(container)).getByRole('radio', { name: 'Month' });
		expect(month).toHaveAttribute('aria-checked', 'true');
		expect(month).toBeDisabled();
		expect(container.querySelector('[data-slot="stop-reliability-pane"]')).toBeNull();
	});

	it('falls back to week for an unknown ?grain (enum-guard, never a cast)', () => {
		mockUrl = new URL('http://localhost/stop/57191?grain=bogus');
		const { container } = render(StopReliabilitySurface, { props: { data, locale: 'en' } });
		const checked = desktopGroup(container).querySelectorAll('[role="radio"][aria-checked="true"]');
		expect(checked.length).toBe(1);
		expect(checked[0].textContent?.trim()).toBe('Week');
	});

	it('day percentiles surface only on the day grain (drop on week, no fabricated 0)', async () => {
		const { container } = render(StopReliabilitySurface, {
			props: { data, locale: 'en' },
		});
		expect(container.querySelector('[data-slot="stop-percentiles"]')?.textContent).toContain(
			'Median delay',
		);
		const week = within(desktopGroup(container)).getByRole('radio', { name: 'Week' });
		await fireEvent.click(week);
		expect(container.querySelector('[data-slot="stop-percentiles"]')).toBeNull();
	});

	it('mirrors an explicit grain choice including day', async () => {
		const { container } = render(StopReliabilitySurface, { props: { data, locale: 'en' } });
		expect(replaceState).not.toHaveBeenCalled();

		const week = within(desktopGroup(container)).getByRole('radio', { name: 'Week' });
		await fireEvent.click(week);
		expect(mockUrl.searchParams.get('grain')).toBe('week');

		const day = within(desktopGroup(container)).getByRole('radio', { name: 'Day' });
		await fireEvent.click(day);
		expect(mockUrl.searchParams.get('grain')).toBe('day');
	});

	it('preserves an existing ?tab when mirroring grain (mirror merges, single-key)', async () => {
		mockUrl = new URL('http://localhost/stop/57191?tab=reliability');
		const { container } = render(StopReliabilitySurface, { props: { data, locale: 'en' } });
		const week = within(desktopGroup(container)).getByRole('radio', { name: 'Week' });
		await fireEvent.click(week);
		expect(mockUrl.searchParams.get('grain')).toBe('week');
		expect(mockUrl.searchParams.get('tab')).toBe('reliability');
	});
});

describe('StopReliabilitySurface — responsive left-rail structure (P5.4)', () => {
	beforeEach(() => {
		mockUrl = new URL('http://localhost/stop/57191?grain=day');
		replaceState.mockClear();
	});

	it('counts only content and preserves independent rail state through bulk collapse and expand', async () => {
		const { container } = render(StopReliabilitySurface, { props: { data, locale: 'en' } });
		const copy = stopReliabilityCopy.en;
		await assertRailIndependence({
			container,
			panelNames: [copy.controlsLabel, copy.nav.toc],
			contentCount: 5,
			bulkAction: 'store',
		});
	});

	it('uses instant ToC navigation when reduced motion is requested', async () => {
		const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
		const scrollIntoView = vi.fn();
		Object.defineProperty(Element.prototype, 'scrollIntoView', {
			configurable: true,
			value: scrollIntoView,
		});
		motion.reduced = true;
		vi.stubGlobal('matchMedia', () => ({
			matches: true,
			addEventListener() {},
			removeEventListener() {},
		}));

		try {
			const { container } = render(StopReliabilitySurface, {
				props: { data, locale: 'en' },
			});
			const rail = container.querySelector('[data-slot="surface-rail"]') as HTMLElement;
			await fireEvent.click(within(rail).getByRole('button', { name: 'Day by day' }));
			await waitFor(() =>
				expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' }),
			);
		} finally {
			motion.reduced = false;
			vi.unstubAllGlobals();
			if (original) Object.defineProperty(Element.prototype, 'scrollIntoView', original);
			else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
		}
	});

	it('renders the SurfaceRail: a bare desktop rail + a mobile pill that opens a dialog sheet', async () => {
		const { container } = render(StopReliabilitySurface, { props: { data, locale: 'en' } });
		const railPanel = container.querySelector('[data-slot="surface-rail"]') as HTMLElement;
		expect(railPanel).not.toBeNull();
		expect(railPanel.querySelector('[data-slot="section-toc"]')).not.toBeNull();

		const pill = container.querySelector(
			'[data-slot="surface-rail-mobile"] button',
		) as HTMLButtonElement;
		expect(pill).not.toBeNull();
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		await fireEvent.click(pill);
		expect(container.querySelector('[role="dialog"]')).not.toBeNull();
	});

	it('lists ONLY the present sections in the ToC (drops stood-down sections)', () => {
		const { container } = render(StopReliabilitySurface, { props: { data, locale: 'en' } });
		const toc = container.querySelector(
			'[data-slot="surface-rail"] [data-slot="section-toc"]',
		) as HTMLElement;
		expect(toc).not.toBeNull();
		const labels = Array.from(toc.querySelectorAll('.toc-item .toc-label')).map((el) =>
			el.textContent?.trim(),
		);
		expect(labels).toEqual(PRESENT_SECTIONS.map(([, label]) => label));
		// Nothing published, nothing listed: no empty crowding card, no empty entry.
		expect(labels).not.toContain('Crowding on vehicles seen here');
		expect(labels).not.toContain('Relative severe-delay score by hour');
		expect(labels).not.toContain('By day of week');
		expect(labels).not.toContain('By time of day');
		expect(toc.textContent).not.toContain('↻');
		expect(toc.textContent).not.toContain('∞');
	});

	it('drops the percentiles ToC entry on the week grain (percentiles stand down)', async () => {
		const { container } = render(StopReliabilitySurface, { props: { data, locale: 'en' } });
		const week = within(desktopGroup(container)).getByRole('radio', { name: 'Week' });
		await fireEvent.click(week);
		const toc = container.querySelector(
			'[data-slot="surface-rail"] [data-slot="section-toc"]',
		) as HTMLElement;
		const labels = Array.from(toc.querySelectorAll('.toc-item .toc-label')).map((el) =>
			el.textContent?.trim(),
		);
		expect(labels).not.toContain('Typical delay');
	});

	it('keeps the visible route metric in each Line link accessible name', async () => {
		const view = render(StopReliabilitySurface, { props: { data, locale: 'en' } });
		await openSection(view.container, 'stop-rel-by-route', 'Avg delay by line');

		expect(
			view.getByRole('link', {
				name: (name) => name.includes('Line 51') && name.includes('6.0 min'),
			}),
		).toHaveAttribute('href', '/lines/51');
	});

	it('shows the first five lines, then all of them on request, in the same order', async () => {
		const routes = ['10', '17', '24', '31', '38', '45', '52'].map((route, index) => ({
			route,
			avg_delay_min: 9 - index,
		}));
		const view = render(StopReliabilitySurface, {
			props: { data: { ...data, by_route: routes }, locale: 'en' },
		});
		const section = await openSection(view.container, 'stop-rel-by-route', 'Avg delay by line');
		const shown = () =>
			Array.from(section.querySelectorAll('[data-slot="stop-by-route"] li'))
				.filter((item) => !item.hasAttribute('hidden'))
				.map((item) => item.querySelector('a')?.getAttribute('href'));
		expect(shown()).toEqual(['/lines/10', '/lines/17', '/lines/24', '/lines/31', '/lines/38']);
		const toggle = within(section).getByRole('button', { name: 'Show all 7 lines' });
		expect(toggle).toHaveAttribute('aria-expanded', 'false');
		await fireEvent.click(toggle);
		expect(shown()).toHaveLength(7);
		expect(toggle).toHaveAttribute('aria-expanded', 'true');
		expect(toggle).toHaveTextContent('Show fewer lines');
		await fireEvent.click(toggle);
		expect(shown()).toHaveLength(5);
	});
});

describe('StopReliabilitySurface — cohesive article disclosures', () => {
	beforeEach(() => {
		mockUrl = new URL('http://localhost/stop/57191?grain=day');
		replaceState.mockClear();
	});

	it('keeps every conditional disclosure in one connected vertical stack', () => {
		const { container } = render(StopReliabilitySurface, { props: { data, locale: 'en' } });
		const stack = container.querySelector('[data-slot="article-section-stack"]') as HTMLElement;
		const anchors = Array.from(stack?.children ?? []);

		expect(stack).not.toBeNull();
		expect(anchors).toHaveLength(PRESENT_SECTIONS.length);
		for (const anchor of anchors) {
			expect(anchor.matches('.stop-anchor')).toBe(true);
			expect(
				anchor.querySelector(':scope > [data-slot="card"].section-card[data-toc]'),
			).not.toBeNull();
			expect(anchor.querySelector('[data-section-trigger]')).not.toBeNull();
		}
		expect(container.querySelector('[data-slot="dashboard-grid"]')).toBeNull();
	});

	it('opens Day by day and keeps the breakdowns closed, each changing on its own', async () => {
		const { container } = render(StopReliabilitySurface, { props: { data, locale: 'en' } });
		const expanded = PRESENT_SECTIONS.map(([id, label]) =>
			disclosureTrigger(container, id, label).getAttribute('aria-expanded'),
		);
		expect(expanded).toEqual(['true', 'false', 'false', 'false', 'false']);

		const days = disclosure(container, 'stop-rel-trend');
		await fireEvent.click(within(days).getByRole('button', { name: 'Day by day' }));
		expect(days.querySelector('[data-slot="collapsible-content"]')).toHaveAttribute(
			'data-state',
			'closed',
		);
		expect(disclosureTrigger(container, 'stop-rel-percentiles', 'Typical delay')).toHaveAttribute(
			'aria-expanded',
			'false',
		);
		const route = await openSection(container, 'stop-rel-by-route', 'Avg delay by line');
		expect(route.querySelector('[data-slot="collapsible-content"]')).toHaveAttribute(
			'data-state',
			'open',
		);
		expect(disclosureTrigger(container, 'stop-rel-source', 'Source and method')).toHaveAttribute(
			'aria-expanded',
			'false',
		);
	});

	it('gives every closed breakdown a one-line summary of its own scope', () => {
		const { container } = render(StopReliabilitySurface, { props: { data, locale: 'en' } });
		const summary = (id: string) =>
			disclosure(container, id).querySelector('[data-slot="section-summary"]')?.textContent?.trim();
		expect(summary('stop-rel-percentiles')).toBe(
			'Median 2.4 min; 9 in 10 readings at or below 11.6 min.',
		);
		expect(summary('stop-rel-pane')).toBe('Rolled up by day.');
		expect(summary('stop-rel-by-route')).toBe('Average predicted delay for the one line.');
		expect(summary('stop-rel-source')).toBe('What a reading is, and this stop’s publication.');
	});

	it('reveals a collapsed ToC target before scrolling to it', async () => {
		const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
		let trigger: HTMLElement;
		const scrollIntoView = vi.fn(() => {
			expect(trigger).toHaveAttribute('aria-expanded', 'true');
		});
		Object.defineProperty(Element.prototype, 'scrollIntoView', {
			configurable: true,
			value: scrollIntoView,
		});
		motion.reduced = true;

		try {
			const { container } = render(StopReliabilitySurface, {
				props: { data, locale: 'en' },
			});
			trigger = disclosureTrigger(container, 'stop-rel-trend', 'Day by day');
			await fireEvent.click(trigger);
			expect(trigger).toHaveAttribute('aria-expanded', 'false');

			const rail = container.querySelector('[data-slot="surface-rail"]') as HTMLElement;
			await fireEvent.click(within(rail).getByRole('button', { name: 'Day by day' }));

			await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'true'));
			await waitFor(() =>
				expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' }),
			);
		} finally {
			motion.reduced = false;
			if (original) Object.defineProperty(Element.prototype, 'scrollIntoView', original);
			else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
		}
	});

	it('gives every article section one card and one heading without parent CSS suppression', () => {
		const { container } = render(StopReliabilitySurface, { props: { data, locale: 'en' } });
		const component = source();

		for (const [id, label] of PRESENT_SECTIONS) {
			const card = disclosure(container, id);

			expect(within(card).getByRole('button', { name: label })).toBeInTheDocument();
			expect(card).toHaveAttribute('data-slot', 'card');
			expect(card.querySelectorAll('[data-slot="card"]')).toHaveLength(0);
			expect(card.querySelectorAll('h2')).toHaveLength(1);
			expect(card.querySelector('.stop-tile')).toBeNull();
		}

		expect(component).not.toMatch(/section-card \.stop-tile/);
		expect(component).not.toMatch(/:global\(\.stop-tile-heading\)/);
	});
});

describe('StopReliabilitySurface — Day by day (UX-T6.3)', () => {
	beforeEach(() => {
		mockUrl = new URL('http://localhost/stop/57191?grain=day');
		replaceState.mockClear();
	});

	const dayRows = (container: HTMLElement) =>
		Array.from(container.querySelectorAll('[data-slot="stop-daily"] tbody tr')).map((row) =>
			Array.from(row.querySelectorAll('th,td')).map((cell) => cell.textContent?.trim()),
		);
	const limits = (container: HTMLElement) =>
		Array.from(container.querySelectorAll('[data-slot="day-by-day-scope"] li')).map((item) =>
			item.textContent?.trim(),
		);

	it('draws the record week one share a day, with a missing day as a gap and its limits', () => {
		const { container } = render(StopReliabilitySurface, {
			props: { data, locale: 'en', recordWindow: { from: '2026-06-01', to: '2026-06-04' } },
		});
		expect(dayRows(container)).toEqual([
			['Monday, June 1', '10%', '40', '4'],
			['Tuesday, June 2', '15%', '60', '9'],
			['Wednesday, June 3', '10%', '50', '5'],
			['Thursday, June 4', 'Not published', 'Not published', 'Not published'],
		]);
		expect(
			disclosure(container, 'stop-rel-trend')
				.querySelector('[data-slot="section-summary"]')
				?.textContent?.trim(),
		).toBe('Between 10% and 15% a day. Highest on Tuesday, June 2.');
		expect(limits(container)).toEqual([
			'The same 4 days as the record above. The record adds up their readings; it does not average these daily shares.',
			'1 of these 4 days has no published share. It is a gap, not a zero.',
			'Between 40 and 60 readings a day. A day with few readings can swing widely.',
		]);
		// One measure, one axis: no second scale and no pooled figure competing with the answer.
		expect(container.querySelector('[data-slot="daily-range-verdict"]')).toBeNull();
		expect(container.querySelector('[data-slot="trend-mark"]')).toBeNull();
		expect(container.textContent).not.toContain('12.0%');
	});

	it('opens and closes its table from a labelled button', async () => {
		const { container } = render(StopReliabilitySurface, {
			props: { data, locale: 'fr', recordWindow: { from: '2026-06-01', to: '2026-06-03' } },
		});
		const button = within(disclosure(container, 'stop-rel-trend')).getByRole('button', {
			name: 'Voir le tableau',
		});
		const table = container.querySelector(`#${button.getAttribute('aria-controls')}`);
		expect(table).toHaveAttribute('hidden');
		await fireEvent.click(button);
		expect(button).toHaveAttribute('aria-expanded', 'true');
		expect(button).toHaveTextContent('Masquer le tableau');
		expect(table).not.toHaveAttribute('hidden');
		expect(table?.querySelector('caption')?.textContent).toBe(
			'Relevés à plus de 5 minutes de retard, du 1er au 3 juin 2026',
		);
	});

	it('shows the dates the visitor chose instead of the record week, and says so', () => {
		const { container } = render(StopReliabilitySurface, {
			props: {
				data,
				locale: 'en',
				window: { from: '2026-06-01', to: '2026-06-02' },
				recordWindow: { from: '2026-06-01', to: '2026-06-07' },
			},
		});
		expect(dayRows(container).map((row) => row[0])).toEqual(['Monday, June 1', 'Tuesday, June 2']);
		expect(limits(container)[0]).toBe(
			'The dates you chose. The record above stays the published week.',
		);
	});

	it('leaves Day by day out, and out of the contents, when the file has no daily row', () => {
		const { container } = render(StopReliabilitySurface, {
			props: { data: { ...data, daily: [] }, locale: 'en', recordWindow: null },
		});
		expect(container.querySelector('#stop-rel-trend')).toBeNull();
		const toc = container.querySelector('[data-slot="surface-rail"] [data-slot="section-toc"]');
		expect(toc?.textContent).not.toContain('Day by day');
	});
});

describe('StopReliabilitySurface prediction-share verdict', () => {
	it.each(['en', 'fr'] as const)(
		'keeps the known count without fabricating bounds in %s',
		(locale) => {
			const { container } = render(StopReliabilitySurface, {
				props: {
					locale,
					data: { ...data, periods: [{ grain: 'day', otp_pct: 87, observation_count: 120 }] },
				},
			});
			const banner = container.querySelector(
				'[data-slot="stop-reliability-pane"] [data-slot="verdict"]',
			);
			expect(banner).toHaveAttribute('data-status', 'tentative');
			const sentence = banner?.querySelector('p')?.textContent ?? '';
			expect(sentence).toContain('120');
			expect(sentence).toContain(
				locale === 'en' ? 'no usable uncertainty range' : 'aucune plage d’incertitude exploitable',
			);
			expect(sentence).not.toMatch(/Wilson|95/);
		},
	);
	it.each(['en', 'fr'] as const)(
		'describes the stop proxy and nominal bounds in %s',
		async (locale) => {
			const { container } = render(StopReliabilitySurface, {
				props: {
					locale,
					data: {
						...data,
						periods: [
							{
								grain: 'day',
								otp_pct: 87,
								observation_count: 120,
								wilson_lo: 79.4,
								wilson_hi: 91.6,
							},
						],
					},
				},
			});
			const banner = container.querySelector(
				'[data-slot="stop-reliability-pane"] [data-slot="verdict"]',
			);
			expect(banner).toHaveAttribute('data-status', 'tentative');
			const sentence = banner?.querySelector('p')?.textContent ?? '';
			expect(sentence).toContain('87');
			expect(sentence).toContain('120');
			expect(sentence).toContain('79');
			expect(sentence).toContain('92');
			expect
				.soft(sentence)
				.toMatch(
					locale === 'en'
						? /known predictions.*not severely late/
						: /prévisions connues.*sans retard grave/,
				);
			expect.soft(sentence).toMatch(/Wilson/);
			expect.soft(sentence).toMatch(locale === 'en' ? /dependent/ : /dépendan/);
			expect.soft(sentence).not.toMatch(/arrivals|à l’heure|95% sure|sûr à 95|today|aujourd’hui/);
			const pane = container.querySelector('[data-slot="reliability-pane"]');
			expect(pane?.textContent).toContain(
				locale === 'en' ? 'Not-severe predictions' : 'Prévisions sans retard grave',
			);
			expect(pane?.textContent).not.toMatch(/On-time %|Tendance ponctualité|Slowest 10%/);
			const section = await openSection(
				container,
				'stop-rel-pane',
				locale === 'en' ? 'Predicted delays' : 'Prévisions de retard',
			);
			const help = within(section).getByRole('button', {
				name: /not-severe predictions|prévisions sans retard grave/i,
			});
			await fireEvent.click(help);
			const explanation = help.closest('.metric-info');
			expect(explanation?.textContent).toMatch(locale === 'en' ? /300 seconds/ : /300 secondes/);
			expect(explanation?.querySelector('a')).toHaveAttribute(
				'href',
				locale === 'en' ? '/metrics#severe' : '/fr/metrics#severe',
			);
		},
	);
});

describe('StopReliabilitySurface metric help ownership', () => {
	it.each(['en', 'fr'] as const)(
		'associates median, p90 and mean help with their displayed metric in %s',
		async (locale) => {
			mockUrl = new URL('http://localhost/stop/57191?grain=day');
			const { container } = render(StopReliabilitySurface, { props: { data, locale } });
			const section = await openSection(
				container,
				'stop-rel-pane',
				locale === 'en' ? 'Predicted delays' : 'Prévisions de retard',
			);
			const pane = section.querySelector('[data-slot="reliability-pane"]') as HTMLElement;
			const header = section.querySelector('.section-heading-row');
			expect(header).not.toBeNull();
			expect(header?.querySelector('.metric-info')).toBeNull();

			for (const label of [locale === 'en' ? 'Median delay' : 'Retard médian', 'p90']) {
				const metric = within(pane)
					.getByText(label, { exact: true })
					.closest('[data-slot="metric-display"]') as HTMLElement;
				const help = within(metric).getByRole('button', { name: new RegExp(label, 'i') });
				expect(help.parentElement?.parentElement).toContainElement(
					within(metric).getByText(label, { exact: true }),
				);
				await fireEvent.click(help);
				const dialog = within(metric).getByRole('dialog', { name: new RegExp(label, 'i') });
				expect(help).toHaveAttribute('aria-controls', dialog.id);
				expect(dialog).toHaveTextContent(
					locale === 'en'
						? 'The median describes the centre of reported predicted delays'
						: 'La médiane situe le centre des retards prédits rapportés',
				);
				expect(within(dialog).getByRole('link')).toHaveAttribute(
					'href',
					locale === 'en' ? '/metrics#p50-p90' : '/fr/metrics#p50-p90',
				);
				await fireEvent.keyDown(help, { key: 'Escape' });
				expect(help).toHaveAttribute('aria-expanded', 'false');
			}
			expect(
				within(pane).queryByRole('button', { name: /major delays|retards majeurs/i }),
			).toBeNull();

			await fireEvent.click(
				within(desktopGroup(container)).getByRole('radio', {
					name: locale === 'en' ? 'Week' : 'Semaine',
				}),
			);
			const averageLabel = locale === 'en' ? 'Avg delay' : 'Retard moyen';
			const average = within(pane)
				.getByText(averageLabel, { exact: true })
				.closest('[data-slot="metric-display"]') as HTMLElement;
			await fireEvent.click(
				within(average).getByRole('button', { name: new RegExp(averageLabel, 'i') }),
			);
			const dialog = within(average).getByRole('dialog');
			expect(dialog).toHaveTextContent(
				locale === 'en'
					? 'Average predicted deviation from the timetable'
					: 'L’écart moyen prédit par rapport à l’horaire',
			);
			expect(within(dialog).getByRole('link')).toHaveAttribute(
				'href',
				locale === 'en' ? '/metrics#avg-delay' : '/fr/metrics#avg-delay',
			);
			expect(within(pane).queryByText('p90', { exact: true })).toBeNull();
		},
	);
});

describe('StopReliabilitySurface crowding absence', () => {
	it.each(['en', 'fr'] as const)(
		'leaves crowding out when it is not published, never saying readings are pending (%s)',
		(locale) => {
			mockUrl = new URL('http://localhost/stop/57191');
			const { container } = render(StopReliabilitySurface, { props: { data, locale } });
			expect(container.querySelector('#stop-rel-crowding')).toBeNull();
			expect(container.querySelector('[data-slot="stop-crowding-empty"]')).toBeNull();
			const toc = container.querySelector('[data-slot="surface-rail"] [data-slot="section-toc"]');
			expect(toc?.textContent).not.toContain(stopReliabilityCopy[locale].crowding.heading);
		},
	);
});

describe('StopReliabilitySurface source and method (UX-T6.4)', () => {
	it.each([
		[
			'en',
			'Source and method',
			['Stop file built on', 'Jun 19, 2026', 'Method version', 'r2.1', 'Publication generation'],
			'Not supplied in this file.',
			'/metrics#severe',
		],
		[
			'fr',
			'Source et méthode',
			['Fichier de l’arrêt produit le', 'Version de la méthode', 'Génération de publication'],
			'Non fourni dans ce fichier.',
			'/fr/metrics#severe',
		],
	] as const)(
		'states what a reading is and which file the page read (%s)',
		async (locale, name, facts, absent, href) => {
			const { container } = render(StopReliabilitySurface, {
				props: { data: { ...data, methodology_version: 'r2.1' }, locale },
			});
			const section = await openSection(container, 'stop-rel-source', name);
			for (const fact of facts) expect(section).toHaveTextContent(fact);
			// The fixture names no publication generation: said in words, never a blank.
			expect(section).toHaveTextContent(absent);
			expect(within(section).getByRole('link')).toHaveAttribute('href', href);
		},
	);
});
