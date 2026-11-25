<script lang="ts">
	import { getLocalizeHref, type Locale } from '#lib/i18n/index.ts';
	import { routeFor } from '#lib/nav/index.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import { clockTime, minuteReading } from '#lib/site/presenter.ts';
	import { liveAbsenceReason, readLiveAbsenceContext } from '#lib/site/absence.ts';
	import { AbsentValue } from '#lib/components/edge/index.ts';
	import { STATUS_GLYPH, statusVar } from '#lib/components/dataviz/tokens.ts';
	import { departureStatusText, type StopLiveOrder, type StopLiveView } from './stopPredictions';
	import { detailCopy } from './stops.copy';

	interface Props {
		/** A view with a list; the absent states are worded by the caller next to its report. */
		view: Extract<StopLiveView, { kind: 'list' }>;
		order: StopLiveOrder;
		locale: Locale;
		timeZone?: string;
	}

	let { view, order = $bindable(), locale, timeZone }: Props = $props();

	const { line, readName } = transitDisplay();
	const absenceContext = readLiveAbsenceContext();
	const localizeHref = getLocalizeHref();
	const uid = $props.id();
	const t = $derived(detailCopy[locale].live);
	const lineLabel = $derived(detailCopy[locale].identity.line);
	const listFormat = $derived(
		new Intl.ListFormat(locale === 'fr' ? 'fr-CA' : 'en-CA', { type: 'disjunction' }),
	);
</script>

