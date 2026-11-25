<script lang="ts" module>
	import type { RouteFile, StopPrediction } from '#lib/v1/index.ts';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { RouteDetailCopy } from './lines.copy';
	export interface LineDirectionsProps {
		directions: RouteFile['directions'];
		predictions?: ReadonlyMap<string, StopPrediction>;
		mode?: 'live' | 'schedule';
		locale: Locale;
		copy: RouteDetailCopy;
		timeZone?: string;
	}
</script>

<script lang="ts">
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	const { directionName } = transitDisplay();
	import { getLocalizeHref } from '#lib/i18n/index.ts';
	import { routeFor } from '#lib/nav/index.ts';
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import { stopNameFallback } from '#lib/site/absence.ts';
	import { clockTime, minuteReading } from '#lib/site/presenter.ts';
	import { AbsentValue } from '#lib/components/edge/index.ts';
	import { lineViewsCopy } from './lineViews.copy';
	import { Button } from '@yesid/ui/button';
	let {
		directions,
		predictions = new Map(),
		mode = 'live',
		locale,
		copy,
		timeZone,
	}: LineDirectionsProps = $props();
	const t = $derived(lineViewsCopy[locale]);
	const uid = $props.id();
	const localizeHref = getLocalizeHref();
	let selected = $state('0');
	let expanded = $state<readonly string[]>([]);
	const dirs = $derived(directions ?? []);
	const index = $derived(Number(selected) < dirs.length ? Number(selected) : 0);
	const direction = $derived(dirs[index]);
	const name = (dir: NonNullable<RouteFile['directions']>[number]) =>
		directionName(dir.headsign ?? dir.stops?.at(-1)?.name, locale);
	const stopHref = (id: string) => localizeHref(routeFor({ kind: 'stop', id }), locale);
	const rows = $derived((direction?.stops ?? []).filter((stop) => predictions.has(stop.id)));
	const shared = $derived(
		(direction?.stops ?? []).some((stop) =>
			dirs.some((dir, i) => i !== index && dir.stops?.some((other) => other.id === stop.id)),
		),
	);
	function toggle(key: string) {
		expanded = expanded.includes(key)
			? expanded.filter((value) => value !== key)
			: [...expanded, key];
	}
</script>

<div class="line-directions-pane" data-slot="line-directions" data-mode={mode}>
	{#if dirs.length === 0}
		<p>{t.noDestinations}</p>
	{:else if mode === 'schedule'}
		<div class="line-directions">
			{#each dirs as dir, di (di)}
				{@const stops = dir.stops ?? []}
				<details class="line-direction">
					<summary
						><span>{name(dir)}</span><span class="count">{copy.stopsCount(stops.length)}</span
						></summary
					>
					<ol id="{uid}-stops-{di}">
						{#each expanded.includes(String(di)) ? stops : stops.slice(0, 6) as stop, si (stop.id + '-' + si)}
							<li>
								<a href={stopHref(stop.id)}
									><span class="sr-only">{copy.viewStop} {stop.seq} </span>{stop.name
										? stopDisplayName(stop.name)
										: stopNameFallback(stop.id, locale)}</a
								>
							</li>
						{/each}
					</ol>
					{#if stops.length > 6}<Button
							variant="outline"
							class="min-h-11"
							aria-expanded={expanded.includes(String(di))}
							aria-controls="{uid}-stops-{di}"
							onclick={() => toggle(String(di))}
							>{expanded.includes(String(di)) ? t.showLess : t.showAll(stops.length)}</Button
						>{/if}
				</details>
			{/each}
		</div>
	{:else}
		<label for="{uid}-destination">{t.destination}</label>
		<select
			id="{uid}-destination"
			value={selected}
			onchange={(event) => (selected = event.currentTarget.value)}
		>
			{#each dirs as dir, di (di)}<option value={String(di)}>{name(dir)}</option>{/each}
		</select>
		<p>{t.predictionCaveat}</p>
		{#if shared}<p>{t.shared}</p>{/if}
		{#if rows.length > 0 && direction}
			<table id="{uid}-predictions">
				<caption>{t.predictionCaption(name(direction))}</caption>
				<thead
					><tr
						><th scope="col">{copy.stopColumns.stop}</th><th scope="col">{t.predictedTime}</th><th
							scope="col">{t.offsetColumn}</th
						></tr
					></thead
				>
				<tbody>
					{#each expanded.includes('live-' + selected) ? rows : rows.slice(0, 6) as stop, si (stop.id + '-' + si)}
						{@const prediction = predictions.get(stop.id)!}
						<tr>
							<th scope="row"
								><a href={stopHref(stop.id)}
									><span class="sr-only">{copy.viewStop} {stop.seq} </span>{stop.name
										? stopDisplayName(stop.name)
										: stopNameFallback(stop.id, locale)}</a
								></th
							>
							<td
								>{#if prediction.etaUtc}<time datetime={prediction.etaUtc}
										>{clockTime(new Date(prediction.etaUtc), locale, timeZone)}</time
									>{:else}{copy.approaching}{/if}</td
							>
							<td
								>{#if Number.isFinite(prediction.delayMin) && prediction.delayMin != null}{minuteReading(
										prediction.delayMin,
										locale,
										true,
									)}{:else}<AbsentValue
										variant="compact"
										disclosure={false}
										reason="not-reported"
										{locale}
									/>{/if}</td
							>
						</tr>
					{/each}
				</tbody>
			</table>
			{#if rows.length > 6}<Button
					variant="outline"
					class="min-h-11"
					aria-expanded={expanded.includes('live-' + selected)}
					aria-controls="{uid}-predictions"
					onclick={() => toggle('live-' + selected)}
					>{expanded.includes('live-' + selected) ? t.showLess : t.showAll(rows.length)}</Button
				>{/if}
		{:else}<p data-slot="no-predictions">{t.noPredictions}</p>{/if}
	{/if}
</div>

<style>
	.line-directions-pane {
		min-width: 0;
		container-type: inline-size;
	}
	.line-directions {
		display: grid;
		gap: 1.5rem;
	}
	summary {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		min-height: 2.75rem;
		cursor: pointer;
		font-weight: 600;
	}
	summary span {
		min-width: 0;
		overflow-wrap: normal;
		word-break: normal;
	}
	.count {
		color: var(--muted-foreground);
		font-size: var(--text-small);
	}
	label {
		display: block;
		font-weight: 600;
		margin-bottom: 0.5rem;
	}
	select {
		width: 100%;
		min-height: 2.75rem;
		background: var(--background);
		color: var(--foreground);
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		padding: 0.5rem;
		font: inherit;
	}
	p {
		color: var(--muted-foreground);
		line-height: 1.5;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--text-small);
	}
	caption {
		text-align: start;
		margin-bottom: 0.75rem;
		color: var(--muted-foreground);
	}
	th,
	td {
		text-align: start;
		padding: 0.5rem 0.25rem;
		vertical-align: top;
		overflow-wrap: normal;
		word-break: normal;
		border-bottom: 1px solid var(--border);
	}
	th {
		font-weight: 500;
	}
	td {
		font-variant-numeric: tabular-nums;
	}
	td:last-child {
		white-space: nowrap;
	}
	a {
		display: inline-flex;
		align-items: center;
		min-height: 2.75rem;
		color: var(--foreground);
		text-decoration: underline;
		text-underline-offset: 0.2em;
	}
	a:focus-visible,
	summary:focus-visible,
	select:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
	ol {
		padding-left: 1.5rem;
	}
	li {
		padding-block: 0.125rem;
	}
	@container (min-width: 42rem) {
		.line-directions {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
</style>
