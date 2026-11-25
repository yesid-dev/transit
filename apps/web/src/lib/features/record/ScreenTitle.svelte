<script lang="ts">
	import { RoutePlate } from '@yesid/ui/brand';

	let {
		title,
		id,
		subtitle,
		plate,
		stopCode,
		back,
		compact = false,
		rule = false,
	}: {
		title: string;
		id?: string;
		subtitle?: string;
		plate?: string;
		stopCode?: string;
		back?: { href: string; label: string };
		compact?: boolean;
		rule?: boolean;
	} = $props();
</script>

<header
	class="flex min-w-0 flex-wrap items-start justify-between gap-3"
	class:route-title={plate && back}
	class:rule
>
	<hgroup class="min-w-0" class:inline-plate={stopCode} class:route-heading={plate}>
		{#if stopCode}<span class="stop-code" aria-hidden="true">{stopCode}</span>{/if}
		{#if plate}<span class="route-code" aria-hidden="true"
				><RoutePlate code={plate} size="lg" /></span
			>{/if}
		<h1
			{id}
			class="flex flex-wrap items-center gap-2 wrap-break-word text-title font-bold"
			class:compact
		>
			{title}
		</h1>
		{#if subtitle}<p class="text-muted-foreground">{subtitle}</p>{/if}
	</hgroup>
	{#if back}<a class="record-link" href={back.href}>{back.label}</a>{/if}
</header>

<style>
	.rule {
		border-block-end: 1px solid var(--border);
		padding-block-end: var(--space-card-gap);
	}
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
	.route-heading {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		column-gap: calc(var(--space-card-gap) / 2);
	}
	.route-code {
		grid-row: span 2;
		align-self: start;
		margin-block-start: 0.25em;
	}
	.route-heading p {
		grid-column: 2;
	}
	@media (width > 35em) {
		.route-title {
			display: grid;
			/* Keep the back link beside the title when the frame changes reading width. */
			grid-template-columns: minmax(0, 1fr) fit-content(25%);
		}
	}
	@media (max-width: 35em) {
		.route-heading {
			grid-template-columns: minmax(0, 1fr);
		}
		.route-code {
			grid-row: auto;
			justify-self: start;
		}
		.route-heading p {
			grid-column: 1;
		}
		.route-heading h1:not(.compact) {
			font-size: var(--text-heading);
		}
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