<div class="stop-live" data-slot="stop-live-predictions">
	<div class="stop-live__bar">
		<p class="stop-live__total">{t.total(view.total, view.groups.length)}</p>
		{#if view.groups.length > 1}
			<div class="stop-live__order">
				<label for="{uid}-order">{t.order}</label>
				<select
					id="{uid}-order"
					value={order}
					onchange={(event) => (order = event.currentTarget.value as StopLiveOrder)}
				>
					<option value="soonest">{t.orderSoonest}</option>
					<option value="line">{t.orderLine}</option>
				</select>
			</div>
		{/if}
	</div>

	<div class="stop-live__groups">
		{#each view.groups as group, gi (group.line ?? '')}
			{@const headingId = `${uid}-line-${gi}`}
			<section class="stop-live__line" aria-labelledby={headingId} data-line={group.line}>
				<h3 id={headingId} class="stop-live__heading">
					{#if group.line != null}
						<span class="stop-live__plate" translate="no"
							><span class="sr-only">{lineLabel('')}</span>{line(group.line)}</span
						>
					{:else}
						<span class="stop-live__plate stop-live__plate--none">{t.noLine}</span>
					{/if}
					<span class="stop-live__destination" data-known={group.destinations.length > 0}
						>{group.destinations.length > 0
							? t.toward(
									listFormat.format([
										...new Set(group.destinations.map((name) => readName(name, locale))),
									]),
								)
							: t.noDestination}</span
					>
				</h3>
				<table class="stop-live__table" aria-labelledby={headingId}>
					<thead>
						<tr>
							<th scope="col">{t.time}</th>
							<th scope="col">{t.status}</th>
							<th scope="col" class="stop-live__offset">{t.offset}</th>
						</tr>
					</thead>
					<tbody>
						{#each group.rows as row, ri (`${row.trip ?? ''}-${row.etaUtc ?? ''}-${ri}`)}
							<tr>
								<th scope="row" class="stop-live__time">
									{#if row.etaUtc == null}
										<span class="stop-live__unreadable">{t.timeUnreadable}</span>
									{:else if row.trip}
										<a href={localizeHref(routeFor({ kind: 'trip', id: row.trip }), locale)}
											><time datetime={row.etaUtc}
												>{clockTime(new Date(row.etaUtc), locale, timeZone)}</time
											><span class="sr-only">, {t.trip}</span></a
										>
									{:else}
										<time datetime={row.etaUtc}
											>{clockTime(new Date(row.etaUtc), locale, timeZone)}</time
										>
									{/if}
								</th>
								<td class="stop-live__status">
									{#if row.status.kind === 'known'}
										{@const single = row.status.bands.length === 1 ? row.status.bands[0] : null}
										<span data-bands={row.status.bands.join(' ')}
											>{#if single}<span
													class="stop-live__glyph"
													style:color={statusVar(single)}
													aria-hidden="true">{STATUS_GLYPH[single]}</span
												>{/if}{departureStatusText(row.delayMin, t, row.status)}</span
										>
									{:else}
										<AbsentValue
											variant="compact"
											reason={liveAbsenceReason('prediction-delay', absenceContext())}
											{locale}
										/>
									{/if}
								</td>
								<td class="stop-live__offset"
									>{#if row.delayMin != null && Number.isInteger(row.delayMin)}{minuteReading(
											row.delayMin,
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
			</section>
		{/each}
	</div>

	<div class="stop-live__notes">
		<p>{t.caveat}</p>
		<p>{t.destinationCaveat}</p>
		<p>{t.statusNote}</p>
	</div>
</div>

<style>
	.stop-live {
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
		min-width: 0;
		container-type: inline-size;
	}
	.stop-live__bar {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		justify-content: space-between;
		gap: 0.75rem 1.5rem;
	}
	.stop-live__total {
		margin: 0;
		color: var(--muted-foreground);
		font-size: var(--text-small);
		line-height: 1.5;
	}
	.stop-live__order {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
	}
	.stop-live__order label {
		font-size: var(--text-small);
		font-weight: 600;
	}
	.stop-live__order select {
		min-height: var(--size-tap-min);
		max-width: 100%;
		padding: 0.5rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--background);
		color: var(--foreground);
		font: inherit;
		font-size: var(--text-small);
	}
	.stop-live__groups {
		display: grid;
		gap: 1.5rem;
	}
	.stop-live__line {
		min-width: 0;
	}
	.stop-live__heading {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.25rem 0.75rem;
		margin: 0 0 0.5rem;
		font-size: var(--text-body);
		font-weight: 600;
		line-height: 1.4;
	}
	.stop-live__plate {
		display: inline-block;
		padding: 0.125rem 0.5rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		color: var(--foreground);
		font-family: var(--font-mono);
		font-size: var(--text-small);
		font-weight: 700;
	}
	.stop-live__plate--none {
		font-family: inherit;
		font-weight: 500;
	}
	.stop-live__destination {
		min-width: 0;
		overflow-wrap: normal;
		word-break: normal;
	}
	.stop-live__destination[data-known='false'] {
		color: var(--muted-foreground);
		font-weight: 400;
		font-size: var(--text-small);
	}
	.stop-live__table {
		width: 100%;
		border-collapse: collapse;
	}
	.stop-live__table th,
	.stop-live__table td {
		padding: 0.25rem 0.5rem 0.25rem 0;
		text-align: start;
		vertical-align: middle;
		border-bottom: 1px solid var(--border);
		overflow-wrap: normal;
		word-break: normal;
	}
	.stop-live__table thead th {
		color: var(--muted-foreground);
		font-size: var(--text-small);
		font-weight: 500;
	}
	.stop-live__time {
		font-size: var(--text-subheading);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.stop-live__time a {
		display: inline-flex;
		align-items: center;
		min-height: var(--size-tap-min);
		color: var(--foreground);
		text-decoration: underline;
		text-underline-offset: 0.2em;
	}
	.stop-live__time a:focus-visible,
	.stop-live__order select:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
	.stop-live__unreadable {
		color: var(--muted-foreground);
		font-size: var(--text-small);
		font-weight: 400;
		white-space: normal;
	}
	.stop-live__status {
		font-size: var(--text-small);
	}
	.stop-live__glyph {
		margin-inline-end: 0.375rem;
		font-size: var(--text-micro);
	}
	.stop-live__offset {
		text-align: end;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.stop-live__table th.stop-live__offset,
	.stop-live__table td.stop-live__offset {
		text-align: end;
		padding-inline-end: 0;
	}
	.stop-live__notes {
		display: grid;
		gap: 0.5rem;
		max-width: var(--measure-lede);
	}
	.stop-live__notes p {
		margin: 0;
		color: var(--muted-foreground);
		font-size: var(--text-small);
		line-height: 1.5;
	}
	@container (min-width: 48rem) {
		.stop-live__groups {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 1.5rem 2rem;
		}
	}
</style>
