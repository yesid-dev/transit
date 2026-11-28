<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import type { StampProps } from '@yesid/ui/brand';
	import RecordBandBar from '../record/charts/RecordBandBar.svelte';
	import { Skeleton } from '@yesid/ui/skeleton';
	import RecordSkeleton from '../record/RecordSkeleton.svelte';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { Manifest } from '#lib/v1/schemas/index.ts';
	import { createLiveStore, type LiveFamilyState } from '#lib/v1/live/store.svelte.ts';
	import {
		alertsNotPublished,
		countedUnit,
		liveStampAge,
		officialAlertsLabel,
		recordRatio,
		singularCount,
		tickingLiveStamp,
	} from '#lib/site/presenter.ts';
	import { transitDisplay } from '#lib/site/transitDisplayContext.ts';
	import FactList from '../record/FactList.svelte';
	import FactRow from '../record/FactRow.svelte';
	import RecordAnswer from '../record/RecordAnswer.svelte';
	import RecordCard from '../record/RecordCard.svelte';
	import RecordDataTable, { type RecordTableRow } from '../record/RecordDataTable.svelte';
	import StateMark from '../record/StateMark.svelte';
	import { recordState } from '../record/recordStates';
	import { overviewCopy } from './overviewRecord.copy';
	import { OVERVIEW_LATE_LINE_LIMIT, tally } from './overviewRecord';
	import { selectLivePulse } from './homePulse';
	import { liveSummaryReader, summaryAlertCount, summaryLateLines } from './liveSummaryReader';

	let {
		locale,
		manifest,
		alertsAvailable,
		operator,
		officialAlertsUrl,
		operatorOf,
		link,
		onCaptureAge,
	}: {
		locale: Locale;
		manifest: Manifest | null;
		alertsAvailable: boolean;
		operator: string;
		officialAlertsUrl?: string;
		/** The French form of the agency after "de", as the city declares it. */
		operatorOf?: string | null;
		link: (path: string, live?: boolean) => string;
		onCaptureAge?: (age: number | null) => void;
	} = $props();

	const t = $derived(overviewCopy[locale]);
	const networkAvailable = $derived(manifest?.capabilities?.live_map === 'enabled');
	const display = transitDisplay();
	// The light live summary: the card's figures without the vehicle positions and alert texts.
	const live = untrack(() =>
		manifest
			? createLiveStore(manifest, liveSummaryReader, {
					families: [
						...(networkAvailable ? (['network'] as const) : []),
						...(alertsAvailable ? (['alerts'] as const) : []),
					],
				})
			: null,
	);
	onMount(() => {
		live?.start();
		return () => live?.stop();
	});

	const pulse = $derived(selectLivePulse(live?.network ?? null, locale));
	const health = $derived(live?.familyStates.network.health);
	const alertHealth = $derived(live?.familyStates.alerts.health);
	$effect(() => onCaptureAge?.(health?.ageSeconds ?? null));
	const stale = (health: LiveFamilyState['health'] | undefined) =>
		!!health?.retained && (health.isStale || health.notice != null);
	const networkStale = $derived(health?.retained === true && health.isStale);
	const distribution = $derived(live?.network?.status_dist);
	const lines = $derived(summaryLateLines(live?.network));
	const generated = $derived(live?.network?.generated_utc);
	const stamp: StampProps = $derived(
		tickingLiveStamp(generated ? new Date(generated) : new Date(Number.NaN), locale, {
			label: networkStale ? liveStampAge(health?.ageSeconds ?? null, locale, 'behind') : t.live,
			late: networkStale || health?.state === 'failed-no-data',
		}),
	);
	function reading(
		value: number | null | undefined,
		family: LiveFamilyState | undefined,
		available: boolean,
	) {
		if (!available) return { kind: 'absent', state: 'no_live_data' } as const;
		if (value != null) return { kind: 'value', value } as const;
		if (!family || family.health.state === 'failed-no-data') return { kind: 'failed' } as const;
		if (!family.health.retained && (family.phase === 'idle' || family.phase === 'loading'))
			return { kind: 'pending' } as const;
		return { kind: 'absent', state: 'not_measured' } as const;
	}
	const reporting = $derived(
		reading(pulse?.reporting, live?.familyStates.network, networkAvailable),
	);
	const silent = $derived(
		reading(
			pulse?.silentReading ? pulse.silent : null,
			live?.familyStates.network,
			networkAvailable,
		),
	);
	const alerts = $derived(
		alertsAvailable
			? reading(summaryAlertCount(live?.alerts), live?.familyStates.alerts, true)
			: ({ kind: 'absent', state: 'not_published' } as const),
	);
	const statuses = ['early', 'on_time', 'late', 'unknown'] as const;
	const bands = $derived(
		distribution
			? statuses.map((status) => ({
					id: status,
					status,
					label:
						status === 'unknown'
							? recordState('delay_unknown')[locale]
							: status === 'on_time'
								? t.onTime
								: t[status],
					share: distribution[status],
					valueLabel: countedUnit(distribution[status], 'vehicle', locale),
				}))
			: [],
	);
</script>

