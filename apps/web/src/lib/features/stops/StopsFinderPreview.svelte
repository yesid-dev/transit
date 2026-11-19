<script lang="ts">
	import { page } from '$app/state';
	import type { Locale } from '#lib/i18n/index.ts';
	import { transitTerms } from '#lib/i18n/transitTerms.copy.ts';
	import { stopDisplayName } from '#lib/site/transitDisplay.ts';
	import type { StopIndexEntry } from '#lib/v1/schemas/stops_index.ts';
	import RecordCopyButton from '#lib/features/lines/reliability/sections/RecordCopyButton.svelte';
	import type { StopRecordView } from './stopRecord';
	import { detailCopy, indexCopy } from './stops.copy';

	interface StopsFinderPreviewProps {
		readonly stop: StopIndexEntry;
		/** The stop page's own record answer, so the preview never says more than the record. */
		readonly record: StopRecordView;
		readonly locale: Locale;
		readonly providerName: string;
		/** The row's identity line: sign code, mode, lines served. */
		readonly meta: string;
		/** The stop's Record, with the reader's provider and the week the preview shows. */
		readonly recordHref: string;
		/** The map, filtered to this stop, with the reader's provider. */
		readonly mapHref: string;
		readonly headingId: string;
		readonly showBack: boolean;
		readonly onBack: () => void;
	}

	let {
		stop,
		record,
		locale,
		providerName,
		meta,
		recordHref,
		mapHref,
		headingId,
		showBack,
		onBack,
	}: StopsFinderPreviewProps = $props();

	const t = $derived(indexCopy[locale]);
	const r = $derived(detailCopy[locale].record);
	const actions = $derived(transitTerms[locale].action);
	const shareHref = $derived(new URL(recordHref, page.url.origin).href);
	const readings = $derived(record.share ? record.evidence[0]?.value : null);
	const csvHref = $derived(
		record.csv ? `data:text/csv;charset=utf-8,${encodeURIComponent(record.csv.text)}` : null,
	);
</script>

<section class="stops-preview" data-slot="stops-preview" aria-labelledby={headingId}>
	<header class="preview-head">
		<p class="preview-kicker">{t.previewHeading}</p>
		<h2 id={headingId} tabindex="-1" class="preview-heading">{stopDisplayName(stop.name)}</h2>
		<p class="preview-meta">
			<span>{providerName}</span>
			{#if meta}<span>{meta}</span>{/if}
		</p>
	</header>

	<div class="preview-answer" data-state={record.state}>
		<p class="preview-measure">{record.measure}</p>
		<p class="preview-period" data-slot="stops-preview-period">{record.period ?? ''}</p>
		{#if record.figure}
			<p class="preview-figure" data-slot="stops-preview-figure">
				<strong>{record.figure}</strong>{record.sentence}
			</p>
		{:else}
			<p class="preview-figure preview-figure--absent" data-slot="stops-preview-figure">
				{record.status}
			</p>
		{/if}
		{#if readings}<p class="preview-basis">{readings}</p>{/if}
		<p class="preview-note">{r.note}</p>
	</div>

	<div class="preview-actions">
		<a class="preview-link" href={recordHref}>{actions.openRecord}</a>
		<a class="preview-link" href={mapHref}>{actions.showOnMap}</a>
		{#if record.csv && csvHref}
			<a
				class="preview-link"
				data-slot="stops-preview-csv"
				download={record.csv.filename}
				href={csvHref}
			>
				{actions.downloadCsv}
			</a>
		{/if}
	</div>

	<div class="preview-copy">
		<RecordCopyButton
			label={actions.copyLink}
			done={r.linkCopied}
			fallbackLabel={t.copyFallback}
			text={shareHref}
		/>
		{#if record.citation}
			<RecordCopyButton
				label={actions.citeRecord}
				done={r.citationCopied}
				fallbackLabel={t.citeFallback}
				text={record.citation}
			/>
		{/if}
	</div>

	{#if showBack}
		<button type="button" class="preview-back tap-press" onclick={onBack}>{t.backToResults}</button>
	{/if}
</section>

<style>
	.stops-preview {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-width: 0;
		padding: 1rem;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-md);
		background: var(--card);
	}
	.preview-head {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		min-width: 0;
	}
	.preview-kicker,
	.preview-measure {
		margin: 0;
		font-family: var(--font-mono);
		font-size: var(--text-micro);
		font-weight: 600;
		letter-spacing: var(--tracking-eyebrow);
		text-transform: uppercase;
		color: var(--muted-foreground);
	}
	.preview-heading {
		margin: 0;
		font-size: var(--text-heading);
		font-weight: 700;
		line-height: 1.2;
		color: var(--foreground);
		overflow-wrap: anywhere;
	}
	.preview-heading:focus-visible {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
	.preview-meta {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
		margin: 0;
		font-size: var(--text-small);
		line-height: 1.45;
		color: var(--muted-foreground);
		font-variant-numeric: tabular-nums;
		overflow-wrap: break-word;
	}
	.preview-answer {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		min-width: 0;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border-subtle);
	}
	.preview-period,
	.preview-basis,
	.preview-note {
		margin: 0;
		font-size: var(--text-small);
		line-height: 1.45;
		color: var(--muted-foreground);
		overflow-wrap: break-word;
	}
	.preview-period {
		/* The period's line is held while the weekly file loads. */
		min-height: 1.45em;
		font-variant-numeric: tabular-nums;
	}
	.preview-figure {
		margin: 0;
		min-height: 2.7em;
		font-size: var(--text-body);
		line-height: 1.35;
		color: var(--foreground);
		font-variant-numeric: tabular-nums;
		overflow-wrap: break-word;
	}
	.preview-figure strong {
		font-size: var(--text-subheading);
		font-weight: 700;
	}
	.preview-figure--absent {
		color: var(--muted-foreground);
	}
	.preview-actions,
	.preview-copy {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		min-width: 0;
	}
	.preview-link,
	.preview-back {
		display: inline-flex;
		min-height: var(--size-tap-min);
		align-items: center;
		padding: 0.5rem 0.875rem;
		border: 1px solid var(--border-brand);
		border-radius: var(--radius-pill);
		background: var(--surface-1);
		color: var(--foreground);
		font: inherit;
		font-size: var(--text-control);
		font-weight: 600;
		text-decoration: none;
	}
	.preview-link:hover,
	.preview-link:focus-visible,
	.preview-back:hover,
	.preview-back:focus-visible {
		border-color: var(--primary);
		color: var(--primary);
	}
	.preview-back {
		align-self: flex-start;
		cursor: pointer;
	}
	@media (min-width: 1024px) {
		.stops-preview {
			position: sticky;
			top: calc(var(--chrome-offset, 0px) + 0.5rem);
		}
	}
</style>
