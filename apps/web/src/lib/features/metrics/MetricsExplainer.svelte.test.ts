vi.mock('$app/navigation', () => ({ afterNavigate: () => {} }));
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import { sections } from '@yesid/ui/state';
import MetricsExplainer from './MetricsExplainer.svelte';
import { METRICS } from './metrics.content';
import { metricsCopy } from './metrics.copy';

const { provState } = vi.hoisted(() => ({
	provState: {
		data: null as {
			generated_utc: string;
			conformance: { status: string; extra_row_count: number; unknown_members: string[] };
			methodology: Record<string, unknown>;
		} | null,
	},
}));

vi.mock('#lib/v1/repositories/provenance.ts', () => ({
	getProvenance: vi.fn(),
}));
vi.mock('#lib/v1/resource.svelte.ts', () => ({
	createResource: () => ({
		get data() {
			return provState.data;
		},
		error: null,
		loading: false,
		settled: true,
		reload: vi.fn(),
	}),
}));

const en = metricsCopy.en;

function resetMetricsState(): void {
	provState.data = null;
	localStorage.removeItem('sections-choice');
	document.documentElement.dataset.sectionsChoice = 'expanded';
	if (window.location.hash) window.location.hash = '';
}
beforeEach(resetMetricsState);
afterEach(resetMetricsState);