{#snippet readingValue(
	entry: ReturnType<typeof reading> | { kind: 'absent'; state: 'not_published' },
)}
	{#if entry.kind === 'value'}{tally(entry.value, locale)}
	{:else if entry.kind === 'pending'}<Skeleton class="h-lh w-16 max-w-full" />
	{:else if entry.kind === 'failed'}<span>{t.unavailable}</span>
	{:else}<StateMark state={entry.state} {locale} />{/if}
{/snippet}

<RecordCard interactive title={t.live} class="overview-live" {stamp} stampRule>
	<div class="live-readings" class:no-agency-alerts={!alertsAvailable}>
		{#if reporting.kind === 'pending'}
			<div class="grid min-w-0 gap-3" aria-busy="true" data-record-pending>
				<div class="grid min-h-16 content-start gap-2">
					<Skeleton class="h-12 w-28 max-w-full" />
					<Skeleton class="h-5 w-64 max-w-full" />
				</div>
				<RecordSkeleton shape="bands" />
				<RecordSkeleton shape={{ shape: 'facts', count: 2 }} />
				<div class="late-lines-waiting grid gap-3">
					<Skeleton class="h-6 w-48 max-w-full" />
					<RecordSkeleton shape={{ shape: 'table', rows: OVERVIEW_LATE_LINE_LIMIT }} />
				</div>
			</div>
		{:else}
			<div class="min-h-16">
				<RecordAnswer
					{locale}
					state={reporting.kind === 'absent' ? reporting.state : undefined}
					value={reporting.kind === 'value' ? tally(reporting.value, locale) : null}
					sentence={reporting.kind === 'failed'
						? t.liveUnavailable
						: reporting.kind === 'absent'
							? recordState(reporting.state)[locale]
							: singularCount(reporting.value, locale)
								? t.reportingOne
								: t.reporting}
				/>
			</div>
			{#if bands.length}
				<div class="mt-3">
					<RecordBandBar
						label={bands.map(({ label, valueLabel }) => `${label}, ${valueLabel}`).join('. ')}
						{bands}
					/>
				</div>
			{/if}
			<FactList class="mt-3">
				<FactRow
					label={t.silent}
					busy={silent.kind === 'pending'}
					detail={silent.kind === 'value' ? pulse?.silentReading?.detail : undefined}
				>
					{#if silent.kind === 'value' && pulse?.silentReading}
						<span class="font-semibold tabular-nums">{pulse.silentReading.value}</span>
					{:else}
						{@render readingValue(silent)}
					{/if}
				</FactRow>
				<FactRow
					label={t.alerts}
					busy={alerts.kind === 'pending'}
					detail={!alertsAvailable
						? alertsNotPublished(
								{ name: operator, frenchOf: operatorOf },
								locale,
								Boolean(officialAlertsUrl),
							)
						: stale(alertHealth)
							? liveStampAge(alertHealth?.ageSeconds ?? null, locale, 'behind')
							: undefined}
				>
					{@render readingValue(alerts)}
				</FactRow>
			</FactList>
			{#if lines.length}
				<h3 class="mt-4 font-semibold">{t.lateLines}</h3>
				{#snippet late(row: RecordTableRow & { late: string })}<strong class="font-sans"
						>{row.late}</strong
					>{/snippet}
				<RecordDataTable
					{locale}
					title={t.lateLines}
					rowHeader={locale === 'fr' ? 'Ligne' : 'Line'}
					rows={lines.map((row) => {
						const line = display.lineName(row.id);
						return {
							id: row.id,
							label: line.name ?? line.label,
							plate: { code: line.number ?? row.id },
							href: link('/lines/' + encodeURIComponent(row.id), true),
							late: recordRatio(row.late, tally(row.total, locale), locale),
						};
					})}
					columns={[{ key: 'late', header: t.late, numeric: true, cell: late }]}
					value="late"
					rowAlign="middle"
					phone={{}}
				/>
			{/if}
		{/if}
	</div>
	{#snippet links()}
		<a class="inline-flex min-h-11 items-center text-primary underline" href={link('/map', true)}
			>{t.openMap}</a
		>
		{#if alertsAvailable}<a
				class="inline-flex min-h-11 items-center text-primary underline"
				href={link('/alerts', true)}>{t.readAlerts}</a
			>{:else if officialAlertsUrl}<a
				class="inline-flex min-h-11 items-center text-primary underline"
				href={officialAlertsUrl}>{officialAlertsLabel(locale)}</a
			>{/if}
	{/snippet}
</RecordCard>

<style>
	/* Keep the timestamp's place in the header until the first capture supplies its age. */
	:global(.overview-live:has([data-record-pending]) header [data-slot='stamp']) {
		visibility: hidden;
	}
	.late-lines-waiting {
		display: none;
	}
	@media (width >= 64rem) {
		/* Count, status bar, two facts, and up to three late lines. */
		.live-readings {
			min-block-size: 38.5rem;
		}
		.late-lines-waiting {
			display: grid;
		}
		/* Allow one more line for the explanation of Ottawa's published notice sources. */
		.no-agency-alerts {
			min-block-size: 42rem;
		}
		@container (inline-size >= 32rem) {
			.no-agency-alerts {
				min-block-size: 41rem;
			}
		}
	}
</style>
