<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import { SectionLabel } from '@yesid/ui/brand';
	import { MetricDisplay } from '#lib/components/brand/index.ts';
	import { AbsentValue } from '#lib/components/edge/index.ts';
	import WorkflowIcon from '@lucide/svelte/icons/workflow';
	import type { EnvelopeView } from '../selectors/envelope';
	import type { HealthCopy } from '../health.copy';

	interface SectionEnvelopeProps {
		envelope: EnvelopeView;
		copy: HealthCopy;
		locale: Locale;
	}
	let { envelope, copy, locale }: SectionEnvelopeProps = $props();

	const t = $derived(copy.envelope);
</script>

<div class="health-block" data-slot="envelope-section">
	<p class="health-note">{t.note}</p>

	<article class="publish-run-card" data-slot="publish-run-card">
		<header class="publish-run-header">
			<SectionLabel text={t.generationIdLabel} variant="metric" />
			<span class="publish-run-badge" aria-hidden="true">
				<WorkflowIcon size={16} strokeWidth={1.75} />
			</span>
		</header>
		{#if envelope.generationId}
			<code class="publish-run-id" data-slot="publish-run-id">{envelope.generationId}</code>
		{:else}
			<AbsentValue reason="not-reported" {locale} variant="inline" />
		{/if}
		<p class="publish-run-explanation" data-slot="publish-run-explanation">
			{t.generationIdExplain}
		</p>
	</article>

	<div class="envelope-rows">
		<MetricDisplay
			value={envelope.schemaVersion}
			absentReason="not-reported"
			{locale}
			label={t.schemaVersionLabel}
			size="md"
		/>
		<MetricDisplay
			value={envelope.methodologyVersion}
			absentReason="not-reported"
			{locale}
			label={t.methodologyVersionLabel}
			size="md"
		/>
	</div>
</div>

<style>
	/* Technical evidence, so neutral ink: data colours such as crowding are kept for their data. */
	.publish-run-card {
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
		min-width: 0;
		padding: 1rem 1.125rem 1.125rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--card);
	}
	.publish-run-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
	}
	.publish-run-badge {
		display: inline-flex;
		padding: 0.375rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-pill);
		color: var(--muted-foreground);
	}
	.publish-run-id {
		display: block;
		width: 100%;
		min-width: 0;
		padding: 0.75rem 0.875rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-md);
		background: var(--terminal);
		color: var(--terminal-ink);
		font-family: var(--font-mono);
		font-size: var(--text-mono);
		line-height: 1.6;
		overflow-wrap: anywhere;
		word-break: break-word;
		white-space: normal;
	}
	.publish-run-explanation {
		margin: 0;
		color: var(--foreground);
		font-size: var(--text-detail-body-mobile);
		line-height: 1.8;
		text-wrap: pretty;
	}
	.envelope-rows {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1.25rem 2rem;
		max-width: 28rem;
	}
	@media (--desktop-min) {
		.publish-run-explanation {
			font-size: var(--text-detail-body-desktop);
			line-height: 1.9;
		}
		.envelope-rows {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
</style>