describe('MetricsExplainer', () => {
	it('reveals interval assumptions on a fresh visit without live provenance', async () => {
		window.location.hash = '#confidence-intervals';
		const { container } = render(MetricsExplainer);
		await tick();
		await tick();
		expect(cardTrigger(container, 'metrics-provenance')).toHaveAttribute('aria-expanded', 'true');
		const section = container.querySelector('#confidence-intervals') as HTMLElement;
		expect(
			within(section).getByRole('heading', { name: 'Reading a confidence interval' }),
		).toBeVisible();
		expect(section).toHaveTextContent('independent observations');
		expect(section).toHaveTextContent('can be correlated');
		expect(
			within(section).getByRole('link', { name: 'Wilson interval: NIST reference' }),
		).toHaveAttribute('href', 'https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm');
		for (const entry of METRICS)
			expect(cardTrigger(container, entry.anchor)).toHaveAttribute('aria-expanded', 'true');
	});

	it('renders a reading heading, the current method link and a provenance introduction', () => {
		const { container } = render(MetricsExplainer);
		const header = container.querySelector('[data-slot="reading-frame"]') as HTMLElement;

		expect(header).not.toBeNull();
		expect(within(header).getByRole('heading', { level: 1, name: en.heading })).toBeInTheDocument();
		expect(within(header).getByRole('link', { name: /How we measure/ })).toHaveAttribute(
			'href',
			'/metrics',
		);
		expect(header.querySelector('.header__circuit-grid')).toBeNull();

		const center = container.querySelector('[data-slot="detail-shell-center"]') as HTMLElement;
		expect(within(center).getByText(en.lede)).toBeInTheDocument();
		expect(container.textContent).not.toMatch(/blueprint/i);
	});

	it('renders one page action and no metrics-only extra control', async () => {
		const { container } = render(MetricsExplainer);
		const header = container.querySelector('[data-slot="reading-frame"]') as HTMLElement;
		expect(within(header).getByRole('button', { name: 'Collapse all' })).toBeInTheDocument();
		expect(screen.getByTestId('sections-controls').querySelectorAll('button')).toHaveLength(1);
		expect(within(header).queryByTestId('metrics-expand-all')).toBeNull();
	});

	it('places the lede and methodology inside the opening provenance card', () => {
		const { container } = render(MetricsExplainer);
		const center = container.querySelector('[data-slot="detail-shell-center"]') as HTMLElement;
		const trigger = within(center).getByRole('button', { name: en.provenance.label });
		const card = trigger.closest('[data-slot="card"]') as HTMLElement;
		expect(within(card).getByText(en.lede)).toBeInTheDocument();
		expect(within(card).getByText(en.provenance.body)).toBeInTheDocument();
		expect(card).toHaveAttribute('data-toc', 'metrics-provenance');
	});

	it('renders the surface head + provenance preamble', () => {
		const { container } = render(MetricsExplainer);

		expect(screen.getByRole('heading', { level: 1, name: en.heading })).toBeInTheDocument();
		expect(screen.getByText(en.provenance.body)).toBeInTheDocument();
		expect(container.textContent).toContain(en.confidence.levels.proxy.meaning);
		expect(container.textContent).toContain(en.confidence.levels.medium.meaning);
	});

	it('keeps descriptive archive disclosure headings', () => {
		provState.data = {
			generated_utc: '2026-07-11T04:00:00Z',
			conformance: { status: 'conformant', extra_row_count: 0, unknown_members: [] },
			methodology: {},
		};
		const { container } = render(MetricsExplainer);
		const sectionCards = Array.from(
			container.querySelectorAll<HTMLElement>(
				'[data-testid="metrics-sections"] .section-block > [data-slot="card"]',
			),
		);
		expect(sectionCards).toHaveLength(METRICS.length + 4);
		for (const card of sectionCards) {
			expect(card).toHaveAttribute('data-header-variant', 'article-summary');
		}
	});

	it('keeps a metric one-liner linked to its article-summary trigger across collapse', async () => {
		const first = METRICS[0];
		const { container } = render(MetricsExplainer);
		const card = container.querySelector(
			`#${CSS.escape(first.anchor)} > [data-slot="card"][data-header-variant="article-summary"]`,
		) as HTMLElement;
		const trigger = card?.querySelector(
			'h2.section-heading > button.section-header',
		) as HTMLButtonElement;

		expect(card).not.toBeNull();
		expect(trigger).toHaveAccessibleName(first.name.en);
		const subtitleId = trigger.getAttribute('aria-describedby') ?? '';
		expect(subtitleId).not.toBe('');
		const subtitle = card.querySelector(`#${CSS.escape(subtitleId)}`) as HTMLElement;
		expect(subtitle).toBeVisible();
		expect(subtitle.textContent?.trim()).toBe(first.oneLiner.en);
		expect(subtitle).toHaveAttribute('data-state', 'open');

		await fireEvent.click(trigger);

		expect(subtitle).toHaveAttribute('data-state', 'closed');
		expect(subtitle.textContent?.trim()).toBe(first.oneLiner.en);
	});

	it('renders every anchored metric with the exact typed-card anatomy and terminal SQL', () => {
		const { container } = render(MetricsExplainer);

		for (const entry of METRICS) {
			const block = container.querySelector(`#${CSS.escape(entry.anchor)}`);
			expect(block, `section block #${entry.anchor}`).not.toBeNull();

			const card = block?.querySelector(`[data-toc="${CSS.escape(entry.anchor)}"]`);
			expect(card, `${entry.anchor} card [data-toc]`).not.toBeNull();
			expect(
				card?.querySelector('[data-slot="collapsible-trigger"]'),
				`${entry.anchor} has a disclosure trigger`,
			).not.toBeNull();

			expect(block?.textContent).toContain(entry.name.en);
			expect(block?.textContent).toContain(entry.definition.en);

			const informationCards = Array.from(
				card?.querySelectorAll<HTMLElement>('[data-slot="typed-information-card"]') ?? [],
			);
			expect(
				informationCards.map((informationCard) => informationCard.dataset.kind),
				`${entry.anchor} typed-card kinds`,
			).toEqual(['definition', 'math', 'sql', 'not-really', 'caveat']);

			const sqlCard = informationCards.find(
				(informationCard) => informationCard.dataset.kind === 'sql',
			);
			expect(sqlCard?.querySelector('[data-slot="terminal-panel"]')).toBeInTheDocument();
			const sqlRegion = sqlCard?.querySelector<HTMLElement>('[role="region"]');
			expect(sqlRegion).toHaveAttribute('tabindex', '0');
			expect(sqlRegion?.textContent, `${entry.anchor} SQL remains byte-for-byte`).toBe(entry.sql);
		}
	});

	it('labels each metric section with the definition / math / SQL / caveats overlines', () => {
		const { container } = render(MetricsExplainer);
		const text = container.textContent ?? '';
		expect(text).toContain(en.sections.definition);
		expect(text).toContain(en.sections.math);
		expect(text).toContain(en.sections.sql);
		expect(text).toContain(en.sections.notReally);
		expect(text).toContain(en.sections.caveats);
	});

	it('a malformed hash fragment never throws during mount (review F2)', async () => {
		window.location.hash = '#%';
		expect(() => render(MetricsExplainer)).not.toThrow();
		await tick();
		await tick();
		for (const trigger of metricTriggers(document.body))
			expect(trigger).toHaveAttribute('aria-expanded', 'true');
	});

	it('keeps the TOC entries and the section cards in lock-step (same anchors)', () => {
		const { container } = render(MetricsExplainer);

		const rail = container.querySelector('[data-testid="archive-contents"]') as HTMLElement;
		for (const entry of METRICS) {
			expect(container.querySelectorAll(`#${CSS.escape(entry.anchor)}`)).toHaveLength(1);
			expect(within(rail).getByRole('link', { name: entry.name.en })).toBeInTheDocument();
		}
	});

	it('renders the structural-gaps ("Lacunes") card with all three named gaps', () => {
		const { container } = render(MetricsExplainer);

		const block = container.querySelector('#structural-gaps');
		expect(block, 'structural-gaps section block').not.toBeNull();
		expect(
			block?.querySelector('[data-toc="structural-gaps"]'),
			'structural-gaps card [data-toc]',
		).not.toBeNull();

		const text = block?.textContent ?? '';
		expect(text).toContain(en.lacunes.title);
		expect(text).toContain(en.lacunes.lede);
		for (const gap of en.lacunes.gaps) {
			expect(text).toContain(gap.heading);
			expect(text).toContain(gap.body);
		}
		expect(block?.querySelectorAll('.metrics-lacunes__list li')).toHaveLength(3);
		expect(block?.querySelectorAll('.metrics-lacunes__heading')).toHaveLength(3);
	});

	it('registers the structural-gaps section in the archive contents list (after the metrics)', () => {
		const { container } = render(MetricsExplainer);
		const rail = container.querySelector('[data-testid="archive-contents"]') as HTMLElement;

		expect(within(rail).getByRole('link', { name: en.lacunes.title })).toBeInTheDocument();
	});

	it('renders the live-positions ("almost real-time, not real-time") explainer card with every named point', () => {
		const { container } = render(MetricsExplainer);

		const block = container.querySelector('#live-positions');
		expect(block, 'live-positions section block').not.toBeNull();
		expect(
			block?.querySelector('[data-toc="live-positions"]'),
			'live-positions card [data-toc]',
		).not.toBeNull();

		const text = block?.textContent ?? '';
		expect(text).toContain(en.livePositions.title);
		expect(text).toContain(en.livePositions.lede);
		for (const point of en.livePositions.points) {
			expect(text).toContain(point.heading);
			expect(text).toContain(point.body);
		}
		const count = en.livePositions.points.length;
		expect(block?.querySelectorAll('.metrics-live__list li')).toHaveLength(count);
		expect(block?.querySelectorAll('.metrics-live__heading')).toHaveLength(count);
	});

	it('registers the live-positions section in the desktop TOC rail', () => {
		const { container } = render(MetricsExplainer);
		const rail = container.querySelector('[data-testid="archive-contents"]') as HTMLElement;
		expect(within(rail).getByRole('link', { name: en.livePositions.title })).toBeInTheDocument();
	});

	it('keeps the live-positions explainer honest (names estimate vs measured, no fabricated certainty)', () => {
		const joined = [en.livePositions.lede, ...en.livePositions.points.map((p) => p.body)]
			.join(' ')
			.toLowerCase();
		expect(joined).toContain('estimate');
		expect(joined).toContain('approximation');
		expect(joined).toContain('measured');
		expect(joined).toContain('freezes');
		expect(joined).toContain('~20-60 seconds');
	});

	function metricTriggers(container: HTMLElement): HTMLElement[] {
		const column = container.querySelector('[data-testid="metrics-sections"]') as HTMLElement;
		return Array.from(
			column.querySelectorAll('[data-slot="collapsible-trigger"]'),
		) as HTMLElement[];
	}

	function tocTrigger(container: HTMLElement): HTMLElement | null {
		const rail = container.querySelector('[data-testid="archive-contents"]') as HTMLElement;
		return rail?.querySelector('details') ?? null;
	}

	function cardTrigger(container: HTMLElement, anchor: string): HTMLElement | null {
		const block = container.querySelector(`#${CSS.escape(anchor)}`) as HTMLElement | null;
		return block?.querySelector('[data-slot="collapsible-trigger"]') ?? null;
	}

	it('starts content cards collapsed on a boot-prepared fresh visit, with the jump list folded', () => {
		document.documentElement.dataset.sectionsChoice = 'collapsed';
		const { container } = render(MetricsExplainer);

		const triggers = metricTriggers(container);
		expect(triggers.length).toBeGreaterThan(0);
		for (const trigger of triggers) {
			expect(trigger).toHaveAttribute('aria-expanded', 'false');
		}
		const firstBody = container.querySelector(
			`#${CSS.escape(METRICS[0].anchor)} [data-slot="collapsible-content"]`,
		);
		expect(firstBody).toHaveAttribute('data-state', 'closed');

		// Folded on a phone; a wide screen shows the links with CSS, without the open attribute.
		expect(tocTrigger(container)).not.toHaveAttribute('open');
	});

	it('opens the hash-named card from a closed state during mount', async () => {
		window.location.hash = '#otp';
		const { container } = render(MetricsExplainer);
		// Close synchronously before the pending mount-fragment jump resumes.
		sections.collapseAll();
		flushSync();
		expect(cardTrigger(container, 'otp')).toHaveAttribute('aria-expanded', 'false');
		await vi.waitFor(() =>
			expect(cardTrigger(container, 'otp')).toHaveAttribute('aria-expanded', 'true'),
		);
		const sectionsToggle = screen.getByTestId('sections-toggle');
		expect(sectionsToggle).toHaveAttribute('data-collapsed', 'false');
		expect(sectionsToggle).toHaveTextContent('Collapse all');
		for (const entry of METRICS.filter((m) => m.anchor !== 'otp')) {
			expect(cardTrigger(container, entry.anchor)).toHaveAttribute('aria-expanded', 'false');
		}
	});

	it('scrolls the hash-named card into position after opening it on mount', async () => {
		const scrollCalls: Array<{ expanded: string | null; args: unknown }> = [];
		const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
		const { container } = await (async () => {
			window.location.hash = '#otp';
			return render(MetricsExplainer);
		})();
		Object.defineProperty(Element.prototype, 'scrollIntoView', {
			configurable: true,
			value: function (this: Element, args: unknown) {
				scrollCalls.push({
					expanded: cardTrigger(container, 'otp')!.getAttribute('aria-expanded'),
					args,
				});
			},
		});
		try {
			await vi.waitFor(() => expect(scrollCalls.length).toBeGreaterThanOrEqual(1));
			expect(scrollCalls[0].expanded).toBe('true');
			expect(scrollCalls[0].args).toMatchObject({ block: 'start' });
		} finally {
			if (original) Object.defineProperty(Element.prototype, 'scrollIntoView', original);
			else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
		}
	});

	it('scrolls the newly hash-named card after a same-page hashchange', async () => {
		const { container } = render(MetricsExplainer);
		await fireEvent.click(screen.getByTestId('sections-toggle'));

		const scrollCalls: Array<string | null> = [];
		const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
		Object.defineProperty(Element.prototype, 'scrollIntoView', {
			configurable: true,
			value: function (this: Element) {
				scrollCalls.push(cardTrigger(container, 'headway')!.getAttribute('aria-expanded'));
			},
		});
		try {
			window.location.hash = '#headway';
			await fireEvent(window, new HashChangeEvent('hashchange'));
			await vi.waitFor(() => expect(scrollCalls.length).toBeGreaterThanOrEqual(1));
			expect(scrollCalls[0]).toBe('true');
		} finally {
			if (original) Object.defineProperty(Element.prototype, 'scrollIntoView', original);
			else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
		}
	});

	it('scrolls only the latest target when the hash changes again while layout settles', async () => {
		const { container } = render(MetricsExplainer);
		await tick();

		const scrollCalls: Array<string | null> = [];
		const original = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
		Object.defineProperty(Element.prototype, 'scrollIntoView', {
			configurable: true,
			value: function (this: Element) {
				scrollCalls.push(this.getAttribute('data-toc'));
			},
		});
		try {
			window.location.hash = '#otp';
			await fireEvent(window, new HashChangeEvent('hashchange'));
			window.location.hash = '#headway';
			await fireEvent(window, new HashChangeEvent('hashchange'));

			await vi.waitFor(() => expect(scrollCalls).toEqual(['headway']));
		} finally {
			if (original) Object.defineProperty(Element.prototype, 'scrollIntoView', original);
			else Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
			window.location.hash = '';
			void container;
		}
	});

	it('opens another card on a later hashchange without closing the first (folded page)', async () => {
		const { container } = render(MetricsExplainer);
		await fireEvent.click(screen.getByTestId('sections-toggle'));
		for (const trigger of metricTriggers(container)) {
			expect(trigger).toHaveAttribute('aria-expanded', 'false');
		}

		window.location.hash = '#otp';
		await fireEvent(window, new HashChangeEvent('hashchange'));
		expect(cardTrigger(container, 'otp')).toHaveAttribute('aria-expanded', 'true');

		window.location.hash = '#headway';
		await fireEvent(window, new HashChangeEvent('hashchange'));
		expect(cardTrigger(container, 'headway')).toHaveAttribute('aria-expanded', 'true');
		expect(cardTrigger(container, 'otp')).toHaveAttribute('aria-expanded', 'true');
	});

	it('opens the provenance card from a closed state during mount', async () => {
		window.location.hash = '#metrics-provenance';
		const { container } = render(MetricsExplainer);
		sections.collapseAll();
		flushSync();
		expect(cardTrigger(container, 'metrics-provenance')).toHaveAttribute('aria-expanded', 'false');
		await vi.waitFor(() =>
			expect(cardTrigger(container, 'metrics-provenance')).toHaveAttribute('aria-expanded', 'true'),
		);
		for (const entry of METRICS) {
			expect(cardTrigger(container, entry.anchor)).toHaveAttribute('aria-expanded', 'false');
		}
	});

	it('ToC navigation opens the target card through a folded page (siblings unaffected)', async () => {
		const { container } = render(MetricsExplainer);
		await fireEvent.click(screen.getByTestId('sections-toggle'));
		const rail = container.querySelector('[data-testid="archive-contents"]') as HTMLElement;

		const target = METRICS[3];
		expect(cardTrigger(container, target.anchor)).toHaveAttribute('aria-expanded', 'false');
		const toc = tocTrigger(container);
		expect(toc).not.toHaveAttribute('open');
		await fireEvent.click(within(rail).getByRole('link', { name: target.name.en }));

		expect(cardTrigger(container, target.anchor)).toHaveAttribute('aria-expanded', 'true');
		expect(cardTrigger(container, METRICS[0].anchor)).toHaveAttribute('aria-expanded', 'false');
	});
});

it('links archived methodology readers to current coverage without adding a publication date', () => {
	const { container } = render(MetricsExplainer);
	expect(container.querySelector('[data-slot="reading-frame"] time')).toBeNull();
	const depth = container.querySelector<HTMLElement>('#history-depth')!;
	expect(within(depth).getByRole('link')).toHaveAttribute('href', '/status');
});
