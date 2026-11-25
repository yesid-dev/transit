<script lang="ts">
	import { Button } from '@yesid/ui/button';
	import { RoutePlate, StatusMark } from '@yesid/ui/brand';
	import type { Snippet } from 'svelte';
	import { intl, localizeHref, type Locale } from '#lib/i18n/index.ts';
	import RecordAnswer from '#lib/features/record/RecordAnswer.svelte';
	import RecordPending from '#lib/features/record/RecordPending.svelte';
	import { delayReading } from '#lib/site/presenter.ts';
	import { mapReportsCopy } from './mapReports.copy';
	import { mapReportsCsv } from './mapReportsCsv';
	import { mapStatusLabel } from './mapStatusLabels';
	import type { MapReportView } from './mapReports';

	let {
		view,
		locale,
		line,
		onselect,
		stamp,
		liveViewHref,
		detail,
		limit = $bindable(12),
	}: {
		view: MapReportView;
		locale: Locale;
		line: (id: string) => string;
		onselect: (id: string) => void;
		stamp?: Snippet;
		liveViewHref?: string | null;
		detail?: Snippet;
		limit?: number;
	} = $props();
	const PAGE_SIZE = 12;
	let actions = $state(false);
	const t = $derived(mapReportsCopy(locale));
	const count = (value: number) => intl.number(locale).format(value);
	const french = $derived(locale === 'fr');
	const model = $derived(view.kind === 'ready' ? view.model : null);
	const lastAvailable = $derived(model?.sourceHealth?.retained || model?.sourceHealth?.stale);
	const rows = $derived(model?.rows ?? []);
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
	const csv = $derived(actions && model ? mapReportsCsv(model) : null);
	const uid = $props.id();
	let copyState = $state('');
	async function copyView() {
		if (!liveViewHref) return;
		try {
			await navigator.clipboard.writeText(liveViewHref);
			copyState = t.copied;
		} catch {
			copyState = t.copyFailed;
		}
	}
</script>

{#if model}
	<RecordAnswer value={count(model.inViewCount)} {sentence} {locale} />
{:else if view.kind === 'loading'}
	<RecordPending {locale} />
{/if}
{@render stamp?.()}
{@render detail?.()}

<section aria-labelledby={uid} data-slot="map-in-view">
	<div class="flex items-baseline justify-between gap-2">
		<h2 id={uid} class="text-lg font-semibold">
			{french ? 'Véhicules en vue' : 'Vehicles in view'}
		</h2>
		{#if model}<span class="text-sm tabular-nums text-muted-foreground"
				>{count(model.inViewCount)}</span
			>{/if}
	</div>
	{#if model}
		<ul class="list-none p-0">
			{#each rows.slice(0, limit) as row (`${row.vehicleId}:${row.index}`)}
				<li class="map-in-view-row">
					<span class="min-w-10"
						>{#if row.routeId}<RoutePlate code={line(row.routeId)} />{/if}</span
					>
					<span>
						<StatusMark status={row.status} label={mapStatusLabel(locale, row.status)} />
						{#if row.delayMin !== null}<small>{delayReading(row.delayMin * 60, locale)}</small>{/if}
					</span>
					<a
						class="map-in-view-link"
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
			<Button variant="outline" size="sm" class="min-h-11" onclick={() => (limit += PAGE_SIZE)}>
				{french ? 'Afficher 12 de plus' : 'Show 12 more'}
			</Button>
		{/if}
		{#if !rows.length}<p>{french ? 'Aucun véhicule en vue.' : 'No vehicles in view.'}</p>{/if}
		<details bind:open={actions} class="text-sm">
			<summary class="min-h-11 py-3">Actions</summary>
			{#if liveViewHref}<Button
					variant="outline"
					size="sm"
					class="min-h-11 max-w-full"
					wrap
					onclick={copyView}>{t.copyLiveView}</Button
				>{/if}
			{#if csv}<Button
					variant="outline"
					size="sm"
					class="min-h-11 max-w-full"
					href={csv.href}
					download={csv.filename}
					wrap>{t.downloadCsv}</Button
				>{/if}
			<p role="status">{copyState}</p>
		</details>
	{:else if view.kind === 'unavailable'}
		<p>{french ? 'Signalements indisponibles.' : 'Reports unavailable.'}</p>
	{/if}
</section>

<style>
	.map-in-view-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: calc(var(--spacing) * 2);
		border-block-start: 1px solid var(--border-hairline);
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
		text-decoration: underline;
	}
</style>
