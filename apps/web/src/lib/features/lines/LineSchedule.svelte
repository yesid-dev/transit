<script lang="ts">
	import { serviceTime } from '#lib/site/presenter.ts';
	import type { RouteFile } from '#lib/v1/index.ts';
	import { getLocalizeHref, type Locale } from '#lib/i18n/index.ts';
	import { formatDateKey } from '#lib/utils/time.ts';
	import { fmtDelayMin } from '#lib/utils/format.ts';
	import { roundHalfAwayFromZero } from '#lib/utils/rounding.ts';
	import { ScheduleTable, type ScheduleRow } from '#lib/components/schedule/index.ts';
	import { MaybeValue } from '#lib/components/edge/index.ts';
	import { CollapsibleSection } from '@yesid/ui/brand';
	import { ArticleSectionStack } from '#lib/components/layout/index.ts';
	import { detailCopy } from './lines.copy';
	import { lineViewsCopy } from './lineViews.copy';
	import { dayTypeLabel, shiftLabel } from '#lib/features/reliability/shiftGrains.ts';
	import RecordCopyButton from './reliability/sections/RecordCopyButton.svelte';
	import LineDirections from './LineDirections.svelte';
	let {
		file,
		locale,
		loadedUtc = null,
		noLive = false,
		recordHref,
		shareUrl,
	}: {
		file: RouteFile;
		locale: Locale;
		loadedUtc?: string | null;
		noLive?: boolean;
		recordHref: string;
		shareUrl: string;
	} = $props();
	const t = $derived(lineViewsCopy[locale]);
	const copy = $derived(detailCopy[locale]);
	const localizeHref = getLocalizeHref();
	const validHeadway = (n: number | null | undefined) =>
		n != null && Number.isFinite(n) && n > 0 && roundHalfAwayFromZero(n, 1) > 0 ? n : null;
	const periods = $derived(file.service_periods ?? []);
	const rows = $derived(
		periods.map(
			(period): ScheduleRow => ({
				kind: 'service',
				period: dayTypeLabel(shiftLabel(period.shift, locale), locale),
				window: period.window,
				headway: fmtDelayMin(validHeadway(period.headway_min), { locale, rounding: 'auto' }),
			}),
		),
	);
	const loadDate = $derived(loadedUtc && Number.isFinite(Date.parse(loadedUtc)) ? loadedUtc : null);

	// CSV text cells cannot start a spreadsheet formula; every row uses the same columns.
	const csvCell = (value: string | number) => {
		const text = String(value);
		const safe = /^[=+@\-\t\r]/.test(text) ? "'" + text : text;
		return `"${safe.replaceAll('"', '""')}"`;
	};
	const csv = $derived(
		'data:text/csv;charset=utf-8,' +
			encodeURIComponent(
				[
					[
						'line',
						'schedule_loaded_utc',
						'first_departure',
						'last_departure',
						'period',
						'time_window',
						'planned_interval_min',
					],
					...(periods.length ? periods : [null]).map((p) => [
						file.id,
						loadDate ?? '',
						file.first_departure ?? '',
						file.last_departure ?? '',
						p?.shift ?? '',
						p?.window ?? '',
						validHeadway(p?.headway_min) ?? '',
					]),
				]
					.map((row) => row.map(csvCell).join(','))
					.join('\r\n'),
			),
	);
</script>

<div data-slot="line-schedule">
	{#if noLive}
		<section class="capability" aria-label={t.noLive} data-slot="line-no-live">
			<h2>{t.noLive}</h2>
			<p>{t.cannotMeasure}</p>
			<p>{t.excluded}</p>
			<a href={localizeHref('/metrics', locale)}>{t.why}</a>
		</section>
	{/if}
	<ArticleSectionStack data-section-sequence="line-schedule">
		<CollapsibleSection
			title={t.schedule}
			subtitle={t.planned}
			headerVariant="article-summary"
			anchor="line-schedule-span"
			index={0}
		>
			<div class="schedule-overview">
				<div>
					<p data-slot="schedule-intro">{t.planned}</p>
					<p>
						{#if loadDate}<time datetime={loadDate}
								>{t.loaded(formatDateKey(loadDate.slice(0, 10), locale, true))}</time
							>{:else}{t.loadedUnknown}{/if}
					</p>
					<p>{t.serviceDay}</p>
					{#if !noLive}<a href={recordHref}>{t.record}</a>{/if}
				</div>
				<dl>
					<div>
						<dt>{copy.firstDeparture}</dt>
						<dd>
							<MaybeValue
								value={serviceTime(file.first_departure, locale)}
								reason="not-in-schedule"
								{locale}
							/>
						</dd>
					</div>
					<div>
						<dt>{copy.lastDeparture}</dt>
						<dd>
							<MaybeValue
								value={serviceTime(file.last_departure, locale)}
								reason="not-in-schedule"
								{locale}
							/>
						</dd>
					</div>
				</dl>
			</div>
			<div class="actions">
				<RecordCopyButton
					label={t.copyLink}
					done={t.copied}
					fallbackLabel={t.copyFallback}
					text={shareUrl}
				/>
				<a download={'line-' + encodeURIComponent(file.id) + '-schedule.csv'} href={csv}
					>{t.download}</a
				>
			</div>
		</CollapsibleSection>
		<CollapsibleSection
			title={t.intervals}
			subtitle={t.plannedValues}
			headerVariant="article-summary"
			anchor="line-schedule-periods"
			index={1}
		>
			{#if rows.length}<ScheduleTable
					mode="service"
					{rows}
					{locale}
					labels={copy.scheduleTable}
				/>{:else}<p>{t.noPeriods}</p>{/if}
		</CollapsibleSection>
		<CollapsibleSection
			title={t.destinations}
			headerVariant="article-summary"
			anchor="line-schedule-destinations"
			index={2}
		>
			<LineDirections directions={file.directions} mode="schedule" {locale} {copy} />
		</CollapsibleSection>
	</ArticleSectionStack>
</div>

<style>
	.capability {
		padding-block: 1rem 2rem;
	}
	h2 {
		font-family: var(--font-heading);
		font-size: var(--text-subheading);
	}
	p {
		line-height: 1.5;
	}
	.schedule-overview {
		display: grid;
		gap: 1.5rem;
	}
	dl {
		display: grid;
		align-content: start;
		gap: 1rem;
		margin: 0;
	}
	dd {
		margin: 0.25rem 0 0;
		font-variant-numeric: tabular-nums;
		font-weight: 600;
	}
	.actions {
		display: flex;
		flex-wrap: wrap;
		align-items: start;
		gap: 0.75rem 1rem;
		margin-top: 1rem;
	}
	a {
		display: inline-flex;
		min-height: 2.75rem;
		align-items: center;
		color: var(--accent-text);
		text-underline-offset: 0.2em;
	}
	a:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
	@media (min-width: 48rem) {
		.schedule-overview {
			grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
		}
	}
</style>
