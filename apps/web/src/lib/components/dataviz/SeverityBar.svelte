<script lang="ts">
	import { cn, type WithElementRef } from '#lib/utils/index.ts';
	import type { HTMLAttributes } from 'svelte/elements';
	import type { SeverityCode } from '#lib/v1/schemas/index.ts';
	import { severityVar } from './tokens';
	import ChartDetails from './chart/ChartDetails.svelte';
	import { chartDatumValue } from '#lib/site/presenter.ts';
	import type { Locale } from '#lib/i18n/index.ts';
	import { absenceShort } from '#lib/site/absence.ts';
	import { SEVERITY_LABELS } from '#lib/v1/enumLabels.ts';

	export interface SeverityBarProps extends WithElementRef<HTMLAttributes<HTMLDivElement>> {
		severity: SeverityCode;
		value: number | null;
		domain?: readonly [number, number];
		unit?: string;
		colorVar?: string;
		label?: string;
		size?: 'sm' | 'md';
		interactive?: boolean;
		locale?: Locale;
		class?: string;
	}

	let {
		severity,
		value,
		domain,
		unit,
		colorVar,
		label,
		size = 'md',
		interactive = false,
		locale = 'en',
		class: className,
		ref = $bindable(null),
		...restProps
	}: SeverityBarProps = $props();

	const hasData = $derived(value != null && !Number.isNaN(value));
	const pct = $derived.by(() => {
		if (value == null || Number.isNaN(value)) return 0;
		if (domain) {
			const [lo, hi] = domain;
			return Math.min(100, Math.max(0, ((value - lo) / (hi - lo)) * 100));
		}
		return Math.min(1, Math.max(0, value)) * 100;
	});
	const color = $derived(colorVar ?? severityVar(severity));
	const severityLabel = $derived(SEVERITY_LABELS[locale][severity]);
	const heightClass = { sm: 'h-1.5', md: 'h-2.5' } as const;

	const readings = $derived([
		{
			key: severity,
			heading: severityLabel,
			rows: [
				{
					label: label ?? severityLabel,
					value: !hasData
						? absenceShort('no-observations', locale)
						: chartDatumValue(domain ? value : pct, domain ? (unit ?? '') : '%', locale),
					colorVar: color,
				},
			],
		},
	]);
</script>

{#if interactive}
	<ChartDetails label={label ?? severityLabel} {readings}>
		<div
			bind:this={ref}
			class={cn(
				'dv-severity-track w-full overflow-hidden rounded-pill bg-muted',
				heightClass[size],
				className,
			)}
			role="progressbar"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={hasData ? Math.round(pct) : undefined}
			aria-label={label ? `${label}, ${severityLabel}` : severityLabel}
			data-slot="severity-bar"
			data-card-interactive
			data-severity={severity}
			{...restProps}
		>
			{#if hasData}
				<div
					class="dv-severity-fill h-full rounded-pill"
					style="width: {pct}%; background: {color};"
				></div>
			{/if}
		</div>
	</ChartDetails>
{:else}
	<div
		bind:this={ref}
		class={cn(
			'dv-severity-track w-full overflow-hidden rounded-pill bg-muted',
			heightClass[size],
			className,
		)}
		role="progressbar"
		aria-valuemin={0}
		aria-valuemax={100}
		aria-valuenow={hasData ? Math.round(pct) : undefined}
		aria-label={label ? `${label}, ${severityLabel}` : severityLabel}
		data-slot="severity-bar"
		data-card-interactive
		data-severity={severity}
		{...restProps}
	>
		{#if hasData}
			<div
				class="dv-severity-fill h-full rounded-pill"
				style="width: {pct}%; background: {color};"
			></div>
		{/if}
	</div>
{/if}

<style>
	.rounded-pill {
		border-radius: var(--radius-pill);
	}
	.dv-severity-fill {
		min-width: 2px;
		transition: width var(--duration-normal) var(--ease-out);
	}
	@media (prefers-reduced-motion: reduce) {
		.dv-severity-fill {
			transition: none;
		}
	}
</style>
