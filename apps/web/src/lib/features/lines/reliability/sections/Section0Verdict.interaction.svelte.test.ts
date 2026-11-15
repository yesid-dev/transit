import { fireEvent, render } from '@testing-library/svelte';
import { expect, it } from 'vitest';
import type { RouteReliability } from '#lib/v1/index.ts';
import { isoUtc } from '#lib/v1/schemas/types.ts';
import { verdictForWindow } from '#lib/v1/verdict.ts';
import { toReliabilityClusters } from '../clusters';
import { reliabilityCopy } from '../reliability.copy';
import { selectLineRecord } from '../selectors/lineRecord';
import { selectDailyOnTime } from '../selectors/punctualityTrend';
import Section0Verdict from './Section0Verdict.svelte';

function renderSection(data: RouteReliability, mode: 'day' | 'week' | 'month') {
	const verdict = verdictForWindow(data, { kind: 'route', grain: mode }, 'en');
	const vm = toReliabilityClusters(data, { grain: mode, verdict }).punctuality;
	const record = selectLineRecord({ data, verdict, mode });
	const view = render(Section0Verdict, {
		props: {
			vm,
			record,
			daily: selectDailyOnTime(vm.trend),
			mode,
			locale: 'en',
			copy: reliabilityCopy.en,
		},
	});
	return { ...view, vm };
}

it('a click on the pinned delay figures leaves the Day by day card open', async () => {
	const { container, getByRole } = renderSection(
		{
			id: '24',
			periods_by_grain: [{ grain: 'day', date: '2026-06-19' }],
			generated_utc: isoUtc().parse('2026-06-19T02:00:00Z'),
			periods: [{ grain: 'day', date: '2026-06-19', p50_min: 2, p90_min: 9 }],
		},
		'day',
	);
	const trigger = getByRole('button', { name: reliabilityCopy.en.record.daily.title });
	if (trigger.getAttribute('aria-expanded') !== 'true') await fireEvent.click(trigger);
	await fireEvent.click(getByRole('button', { name: reliabilityCopy.en.sections.detailShow }));
	expect(trigger).toHaveAttribute('aria-expanded', 'true');
	await fireEvent.click(
		container.querySelector('[data-slot="record-delays"] [data-metric="p50"] dd')!,
	);
	expect(trigger).toHaveAttribute('aria-expanded', 'true');
	expect(container.querySelector('[data-metric="p50"] dd')).toHaveTextContent('2.0 min');
});

it.each(['week', 'month'] as const)('keeps unpublished %s percentiles absent', async (grain) => {
	const { closedWeek } = await import('../__fixtures__/closedWeek');
	const { container, vm } = renderSection(closedWeek, grain);
	expect(vm.headline.p50Min).toBeNull();
	expect(vm.headline.p90Min).toBeNull();
	expect(vm.headline.delayHistogram).toBeNull();
	expect(container.querySelector('[data-slot="percentile-nudge"]')).toBeNull();
	for (const metric of ['p50', 'p90'])
		expect(container.querySelector(`[data-metric="${metric}"] dd`)).toHaveTextContent(
			reliabilityCopy.en.record.delays.notPublished,
		);
});
