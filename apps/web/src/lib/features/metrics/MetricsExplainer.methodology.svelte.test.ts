vi.mock('$app/navigation', () => ({ afterNavigate: () => {} }));
import { beforeEach, afterEach, describe, it, expect, inject, vi } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import MetricsExplainer from './MetricsExplainer.svelte';
import { metricsCopy } from './metrics.copy';

const { provState } = vi.hoisted(() => ({
	provState: {
		data: null as {
			generated_utc?: string;
			conformance: { status: string; extra_row_count: number; unknown_members: string[] } | null;
			methodology: unknown;
		} | null,
		error: null as Error | null,
		settled: true,
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
		get error() {
			return provState.error;
		},
		loading: false,
		get settled() {
			return provState.settled;
		},
		reload: vi.fn(),
	}),
}));

const viewport = window as typeof window & { happyDOM: { setInnerWidth(width: number): void } };

beforeEach(() => {
	localStorage.setItem('sections-choice', 'expanded');
	document.documentElement.dataset.sectionsChoice = 'expanded';
	viewport.happyDOM.setInnerWidth(1280);
});

afterEach(() => {
	localStorage.removeItem('sections-choice');
	delete document.documentElement.dataset.sectionsChoice;
	viewport.happyDOM.setInnerWidth(1280);
	for (const key of ['provenance', 'coverage', 'freshness']) {
		sessionStorage.removeItem(`persisted:metrics-rail-${key}`);
	}
	provState.data = null;
	provState.error = null;
	provState.settled = true;
});

describe('MetricsExplainer — responsive stat rail icons', () => {
	it('retains the ToC, Coverage and complete definitions in actual unseeded SSR', () => {
		const html = inject('methodologySsr');
		const document = window.document.createElement('div');
		document.innerHTML = html;
		expect(document.querySelector('.toc-nav')).not.toBeNull();
		expect(document.querySelector('[data-slot="stat-coverage"]')?.textContent).toContain('14');
		expect(document.querySelector('[data-slot="stat-provenance"]')).toBeNull();
		expect(document.querySelector('[data-slot="stat-freshness"]')).toBeNull();
		expect(document.querySelectorAll('[data-kind="definition"]')).toHaveLength(14);
		expect(document.querySelector('#structural-gaps')).not.toBeNull();
	});
});

describe('MetricsExplainer — "how we measure" doctrine constants (D6, dynamic)', () => {
	const en = metricsCopy.en;

	it('renders the static service-day + rounding notes regardless of provenance', () => {
		provState.data = null;
		render(MetricsExplainer);

		expect(screen.getByText(en.provenance.howWeMeasure.serviceDay.heading)).toBeInTheDocument();
		expect(screen.getByText(en.provenance.howWeMeasure.serviceDay.body)).toBeInTheDocument();
		expect(screen.getByText(en.provenance.howWeMeasure.rounding.heading)).toBeInTheDocument();
		expect(screen.getByText(en.provenance.howWeMeasure.rounding.body)).toBeInTheDocument();
	});
});

describe('MetricsExplainer — provenance edge states (supplementary, never blocking)', () => {
	const en = metricsCopy.en;

	it('renders the full methodology + structural-gaps card when provenance is null (no error)', () => {
		provState.data = null;
		provState.error = null;
		const { container } = render(MetricsExplainer);

		expect(screen.getByRole('heading', { level: 1, name: en.heading })).toBeInTheDocument();
		expect(screen.getByText(en.provenance.body)).toBeInTheDocument();
		expect(container.querySelector('#structural-gaps')).not.toBeNull();
		expect(screen.getByText(en.lacunes.gaps[0].body)).toBeInTheDocument();
		expect(screen.queryByText(en.provenance.unavailable)).toBeNull();
	});

	it('shows no stand-down line before the provenance fetch settles', () => {
		provState.data = null;
		provState.error = null;
		provState.settled = false;
		render(MetricsExplainer);

		expect(screen.queryByText(en.provenance.unavailable)).toBeNull();
	});
});
