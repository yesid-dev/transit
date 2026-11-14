<script lang="ts" module>
	import type { RouteFile, StopPrediction } from '#lib/v1/index.ts';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { RouteDetailCopy } from './lines.copy';

	export interface LineDirectionsProps {
		directions: RouteFile['directions'];
		predictions: ReadonlyMap<string, StopPrediction>;
		locale: Locale;
		copy: RouteDetailCopy;
		/** The network's zone (the manifest's `tz`); predicted arrivals read in it. */
		timeZone?: string;
	}
</script>

<script lang="ts">
	import '#lib/components/surface/compact-row.css';
	import { readableName } from '#lib/components/surface/readableName.ts';
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import { liveAbsenceReason, readLiveAbsenceContext } from '#lib/site/absence.ts';
	const absenceContext = readLiveAbsenceContext();
	import { getLocalizeHref } from '#lib/i18n/index.ts';
	import { routeFor } from '#lib/nav/index.ts';
	import { stopNameFallback } from '#lib/site/absence.ts';
	import { formatLocalClock } from '#lib/utils/time.ts';
	import { delayLabel, delayTone } from '#lib/site/delayPresentation.ts';
	import { AbsentValue } from '#lib/components/edge/index.ts';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';

	const localizeHref = getLocalizeHref();

	let { directions, predictions, locale, copy, timeZone }: LineDirectionsProps = $props();
	const uid = $props.id();

	const stopHref = (stopId: string): string =>
		localizeHref(routeFor({ kind: 'stop', id: stopId }), locale);

	const timeLabel = (iso: string): string => formatLocalClock(new Date(iso), locale, timeZone);
</script>

