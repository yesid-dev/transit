<script lang="ts">
	import { Button } from '@yesid/ui/button';
	import { Separator } from '@yesid/ui/separator';
	import { RoutePlate, StatusMark } from '@yesid/ui/brand';
	import type { Snippet } from 'svelte';
	import { intl, localizeHref, type Locale } from '#lib/i18n/index.ts';
	import MapPanelAnswer from './MapPanelAnswer.svelte';
	import RecordActionGroup from '#lib/features/record/RecordActionGroup.svelte';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import { dateAndClock, liveStatusWords, mapDirectionReading } from '#lib/site/presenter.ts';
	import { mapReportsCopy } from './mapReports.copy';
	import { mapReportsCsv } from './mapReportsCsv';
	import { mapStatusLabel } from './mapStatusLabels';
	import type { MapReportRow, MapReportView } from './mapReports';

	let {
		view,
		locale,
		line,
		headsign,
		onselect,
		stamp,
		liveViewHref,
		detail,
		limit = $bindable(12),
	}: {
		view: MapReportView;
		locale: Locale;
		line: (id: string) => string;
		headsign: (row: MapReportRow) => string | null;
		onselect: (id: string) => void;
		stamp?: Snippet;
		liveViewHref?: string | null;
		detail?: Snippet;
		limit?: number;
	} = $props();
	const PAGE_SIZE = 12;
	const t = $derived(mapReportsCopy(locale));
	const count = (value: number) => intl.number(locale).format(value);
	const french = $derived(locale === 'fr');
	const model = $derived(view.kind === 'ready' ? view.model : null);
	const csv = $derived(model ? mapReportsCsv(model) : null);
	const lastAvailable = $derived(model?.sourceHealth?.retained || model?.sourceHealth?.stale);
	const order = { late: 0, early: 1, on_time: 2, unknown: 3 } as const;
	const rows = $derived(
		[...(model?.rows ?? [])].sort(
			(a, b) =>
				order[a.status] - order[b.status] ||
				(b.delayMin ?? -Infinity) - (a.delayMin ?? -Infinity) ||
				a.vehicleId.localeCompare(b.vehicleId),
		),
	);
	const statuses = $derived(
		rows.reduce(
			(counts, row) => {
				counts[row.status] += 1;
				return counts;
			},
			{ early: 0, on_time: 0, late: 0, unknown: 0 },
		),
	);
	const sentence = $derived(
		french
			? `véhicules en vue ${lastAvailable ? 'au dernier signalement' : 'en ce moment'}\u00a0: ${count(statuses.early)} en avance, ${count(statuses.on_time)} à l’heure, ${count(statuses.late)} en retard, ${count(statuses.unknown)} au retard inconnu.`
			: `vehicles in view ${lastAvailable ? 'at the last report' : 'now'}: ${count(statuses.early)} early, ${count(statuses.on_time)} on time, ${count(statuses.late)} late, ${count(statuses.unknown)} with unknown delay.`,
	);
	const uid = $props.id();
</script>

{#if model}
	<MapPanelAnswer value={count(model.inViewCount)} {sentence} />
{:else if view.kind === 'loading'}
	<RecordPending {locale} />
{/if}
{@render stamp?.()}
{@render detail?.()}

<Separator decorative />
<section aria-labelledby={uid} data-slot="map-in-view">
	<div class="flex items-baseline justify-between gap-2">
		<h2 id={uid} class="text-lg font-semibold" tabindex="-1" data-map-in-view-title>
			{french ? 'Véhicules en vue' : 'Vehicles in view'}
		</h2>
		{#if model}<span
				class="text-sm tabular-nums text-muted-foreground"
				data-slot="map-in-view-count">{count(model.inViewCount)}</span
			>{/if}
	</div>
	{#if model}
		<ul class="list-none p-0">
			{#each rows.slice(0, limit) as row (`${row.vehicleId}:${row.index}`)}
				{@const heading = headsign(row)}
				<li class="map-in-view-row" data-report-row data-report-id={row.vehicleId}>
					<span
						>{#if row.routeId}<RoutePlate code={line(row.routeId)} />{/if}</span
					>
					<span>
						<StatusMark
							status={row.status}
							{...liveStatusWords(
								row.status,
								mapStatusLabel(locale, row.status),
								row.delayMin === null ? null : row.delayMin * 60,
								locale,
							)}
						/>
						{#if heading}<small>{mapDirectionReading(heading, locale)}</small>{/if}
					</span>
					<a
						class="map-in-view-link text-primary underline"
						data-in-view-vehicle={row.vehicleId}
						href={localizeHref(
							`/vehicle/${encodeURIComponent(row.vehicleId)}?frameMode=live`,
							locale,
							model.providerId,
						)}
						onclick={(event) => {
							if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
							event.preventDefault();
							onselect(row.vehicleId);
						}}>{row.vehicleId}</a
					>
				</li>
			{/each}
		</ul>
		{#if rows.length > limit}
			<p class="text-sm text-muted-foreground">
				{french
					? `${count(limit)} sur ${count(rows.length)}`
					: `Showing ${count(limit)} of ${count(rows.length)}`}
			</p>
			<Button variant="outline" size="cta-sm" class="min-h-11" onclick={() => (limit += PAGE_SIZE)}>
				{french ? 'Afficher 12 de plus' : 'Show 12 more'}
			</Button>
		{/if}
		{#if !rows.length}<p>{french ? 'Aucun véhicule en vue.' : 'No vehicles in view.'}</p>{/if}
		{#if liveViewHref}
			<RecordActionGroup
				{locale}
				href={liveViewHref}
				groupLabel={french ? 'Actions de la vue en direct' : 'Live view actions'}
				createDownload={() => csv}
				files={[]}
			>
				{#snippet citation()}
					<p>
						{model.providerName} · {french ? 'V\u00e9hicules en vue' : 'Vehicles in view'}
					</p>
					<p>
						<time datetime={model.generatedUtc}
							>{dateAndClock(model.generatedUtc, locale, model.timeZone, true)}</time
						>
					</p>
					{#if model.methodologyVersion}<p>
							{french ? 'M\u00e9thode' : 'Method'}
							{model.methodologyVersion}
						</p>{/if}
					{#if model.attribution}<p>{model.attribution}</p>{/if}
					<p>{t.copyDisclaimer}</p>
					<a class="text-primary underline" href={liveViewHref}
						>{french ? 'Vue en direct' : 'Live view'}</a
					>
				{/snippet}
			</RecordActionGroup>
			<p class="text-sm text-muted-foreground">{t.copyDisclaimer}</p>
		{/if}
	{:else if view.kind === 'unavailable'}
		<p role="status">
			{view.reason === 'alerts' ? t.unavailableAlerts : t.unavailableSource}
		</p>
	{/if}
</section>

<style>
	.map-in-view-row {
		display: grid;
		grid-template-columns: 2.75rem minmax(0, 1fr) auto;
		align-items: center;
		column-gap: calc(var(--spacing) * 2);
		font-size: var(--text-small);
	}
	.map-in-view-row small {
		display: block;
		color: var(--muted-foreground);
	}
	.map-in-view-link {
		display: inline-flex;
		align-items: center;
		min-height: var(--size-tap-min);
		min-width: var(--size-tap-min);
		margin-inline-start: auto;
		font-family: var(--font-mono);
	}
</style>
