<script lang="ts">
	import { page } from '$app/state';
	import type { Locale } from '#lib/i18n/index.ts';
	import { fmtNumber } from '#lib/utils/index.ts';
	import { fmtLocalePct } from '#lib/utils/format.ts';
	import CollapsibleSection from './CollapsibleSection.svelte';
	import { selectTripFacts } from '../selectors/evidence';
	import type { RecordPeriod } from '../selectors/lineRecord';
	import { formatRecordDates } from '../recordDates';
	import type { ServiceDeliveredVM } from '../clusters';
	import type { ReliabilityCopy } from '../reliability.copy';

	interface Section3RunAndFitProps {
		service: ServiceDeliveredVM;
		/** The record's own complete days; trip counts cover exactly these. */
		period: RecordPeriod | null;
		locale: Locale;
		copy: ReliabilityCopy;
		/** A chosen range with retained history publishes its schedule comparison. */
		showServiceCompleteness?: boolean;
	}

	let {
		service,
		period,
		locale,
		copy,
		showServiceCompleteness = false,
	}: Section3RunAndFitProps = $props();

	const e = $derived(copy.evidence);
	const t = $derived(copy.evidence.trips);
	const count = (v: number) => fmtNumber(v, { locale, rounding: 'round' })!;
	const share = (v: number) => fmtLocalePct(v, locale, { rounding: 'fixed1' })!;

	const facts = $derived(selectTripFacts(service.cancellations, service.skippedStops, period));
	const dates = $derived(period ? formatRecordDates(period.from, period.to, locale) : null);
	const summary = $derived(
		facts.cancelled
			? t.summary(
					count(facts.cancelled.count),
					count(facts.cancelled.total),
					share(facts.cancelled.percent),
				)
			: e.summaryAbsent,
	);
	const coverage = (days: number) =>
		period && days < period.days ? t.coverage(count(days), count(period.days)) : null;
	// The Live now view counts silent trips; it opens on the same line and provider.
	const liveHref = $derived.by(() => {
		const url = new URL(page.url.href);
		for (const key of ['from', 'to', 'grain']) url.searchParams.delete(key);
		url.searchParams.set('tab', 'detail');
		return `${url.pathname}${url.search}`;
	});
	const completeness = $derived(
		showServiceCompleteness && service.serviceCompletenessPct != null && service.scheduledService
			? service.scheduledService
			: null,
	);
</script>

{#snippet absent()}
	<span class="evidence-absent" data-slot="absent-value">{e.notPublished}</span>
{/snippet}

<CollapsibleSection dataSection="run-and-fit" title={copy.sections.runAndFit.label} {summary}>
	<div class="evidence-body">
		<dl class="evidence-facts" data-slot="trip-facts">
			<div data-slot="cancellations">
				<dt>{t.cancelled}</dt>
				<dd>
					{#if facts.cancelled}
						<span class="fact-value" data-slot="fact-value"
							>{t.cancelledValue(
								count(facts.cancelled.count),
								count(facts.cancelled.total),
								share(facts.cancelled.percent),
							)}</span
						>
						<span class="fact-def"
							>{t.cancelledDef(dates ?? '', count(facts.cancelled.total))}
							{coverage(facts.cancelled.days) ?? ''}</span
						>
					{:else}
						{@render absent()}
					{/if}
				</dd>
			</div>
			<div data-slot="missing-trips">
				<dt>{t.missing}</dt>
				<dd>
					{@render absent()}
					<span class="fact-def">{t.missingDef}</span>
				</dd>
			</div>
			<div data-slot="silent-trips">
				<dt>{t.silent}</dt>
				<dd>
					<span class="silent-value">{t.silentValue} <a href={liveHref}>{t.seeLive}</a></span>
					<span class="fact-def">{t.silentDef}</span>
				</dd>
			</div>
			<div data-slot="skipped-stops">
				<dt>{t.skipped}</dt>
				<dd>
					{#if facts.skipped}
						<span class="fact-value" data-slot="fact-value"
							>{t.skippedValue(
								count(facts.skipped.count),
								count(facts.skipped.total),
								share(facts.skipped.percent),
							)}</span
						>
						<span class="fact-def">{t.skippedDef} {coverage(facts.skipped.days) ?? ''}</span>
					{:else}
						{@render absent()}
					{/if}
				</dd>
			</div>
			{#if completeness}
				<div data-slot="service-completeness">
					<dt>{copy.strip.serviceCompletenessPct}</dt>
					<dd>
						<span class="fact-value" data-slot="fact-value"
							>{share(service.serviceCompletenessPct!)}</span
						>
						<span class="fact-def"
							>{copy.strip.serviceCompletenessFraction(
								count(completeness.delivered),
								count(completeness.scheduled),
								completeness.silent == null ? null : count(completeness.silent),
							)}</span
						>
					</dd>
				</div>
			{/if}
		</dl>
		<p class="evidence-note">{t.note}</p>
	</div>
</CollapsibleSection>

<style>
	/* A text link inside a sentence still offers a full-height target. */
	.silent-value a {
		display: inline-flex;
		align-items: center;
		min-block-size: var(--size-tap-min);
	}
</style>