{#if (directions ?? []).length > 0}
	<div class="line-directions-pane" data-slot="line-directions">
		<div class="line-directions">
			{#each directions ?? [] as dir, di (di)}
				<details class="line-direction">
					<summary class="line-direction-head">
						<span
							id="{uid}-direction-{di}"
							class="line-direction-name readable-name"
							title={dir.headsign ?? copy.direction(dir.dir)}
							use:readableName
						>
							{dir.headsign ?? copy.direction(dir.dir)}
						</span>
						<span class="line-direction-meta">
							{copy.stopsCount((dir.stops ?? []).length)}
						</span>
						<ChevronRightIcon size={16} strokeWidth={2.4} aria-hidden="true" />
					</summary>
					{#if (dir.stops ?? []).length > 0}
						<table class="line-stops" aria-labelledby="{uid}-direction-{di}">
							<thead>
								<tr>
									<th scope="col">{copy.stopColumns.stop}</th>
									<th scope="col">{copy.stopColumns.arrival}</th>
									<th scope="col">{copy.stopColumns.delay}</th>
								</tr>
							</thead>
							<tbody>
								{#each dir.stops ?? [] as stop, si (stop.id + '-' + si)}
									{@const prediction = predictions.get(stop.id) ?? null}
									<tr class="line-stop">
										<th scope="row">
											<a class="line-stop-link" href={stopHref(stop.id)}>
												<span class="sr-only">{copy.viewStop} </span>
												<span class="line-stop-seq">{stop.seq}</span>
												<span
													class="line-stop-name readable-name"
													title={stop.name
														? stopDisplayName(stop.name)
														: stopNameFallback(stop.id, locale)}
													use:readableName
													>{stop.name
														? stopDisplayName(stop.name)
														: stopNameFallback(stop.id, locale)}</span
												>
												<ChevronRightIcon size={14} strokeWidth={2.4} aria-hidden="true" />
											</a>
										</th>
										{#if prediction}
											<td class="line-stop-live">
												{#if prediction.etaUtc}
													<time class="line-stop-eta" datetime={prediction.etaUtc}>
														{timeLabel(prediction.etaUtc)}
													</time>
												{:else}
													<span class="line-stop-eta">{copy.approaching}</span>
												{/if}
											</td>
											<td class="line-stop-live">
												{#if prediction.delayMin != null}
													<span class="line-stop-delay" data-tone={delayTone(prediction.delayMin)}>
														{delayLabel(prediction.delayMin, copy)}
													</span>
												{:else}
													<AbsentValue
														reason={liveAbsenceReason('trip-prediction-delay', absenceContext())}
														variant="row"
														{locale}
													/>
												{/if}
											</td>
										{:else}
											<td class="line-stop-live" colspan="2">
												<AbsentValue
													reason={liveAbsenceReason('trip-prediction', absenceContext())}
													variant="row"
													{locale}
												/>
											</td>
										{/if}
									</tr>
								{/each}
							</tbody>
						</table>
					{/if}
				</details>
			{/each}
		</div>
	</div>
{/if}

<style>
	.line-directions-pane {
		container-type: inline-size;
		container-name: line-directions;
	}
	.line-directions {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}
	@container line-directions (min-width: 44rem) {
		.line-directions {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(min(20rem, 100%), 1fr));
			gap: 1.5rem 2rem;
			align-items: start;
		}
	}
	.line-direction-head {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-height: 2.75rem;
		cursor: pointer;
		list-style: none;
	}
	.line-direction-head::-webkit-details-marker {
		display: none;
	}
	.line-direction-head:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
		border-radius: var(--radius-md);
	}
	.line-direction-head :global(svg) {
		flex: none;
		color: var(--muted-foreground);
	}
	.line-direction-head:hover :global(svg) {
		color: var(--foreground);
	}
	.line-direction[open] > .line-direction-head :global(svg) {
		rotate: 90deg;
	}
	.line-direction-name {
		flex: 1 1 auto;
		min-width: 0;
		font-family: var(--font-heading);
		font-weight: 600;
		font-size: var(--text-subheading);
		color: var(--foreground);
	}
	.line-direction-meta {
		flex-shrink: 0;
		font-family: var(--font-mono);
		font-size: var(--text-small);
		color: var(--muted-foreground);
	}
	.line-stops {
		width: 100%;
		margin-top: 0.5rem;
		border-collapse: collapse;
	}
	.line-stops thead th {
		padding: 0 0 0.375rem 0.75rem;
		font-family: var(--font-mono);
		font-size: var(--text-micro);
		font-weight: 600;
		color: var(--muted-foreground);
		text-align: start;
		text-wrap: balance;
		vertical-align: bottom;
	}
	/* Words, not letters: the section's break-anywhere wrapping would shrink these columns to a glyph. */
	.line-stops thead th,
	.line-stop-live {
		overflow-wrap: normal;
		word-break: normal;
	}
	.line-stops thead th:first-child {
		width: 100%;
		padding-inline-start: 0;
	}
	.line-stop th {
		padding: 0;
		font-weight: inherit;
		text-align: start;
	}
	.line-stop {
		border-bottom: 1px solid var(--border-subtle, var(--border));
	}
	.line-stop:last-child {
		border-bottom: none;
	}
	.line-stop-link {
		display: grid;
		grid-template-columns: 2ch minmax(0, 1fr) auto;
		width: calc(100% + 1rem);
	}
	.line-stop-seq {
		min-width: 2ch;
		font-family: var(--font-mono);
		font-size: var(--text-small);
		color: var(--muted-foreground);
		text-align: right;
	}
	.line-stop-name {
		font-size: var(--text-card-body);
		color: var(--foreground);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: normal;
		transition: color var(--duration-fast) var(--ease-out);
	}
	.line-stop-live {
		padding-inline-start: 0.75rem;
		font-family: var(--font-mono);
		font-size: var(--text-micro);
	}
	.line-stop-eta {
		white-space: nowrap;
		font-weight: 600;
		color: var(--foreground);
	}
	.line-stop-delay {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-weight: 600;
		color: var(--muted-foreground);
	}
	.line-stop-delay::before {
		content: '';
		width: 0.4rem;
		height: 0.4rem;
		border-radius: var(--radius-pill);
		background: currentcolor;
		flex: none;
	}
	.line-stop-delay[data-tone='none'] {
		color: var(--muted-foreground);
	}
	.line-stop-delay[data-tone='none']::before {
		display: none;
	}
	.line-stop-delay[data-tone='early'] {
		color: var(--dataviz-status-early);
	}
	.line-stop-delay[data-tone='on-time'] {
		color: var(--dataviz-status-on-time);
	}
	.line-stop-delay[data-tone='late'] {
		color: var(--dataviz-status-late);
	}
	.line-stop-delay[data-tone='severe'] {
		color: var(--dataviz-status-severe);
	}
	.line-stop-link :global(svg) {
		opacity: 0.45;
		transition:
			opacity var(--duration-fast) var(--ease-out),
			transform var(--duration-fast) var(--ease-out);
	}
	.line-stop-link:hover :global(svg) {
		opacity: 1;
		transform: translateX(2px);
	}
	@media (prefers-reduced-motion: reduce) {
		.line-stop-link,
		.line-stop-name,
		.line-stop-link :global(svg) {
			transition: none;
		}
		.line-stop-link:hover :global(svg) {
			transform: none;
		}
	}
</style>
