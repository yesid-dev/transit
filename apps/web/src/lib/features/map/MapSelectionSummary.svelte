<script lang="ts">
	import { RoutePlate, StatusMark } from '@yesid/ui/brand';
	import { intl, localizeHref, type Locale } from '#lib/i18n/index.ts';
	import { carryFrameState } from '#lib/site/frameState.ts';
	import { delayReading, mapDirectionReading } from '#lib/site/presenter.ts';
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { vehicleLiveHref } from '#lib/features/vehicles/vehicleLinks.ts';
	import type { MapSelectionDetail } from './mapSelectionSession.svelte';
	import { timeLabel } from './mapSelectionDetail.logic';
	import { mapStatusLabel } from './mapStatusLabels';

	let {
		detail,
		locale,
		timeZone,
		url,
		city,
		vehiclesInView,
		notReporting,
	}: {
		detail: MapSelectionDetail;
		locale: Locale;
		timeZone?: string;
		url: URL;
		city: string;
		vehiclesInView: number | null;
		notReporting?: boolean;
	} = $props();
	const { line, readName } = transitDisplay();
	const tr = (en: string, fr: string) => (locale === 'fr' ? fr : en);

	function pageHref(kind: 'lines' | 'stop', id: string, mode: 'live' | 'record') {
		const path = localizeHref(`/${kind}/${encodeURIComponent(id)}`, locale, city);
		const target = new URL(carryFrameState(path, url), url);
		target.searchParams.set('frameMode', mode);
		return target.pathname + target.search;
	}
</script>

{#snippet lineNow(id: string)}
	<a href={pageHref('lines', id, 'live')}
		>{tr(`Line ${line(id)} now`, `Ligne ${line(id)} en direct`)}</a
	>
{/snippet}

<div class="selection-reading">
	{#if detail.kind === 'vehicle'}
		{@const routeId = detail.vehicle.route}
		{@const routeName = detail.route?.long ? readName(detail.route.long, locale) : ''}
		{@const destination = detail.routeDirection?.headsign}
		{#if routeId}<RoutePlate code={line(routeId)} />{/if}
		{#if routeName || destination}
			<p>
				{routeName}{routeName && destination ? ', ' : ''}{destination
					? mapDirectionReading(destination, locale)
					: ''}
			</p>
		{/if}
		<StatusMark
			status={detail.vehicle.status}
			label={mapStatusLabel(locale, detail.vehicle.status)}
			detail={detail.vehicle.delay_min == null
				? undefined
				: delayReading(detail.vehicle.delay_min * 60, locale)}
		/>
		{#if notReporting}<p class="text-muted-foreground">
				{tr('No recent position.', 'Aucune position récente.')}
			</p>{/if}
		{#if detail.nextStop}
			<p>{tr('Next stop:', 'Prochain arrêt\u00a0:')} {stopDisplayName(detail.nextStop.name)}</p>
		{/if}
		<div class="selection-links">
			<a href={vehicleLiveHref(detail.id, url, locale, city)}
				>{tr(`Vehicle ${detail.id}`, `Véhicule ${detail.id}`)}</a
			>
			{#if routeId}{@render lineNow(routeId)}{/if}
		</div>
	{:else if detail.kind === 'stop'}
		{#if detail.stop.code}<span class="stop-code">{detail.stop.code}</span>{/if}
		{#if detail.stop.routes?.length}
			<ul
				class="flex list-none flex-wrap gap-2 p-0"
				aria-label={tr('Lines serving this stop', 'Lignes à cet arrêt')}
			>
				{#each detail.stop.routes as id (id)}
					<li><RoutePlate code={line(id)} /></li>
				{/each}
			</ul>
		{/if}
		{#if detail.departures?.length}
			<p class="font-semibold">{tr('Next departures', 'Prochains départs')}</p>
			<ul class="list-none p-0">
				{#each detail.departures.slice(0, 3) as departure, index (index)}
					<li>
						{#if departure.route}{line(departure.route)}{/if}
						<time datetime={departure.eta_utc}
							>{timeLabel(departure.eta_utc, locale, timeZone)}</time
						>
					</li>
				{/each}
			</ul>
		{/if}
		<div class="selection-links">
			<a href={pageHref('stop', detail.id, 'live')}>{tr('Stop now', 'Arrêt en direct')}</a>
			<a href={pageHref('stop', detail.id, 'record')}>{tr('Stop Record', 'Bilan de l’arrêt')}</a>
		</div>
	{:else}
		<RoutePlate code={line(detail.id)} />
		{#each [...new Set(detail.directions.map((entry) => entry.terminalLabel ?? entry.label))] as terminal (terminal)}
			<p>{terminal}</p>
		{/each}
		{#if vehiclesInView !== null}
			<p>
				{intl.number(locale).format(vehiclesInView)}
				{tr('vehicles in view', 'véhicules en vue')}
			</p>
		{/if}
		<div class="selection-links">
			{@render lineNow(detail.id)}
			<a href={pageHref('lines', detail.id, 'record')}>{tr('Line Record', 'Bilan de la ligne')}</a>
		</div>
	{/if}
</div>

<style>
	.selection-reading {
		display: grid;
		justify-items: start;
		gap: calc(var(--spacing) * 2);
	}
	.selection-links {
		display: flex;
		flex-wrap: wrap;
		gap: 0 calc(var(--spacing) * 3);
	}
	.selection-links a {
		display: inline-flex;
		align-items: center;
		min-height: var(--size-tap-min);
		color: var(--accent-text);
		text-decoration: underline;
	}
	.stop-code {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: calc(var(--spacing) * 0.5) calc(var(--spacing) * 2);
		font-family: var(--font-mono);
	}
</style>
