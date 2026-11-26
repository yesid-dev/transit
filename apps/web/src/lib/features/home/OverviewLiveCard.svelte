<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import type { StampProps } from '@yesid/ui/brand';
	import RecordBandBar from '../record/charts/RecordBandBar.svelte';
	import { Skeleton } from '@yesid/ui/skeleton';
	import RecordSkeleton from '../record/RecordSkeleton.svelte';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { Manifest } from '#lib/v1/schemas/index.ts';
	import { liveReader } from '#lib/v1/adapter/index.ts';
	import { createLiveStore, type LiveFamilyState } from '#lib/v1/live/store.svelte.ts';
	import {
		alertsNotCollected,
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
	import { lateLines, tally } from './overviewRecord';
	import { selectLivePulse } from './homePulse';

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
	const live = untrack(() =>
		manifest
			? createLiveStore(manifest, liveReader, {
					families: [
						...(networkAvailable ? (['network', 'vehicles'] as const) : []),
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
	const networkStale = $derived(stale(health));
	const distribution = $derived(live?.network?.status_dist);
	const lines = $derived(lateLines(live?.vehicles?.vehicles ?? []));
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
			? reading(live?.alerts?.alerts.length, live?.familyStates.alerts, true)
			: ({ kind: 'absent', state: 'alerts_not_tracked' } as const),
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
	entry: ReturnType<typeof reading> | { kind: 'absent'; state: 'alerts_not_tracked' },
)}
	{#if entry.kind === 'value'}{tally(entry.value, locale)}
	{:else if entry.kind === 'pending'}<Skeleton class="h-lh w-16 max-w-full" />
	{:else if entry.kind === 'failed'}<span>{t.unavailable}</span>
	{:else}<StateMark state={entry.state} {locale} />{/if}
{/snippet}

<RecordCard interactive title={t.live} stamp={reporting.kind === 'pending' ? undefined : stamp}>
	{#if reporting.kind === 'pending'}
		<div class="grid min-w-0 gap-3" aria-busy="true" data-record-pending>
			<Skeleton class="h-12 w-28 max-w-full" />
			<Skeleton class="h-5 w-64 max-w-full" />
			<RecordSkeleton shape="bands" />
			<RecordSkeleton shape="facts" />
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
					? alertsNotCollected({ name: operator, frenchOf: operatorOf }, locale)
					: stale(alertHealth)
						? liveStampAge(alertHealth?.ageSeconds ?? null, locale, 'behind')
						: undefined}
			>
				{@render readingValue(alerts)}
			</FactRow>
		</FactList>
		{#if lines.length}
			<h3 class="mt-4 font-semibold">{t.lateLines}</h3>
			{#snippet late(row: RecordTableRow & { late: string })}{row.late}{/snippet}
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
			/>
		{/if}
	{/if}
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
