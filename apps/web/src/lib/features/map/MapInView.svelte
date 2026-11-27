<script lang="ts">
	import { Button } from '@yesid/ui/button';
	import { Separator } from '@yesid/ui/separator';
	import { StatusMark } from '@yesid/ui/brand';
	import type { Snippet } from 'svelte';
	import { intl, localizeHref, type Locale } from '#lib/i18n/index.ts';
	import MapPanelAnswer from './MapPanelAnswer.svelte';
	import MapPanelRow from './MapPanelRow.svelte';
	import RecordActionGroup from '#lib/features/record/RecordActionGroup.svelte';
	import CiteBlock from '#lib/features/record/CiteBlock.svelte';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import { dateAndClock, liveStatusWords } from '#lib/site/presenter.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
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
	const display = transitDisplay();
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
<section
	class="[min-inline-size:0] [&>*]:[min-inline-size:0]"
	aria-labelledby={uid}
	data-slot="map-in-view"
>
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
				<MapPanelRow
					code={row.routeId ? line(row.routeId) : undefined}
					routePlate
					name={row.vehicleId}
					detail={heading
						? display.toward(
								display.directory.headsign(row.routeId, heading) ?? heading,
								locale,
								false,
							)
						: null}
					vehicleId={row.vehicleId}
					href={localizeHref(
						`/vehicle/${encodeURIComponent(row.vehicleId)}?frameMode=live`,
						locale,
						model.providerId,
					)}
					onselect={() => onselect(row.vehicleId)}
				>
					{#snippet value()}
						<StatusMark
							class="justify-end"
							status={row.status}
							{...liveStatusWords(
								row.status,
								mapStatusLabel(locale, row.status),
								row.delayMin === null ? null : row.delayMin * 60,
								locale,
							)}
						/>
					{/snippet}
				</MapPanelRow>
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
					<CiteBlock
						{locale}
						text={[
							`${model.providerName} · ${french ? 'Véhicules en vue' : 'Vehicles in view'}.`,
							`${dateAndClock(model.generatedUtc, locale, model.timeZone, true)}.`,
							model.methodologyVersion
								? `${french ? 'Méthode' : 'Method'} ${model.methodologyVersion}.`
								: '',
							model.attribution ?? '',
							t.copyDisclaimer,
							liveViewHref,
						]
							.filter(Boolean)
							.join(' ')}
					/>
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
