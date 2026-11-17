<script lang="ts">
	import { Button } from '@yesid/ui/button';
	import { StateNotice } from '@yesid/ui/feedback';
	import { intl, type Locale } from '#lib/i18n/index.ts';
	import { transitTerms } from '#lib/i18n/transitTerms.copy.ts';
	import { delayMeasurement } from '#lib/site/delayPresentation.ts';
	import { formatLocalClock, formatUtc, formatRelativeSeconds } from '#lib/utils/time.ts';
	import { copy as mapCopy } from './map.copy';
	import { mapReportsCopy } from './mapReports.copy';
	import { mapReportsCsv } from './mapReportsCsv.ts';
	import { mapStatusLabel } from './mapStatusLabels';
	import type { MapReportRow, MapReportView } from './mapReports.ts';
	import MapViewSwitch from './MapViewSwitch.svelte';

	interface Props {
		locale: Locale;
		view: MapReportView;
		providerName: string;
		filterLabels: readonly string[];
		/** The provider's line number, from the shared directory. */
		line: (id: string) => string;
		/** Identity of the rendered snapshot; copy success is tied to it. */
		snapshotId: string;
		/** The live link for the rendered camera and filters, or null when no view exists. */
		liveViewHref: string | null;
		presentation: 'pane' | 'overlay';
		copyLiveView: () => Promise<boolean>;
		onselect: (vehicleId: string) => void;
		onclose?: () => void;
		scrollTop?: number;
	}

	let {
		locale,
		view,
		providerName,
		filterLabels,
		line,
		snapshotId,
		liveViewHref,
		presentation,
		copyLiveView,
		onselect,
		onclose,
		scrollTop = $bindable(0),
	}: Props = $props();

	const t = $derived(mapReportsCopy(locale));
	const terms = $derived(transitTerms[locale]);
	const mapT = $derived(mapCopy[locale]);
	const headingId = $props.id();
	const csv = $derived(view.kind === 'ready' ? mapReportsCsv(view.model) : null);
	const model = $derived(view.kind === 'ready' ? view.model : null);
	const count = $derived(model ? intl.number(locale).format(model.inViewCount) : '');
	const noRecent = $derived(model ? intl.number(locale).format(model.noRecentInViewCount) : '');
	const unscoped = $derived(model ? intl.number(locale).format(model.unscopedMatchingCount) : '');
	const empty = $derived(model != null && model.rows.length === 0);

	let rootEl = $state<HTMLElement | null>(null);
	let scrollEl = $state<HTMLElement | null>(null);
	let copyState = $state<'idle' | 'copied' | 'failed'>('idle');
	let copiedSnapshot = $state<string | null>(null);
	let copyToken = 0;

	function reportTime(row: MapReportRow): string {
		const iso = row.ageBasis === 'reported_utc' ? row.reportedUtc : row.updatedUtc;
		if (!iso) return '';
		const date = new Date(iso);
		if (Number.isNaN(date.getTime())) return '';
		return formatLocalClock(date, locale, model?.timeZone);
	}

	function sourceTime(): string {
		if (!model) return '';
		return publicationTime(model.generatedUtc);
	}

	function publicationTime(iso: string): string {
		const date = new Date(iso);
		if (Number.isNaN(date.getTime())) return '';
		return formatUtc(iso, locale, {
			dateStyle: 'medium',
			timeStyle: 'short',
			timeZone: model?.timeZone,
		});
	}

	function ageLabel(row: MapReportRow): string {
		return row.ageSeconds == null ? '' : formatRelativeSeconds(row.ageSeconds, locale);
	}

	async function copy(): Promise<void> {
		const identity = snapshotId;
		const token = ++copyToken;
		const copied = await copyLiveView();
		if (token !== copyToken || identity !== snapshotId) return;
		if (!copied) {
			copyState = 'failed';
			copiedSnapshot = null;
			return;
		}
		copiedSnapshot = identity;
		copyState = 'copied';
	}

	// A later camera, filter or source change makes the announced copy belong to another view.
	$effect(() => {
		if (copyState === 'idle') return;
		if (copiedSnapshot != null && copiedSnapshot !== snapshotId) {
			copyState = 'idle';
			copiedSnapshot = null;
		}
	});

	$effect(() => {
		const el = scrollEl;
		if (!el) return;
		el.scrollTop = scrollTop;
		const onScroll = () => {
			scrollTop = el.scrollTop;
		};
		el.addEventListener('scroll', onScroll, { passive: true });
		return () => el.removeEventListener('scroll', onScroll);
	});

	$effect(() => {
		const el = rootEl?.closest('[data-slot="right-panel-body"]');
		const viewport = el?.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]');
		if (!viewport) return;
		viewport.scrollTop = scrollTop;
		return () => {
			scrollTop = viewport.scrollTop;
		};
	});
