<script lang="ts">
	import { RoutePlate } from '@yesid/ui/brand';

	let {
		title,
		subtitle,
		plate,
		stopCode,
		back,
		compact = false,
	}: {
		title: string;
		subtitle?: string;
		plate?: string;
		stopCode?: string;
		back?: { href: string; label: string };
		compact?: boolean;
	} = $props();
</script>

<header class="flex min-w-0 flex-wrap items-start justify-between gap-3">
	<hgroup class="min-w-0" class:inline-plate={stopCode}>
		{#if stopCode}<span class="stop-code" aria-hidden="true">{stopCode}</span>{/if}
		<h1
			class="flex flex-wrap items-center gap-2 wrap-break-word text-title font-bold"
			class:compact
		>
			{#if plate}<RoutePlate code={plate} size="lg" />{/if}
			{title}
		</h1>
		{#if subtitle}<p class="text-muted-foreground">{subtitle}</p>{/if}
	</hgroup>
	{#if back}<a class="record-link" href={back.href}>{back.label}</a>{/if}
</header>

<style>
	.stop-code {
		padding: 0.2em 0.45em;
		border: 1px solid var(--foreground);
		border-radius: var(--radius-sm);
		color: var(--foreground);
		font: 700 var(--text-heading)/1.25 var(--font-mono);
		font-variant-numeric: tabular-nums;
	}
	.inline-plate {
		display: grid;
		align-items: center;
		grid-template-columns: auto minmax(0, 1fr);
		column-gap: 0.75rem;
	}
	.inline-plate p {
		grid-column: 2;
	}
	@media (max-width: 35em) {
		.inline-plate {
			grid-template-columns: minmax(0, 1fr);
			justify-items: start;
		}
		.inline-plate p {
			grid-column: 1;
		}
	}
	.compact {
		font-size: clamp(1.25rem, 8vi, var(--text-title));
	}

	.record-link {
		display: inline-flex;
		align-items: center;
		min-block-size: 44px;
		color: var(--primary);
		text-decoration: underline;
	}
</style>
