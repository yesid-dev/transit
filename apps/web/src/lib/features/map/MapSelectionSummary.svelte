<script lang="ts">
	import { RoutePlate, StatusMark } from '@yesid/ui/brand';
	import { intl, localizeHref, type Locale } from '#lib/i18n/index.ts';
	import { absenceShort } from '#lib/site/absence.ts';
	import { carryFrameState } from '#lib/site/frameState.ts';
	import { stopViewHref } from '#lib/site/stopFrame.ts';
	import { liveStatusWords } from '#lib/site/presenter.ts';
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { vehicleLiveHref } from '#lib/features/vehicles/vehicleLinks.ts';
	import StateMark from '#lib/features/record/StateMark.svelte';
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
		scheduleOnly,
	}: {
		detail: MapSelectionDetail;
		locale: Locale;
		timeZone?: string;
		url: URL;
		city: string;
		vehiclesInView: number | null;
		notReporting?: boolean;
		scheduleOnly?: boolean;
	} = $props();
	const display = transitDisplay();
	const { line, readName } = display;
	const tr = (en: string, fr: string) => (locale === 'fr' ? fr : en);

	function pageHref(kind: 'lines' | 'stop', id: string, mode: 'live' | 'record') {
		const path = localizeHref(`/${kind}/${encodeURIComponent(id)}`, locale, city);
		const target = new URL(carryFrameState(path, url), url);
		target.searchParams.set('frameMode', mode);
		const view = kind === 'stop' ? stopViewHref(target, mode) : target;
		return view.pathname + view.search;
	}
</script>

{#snippet lineNow(id: string)}
	<a class="text-primary underline" href={pageHref('lines', id, 'live')}
		>{tr(`Line ${line(id)} now`, `Ligne ${line(id)} en direct`)}</a
	>
{/snippet}

<div class="selection-reading">
	{#if detail.kind === 'vehicle'}
		{@const routeId = detail.vehicle.route ?? detail.route?.id ?? null}
		{@const routeName = detail.route?.long ? readName(detail.route.long, locale) : ''}
		{@const destination = detail.routeDirection?.headsign}
		{#if routeId}<RoutePlate code={line(routeId)} />{/if}
		{#if routeName || destination}
			<p>
				{routeName}{routeName && destination ? ', ' : ''}{destination
					? display.toward(
							display.directory.headsign(routeId, destination) ?? destination,
							locale,
							false,
						)
					: ''}
			</p>
		{/if}
		<StatusMark
			status={detail.vehicle.status}
			{...liveStatusWords(
				detail.vehicle.status,
				mapStatusLabel(locale, detail.vehicle.status),
				detail.vehicle.delay_min == null ? null : detail.vehicle.delay_min * 60,
				locale,
			)}
		/>
		{#if notReporting}<p class="text-muted-foreground">
				{tr('No recent position.', 'Aucune position récente.')}
			</p>{/if}
		{#if detail.nextStops.length}
			<div data-slot="map-next-stops-panel">
				<p class="font-semibold">{tr('Next stops', 'Prochains arrêts')}</p>
				<ol class="list-decimal ps-5">
					{#each detail.nextStops.slice(0, 5) as stop, index (`${stop.id}:${index}`)}
						<li>{stop.name}</li>
					{/each}
				</ol>
			</div>
		{:else}
			<p>
				{tr('Next stop:', 'Prochain arr\u00eat\u00a0:')}
				{detail.nextStop
					? stopDisplayName(detail.nextStop.name)
					: absenceShort(detail.nextStopAbsence, locale)}
			</p>
		{/if}
		<div class="selection-links">
			<a class="text-primary underline" href={vehicleLiveHref(detail.id, url, locale, city)}
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
		<p class="font-semibold">{tr('Next departures', 'Prochains départs')}</p>
		{#if detail.departures === null}
			<StateMark state="no_live_data" {locale} />
		{:else if detail.departures.length === 0}
			<p>{tr('No departure is predicted now.', 'Aucun d\u00e9part pr\u00e9vu en ce moment.')}</p>
		{:else}
			<ul class="list-none p-0" data-slot="map-stop-predictions">
				{#each detail.departures.slice(0, 3) as departure, index (index)}
					{@const vehicle = departure.trip
						? detail.vehicles.find((item) => item.trip === departure.trip)
						: undefined}
					{@const clock = timeLabel(departure.eta_utc, locale, timeZone)}
					<li>
						{#if departure.route}{line(departure.route)}{/if}
						<time datetime={departure.eta_utc}>{clock}</time>
						{#if vehicle}
							{@const label = tr(`Vehicle ${vehicle.id}`, `Véhicule ${vehicle.id}`)}
							<a
								class="prediction-vehicle text-primary underline"
								href={vehicleLiveHref(vehicle.id, url, locale, city)}
								aria-label={`${label}, ${clock}`}>{label}</a
							>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
		<div class="selection-links">
			<a class="text-primary underline" href={pageHref('stop', detail.id, 'live')}
				>{tr('Stop now', 'Arrêt en direct')}</a
			>
			<a class="text-primary underline" href={pageHref('stop', detail.id, 'record')}
				>{tr('Stop Record', 'Bilan de l’arrêt')}</a
			>
		</div>
	{:else}
		<RoutePlate code={line(detail.id)} />
		{#each [...new Set(detail.directions.map((entry) => entry.terminalLabel ?? entry.label))] as terminal (terminal)}
			<p>{terminal}</p>
		{/each}
		{#if scheduleOnly || vehiclesInView === null}
			<StateMark state="no_live_data" {locale} />
		{:else}
			<p>
				{intl.number(locale).format(vehiclesInView)}
				{tr('vehicles in view', 'véhicules en vue')}
			</p>
		{/if}
		<div class="selection-links">
			{@render lineNow(detail.id)}
			<a class="text-primary underline" href={pageHref('lines', detail.id, 'record')}
				>{tr('Line Record', 'Bilan de la ligne')}</a
			>
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
	.selection-links a,
	.prediction-vehicle {
		display: inline-flex;
		align-items: center;
		min-height: var(--size-tap-min);
	}
	.stop-code {
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: calc(var(--spacing) * 0.5) calc(var(--spacing) * 2);
		font-family: var(--font-mono);
	}
</style>