</script>

{#snippet body()}
	<div class="map-reports" bind:this={rootEl} data-slot="map-reports">
		<div class="map-reports-head">
			<h3 id={headingId} class="map-reports-title" tabindex="-1">{t.reportsTitle}</h3>
		</div>
		<p class="map-reports-provider">{providerName}</p>
		<p class="map-reports-scope">{t.reportsScope}</p>

		{#if filterLabels.length > 0}
			<div class="map-reports-filters" role="group" aria-label={mapT.activeTitle}>
				{#each filterLabels as label, index (index)}
					<span class="map-reports-filter">{label}</span>
				{/each}
			</div>
		{/if}

		{#if view.kind === 'loading'}
			<StateNotice
				title={view.reason === 'alerts' ? t.loadingAlerts : t.loading}
				tone="neutral"
				presentation="row"
				role="status"
			/>
		{:else if view.kind === 'unavailable'}
			<StateNotice
				title={view.reason === 'view'
					? t.unavailableView
					: view.reason === 'clock'
						? t.unavailableClock
						: view.reason === 'alerts'
							? t.unavailableAlerts
							: t.unavailableSource}
				glyph="!"
				tone="warning"
				presentation="row"
				role="status"
			/>
		{:else if model}
			<p class="map-reports-source">
				<span class="map-reports-source-label">{t.sourceTime}</span>
				<time datetime={model.generatedUtc}>{sourceTime()}</time>
				<span class="map-reports-zone">{model.timeZone}</span>
			</p>
			{#if model.alertFilter}
				<p class="map-reports-source" data-slot="map-report-alert-source">
					<span class="map-reports-source-label">{t.alertSourceTime}</span>
					<time datetime={model.alertFilter.generatedUtc}
						>{publicationTime(model.alertFilter.generatedUtc)}</time
					>
				</p>
				{#if model.alertFilter.dataState === 'last_available'}
					<p class="map-reports-warning" role="status">{t.alertRetainedWarning}</p>
				{/if}
			{/if}
			{#if model.sourceHealth?.failing}
				<p class="map-reports-warning" role="status">{t.retainedWarning}</p>
			{:else if model.sourceHealth?.stale}
				<p class="map-reports-warning" role="status">{t.staleWarning}</p>
			{/if}

			{#if empty}
				<p class="map-reports-empty">{t.reportsEmpty}</p>
			{:else}
				<p class="map-reports-count" data-slot="map-reports-count">
					{t.reportsCount(count, noRecent, model.inViewCount, model.noRecentInViewCount)}
				</p>
			{/if}
			{#if model.filters.includes('entity:stop') && !model.filters.includes('entity:bus')}
				<p class="map-reports-empty">{t.stopsOnly}</p>
			{/if}
			{#if model.unscopedMatchingCount > 0}
				<p class="map-reports-unscoped" data-slot="map-reports-unscoped">
					{t.unscoped(unscoped, model.unscopedMatchingCount)}
				</p>
			{/if}

			{#if model.rows.length > 0}
				<ol class="map-reports-list" aria-label={t.reportsScope}>
					{#each model.rows as row (row.index)}
						<li class="map-reports-row" data-report-row data-report-id={row.vehicleId}>
							<div class="map-reports-identity">
								<span class="map-reports-line"
									>{row.routeId ? line(row.routeId) : t.lineUnknown}</span
								>
								{#if row.noRecentPosition}
									<span class="map-reports-norecent">{terms.vehicle.noRecentPosition}</span>
								{/if}
							</div>
							<dl class="map-reports-facts">
								<div>
									<dt>{t.statusColumn}</dt>
									<dd>{mapStatusLabel(locale, row.status)}</dd>
								</div>
								<div>
									<dt>{t.delayColumn}</dt>
									<dd>{delayMeasurement(row.delayMin) ?? terms.delayUnknown}</dd>
								</div>
								<div>
									<dt>{t.reportAge}</dt>
									<dd>
										<span>{ageLabel(row)}</span>
										<span class="map-reports-time">
											{row.ageBasis === 'reported_utc'
												? t.reportedAt(reportTime(row))
												: t.sourceUpdatedAt(reportTime(row))}
										</span>
									</dd>
								</div>
							</dl>
							<Button
								variant="outline"
								size="sm"
								type="button"
								class="map-reports-select min-h-11"
								aria-label={t.selectVehicle(row.vehicleId)}
								data-report-select={row.vehicleId}
								onclick={() => onselect(row.vehicleId)}>{mapT.entityBus}</Button
							>
						</li>
					{/each}
				</ol>
			{/if}

			<div class="map-reports-actions">
				<div class="map-reports-copy">
					<Button
						variant="outline"
						size="sm"
						type="button"
						class="min-h-11 max-w-full whitespace-normal"
						disabled={!liveViewHref}
						onclick={() => void copy()}>{t.copyLiveView}</Button
					>
					<p class="map-reports-disclaimer">{t.copyDisclaimer}</p>
					{#if copyState !== 'idle'}
						<p class="map-reports-copystate" role="status" aria-live="polite">
							{copyState === 'copied' ? t.copied : t.copyFailed}
						</p>
					{/if}
				</div>
				{#if csv}
					<Button
						variant="outline"
						size="sm"
						class="min-h-11 max-w-full whitespace-normal"
						href={csv.href}
						download={csv.filename}>{t.downloadCsv}</Button
					>
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

{#if presentation === 'overlay'}
	<section class="map-reports-overlay" data-slot="map-reports" aria-labelledby={headingId}>
		<div class="map-reports-overlay-bar">
			<MapViewSwitch
				value="reports"
				{locale}
				onchange={(next) => {
					if (next === 'map') onclose?.();
				}}
			/>
		</div>
		<div class="map-reports-scroll" bind:this={scrollEl}>
			{@render body()}
		</div>
	</section>
{:else}
	{@render body()}
{/if}

<style>
	.map-reports {
		display: flex;
		min-width: 0;
		flex-direction: column;
		gap: 0.5rem;
	}
	.map-reports-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}
	.map-reports-title {
		margin: 0;
		font-family: var(--font-heading);
		font-size: var(--text-subheading);
		font-weight: 700;
		letter-spacing: var(--tracking-tight);
	}
	.map-reports-title:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
	.map-reports-provider {
		margin: 0;
		font-size: var(--text-caption);
		font-weight: 600;
		color: var(--foreground);
	}
	.map-reports-scope,
	.map-reports-source,
	.map-reports-count,
	.map-reports-unscoped,
	.map-reports-empty,
	.map-reports-warning,
	.map-reports-disclaimer,
	.map-reports-copystate {
		margin: 0;
		font-size: var(--text-caption);
		line-height: 1.45;
		color: var(--muted-foreground);
		overflow-wrap: anywhere;
	}
	.map-reports-count {
		color: var(--foreground);
	}
	.map-reports-warning {
		color: var(--foreground);
		padding: 0.5rem;
		border: 1px solid var(--border-hairline);
		border-radius: var(--radius-sm);
		background: var(--muted);
	}
	.map-reports-source {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.5rem;
		align-items: baseline;
	}
	.map-reports-source-label {
		font-weight: 600;
		color: var(--foreground);
	}
	.map-reports-zone {
		font-family: var(--font-mono);
		font-size: var(--text-micro);
	}
	.map-reports-filters {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
	}
	.map-reports-filter {
		padding: 0.125rem 0.4rem;
		border: 1px solid var(--border-hairline);
		border-radius: var(--radius-sm);
		font-size: var(--text-micro);
		color: var(--foreground);
	}
	.map-reports-list {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.map-reports-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 0.25rem 0.75rem;
		padding: 0.5rem 0;
		border-top: 1px solid var(--border-hairline);
	}
	.map-reports-identity {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.375rem;
		min-width: 0;
	}
	.map-reports-line {
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		font-weight: 700;
	}
	.map-reports-norecent {
		font-size: var(--text-micro);
		color: var(--muted-foreground);
	}
	.map-reports-facts {
		grid-column: 1 / -1;
		margin: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 1rem;
		font-size: var(--text-caption);
	}
	.map-reports-facts div {
		display: flex;
		align-items: baseline;
		gap: 0.3rem;
		min-width: 0;
	}
	.map-reports-facts dt {
		color: var(--muted-foreground);
		font-size: var(--text-micro);
	}
	.map-reports-facts dd {
		margin: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem 0.5rem;
	}
	.map-reports-time {
		color: var(--muted-foreground);
		font-size: var(--text-micro);
	}
	:global(.map-reports-select) {
		justify-self: end;
	}
	.map-reports-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-top: 0.25rem;
	}
	.map-reports-copy {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
	}
	.map-reports-overlay {
		position: absolute;
		inset: var(--chrome-offset) 0 0;
		z-index: var(--z-map-detail, 24);
		display: flex;
		flex-direction: column;
		min-height: 0;
		background: var(--card);
	}
	.map-reports-overlay-bar {
		display: flex;
		justify-content: flex-start;
		padding: calc(var(--spacing) * 2) calc(var(--spacing) * 3) 0;
	}
	.map-reports-scroll {
		min-height: 0;
		flex: 1;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: calc(var(--spacing) * 3);
	}
	@media (prefers-reduced-motion: reduce) {
		.map-reports-overlay {
			animation: none;
		}
	}
</style>
