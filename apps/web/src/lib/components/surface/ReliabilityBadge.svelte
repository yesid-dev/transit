<script lang="ts">
	import type { RouteReliabilityIndex } from '#lib/v1/schemas/route_reliability_index.ts';
	import { intl } from '#lib/i18n/index.ts';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { ReliabilitySnapshot } from '#lib/v1/reliabilitySnapshot.svelte.ts';
	import { reliabilityBadgeCopy } from '#lib/v1/verdict.copy.ts';
	import { formatDateKey } from '#lib/utils/time.ts';
	import { VERDICT_MIN_N } from '#lib/v1/verdict.ts';

	export interface ReliabilityBadgeProps {
		snapshot: ReliabilitySnapshot;
		locale: Locale;
		published?: NonNullable<RouteReliabilityIndex['weekly_routes']>[number];
		class?: string;
	}

	let { snapshot, locale, published, class: className }: ReliabilityBadgeProps = $props();

	const copy = $derived(reliabilityBadgeCopy[locale]);
	const windowLabel = $derived(
		(published?.window_end ?? snapshot.closedThrough)
			? copy.weekTo(formatDateKey((published?.window_end ?? snapshot.closedThrough)!, locale))
			: copy.week,
	);
	const shownPct = $derived(published ? published.pct : snapshot.otpPct);
	const pctText = $derived(
		shownPct == null
			? null
			: intl.number(locale, { style: 'unit', unit: 'percent' }).format(shownPct),
	);
	const unranked = $derived(published != null && published.state !== 'ranked');
	const show = $derived(
		unranked || ((published?.state === 'ranked' || snapshot.phase === 'ready') && pctText != null),
	);
	const hedged = $derived(
		unranked || (!published && (snapshot.verdict === 'absent' || snapshot.verdict === 'tentative')),
	);
	const lowSample = $derived(
		published?.state === 'too_few_units' ||
			(snapshot.observationCount != null && snapshot.observationCount < VERDICT_MIN_N),
	);
	const hedgeStatus = $derived(unranked ? (lowSample ? 'absent' : 'tentative') : snapshot.verdict);
	const label = $derived(
		pctText
			? `${pctText} ${snapshot.kind === 'stop' ? copy.stopShare : copy.share}, ${windowLabel}`
			: '',
	);
	const hedgeLabel = $derived(snapshot.hedge ?? `${copy.hedgeFallback}, ${windowLabel}`);
</script>

<span class="reliability-slot" data-phase={snapshot.phase}>
	{#if show && hedged}
		<span
			data-slot="reliability-hedge"
			data-status={hedgeStatus}
			class={['reliability-badge reliability-hedge', className].filter(Boolean).join(' ')}
			role="img"
			aria-label={hedgeLabel}
			title={hedgeLabel}
		>
			<span aria-hidden="true"
				>{copy.compactHedges[
					hedgeStatus === 'tentative' && !lowSample ? 'tentative' : 'absent'
				]}</span
			>
			<span aria-hidden="true">{windowLabel}</span>
		</span>
	{:else if show}
		<span
			class={['reliability-badge', className].filter(Boolean).join(' ')}
			data-slot="reliability-badge"
			data-status={snapshot.verdict}
			role="img"
			aria-label={label}
			title={label}
		>
			<span class="reliability-badge-pct" aria-hidden="true">{pctText}</span>
			<span aria-hidden="true">{windowLabel}</span>
		</span>
	{:else}
		<span
			class="reliability-badge reliability-placeholder"
			data-slot="reliability-placeholder"
			aria-hidden="true"><span>—</span><span>{copy.week}</span></span
		>
	{/if}
</span>

<style>
	.reliability-slot {
		display: block;
		max-inline-size: 100%;
	}
	.reliability-badge {
		display: flex;
		flex-direction: column;
		overflow-wrap: normal;
		word-break: normal;
		font-family: var(--font-mono);
		font-size: var(--text-caption);
		color: var(--foreground);
		font-variant-numeric: tabular-nums;
		white-space: normal;
	}
	.reliability-placeholder {
		visibility: hidden;
	}
	.reliability-badge-pct {
		font-weight: 600;
	}
</style>
