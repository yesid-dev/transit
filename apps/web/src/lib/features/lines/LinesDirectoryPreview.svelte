<script lang="ts">
	import type { Locale } from '#lib/i18n/index.ts';
	import { intl } from '#lib/i18n/index.ts';
	import { page } from '$app/state';
	import type { RouteIndexEntry } from '#lib/v1/index.ts';
	import { fmtLocalePct } from '#lib/utils/format.ts';
	import { formatDateKey } from '#lib/utils/time.ts';
	import { routeModeHint } from '#lib/search/stopMode.ts';
	import type { DirectoryEvidence } from './directoryState';
	import { hasDirectoryFigure } from './directoryState';
	import { formatRecordDates } from './reliability/recordDates';
	import { reliabilityCopy } from './reliability/reliability.copy';
	import RecordCopyButton from './reliability/sections/RecordCopyButton.svelte';
	import { indexCopy } from './lines.copy';

	interface LinesDirectoryPreviewProps {
		readonly line: RouteIndexEntry;
		readonly evidence: DirectoryEvidence;
		readonly locale: Locale;
		readonly providerName: string;
		/** The line's Record, provider and the evidence's exact complete days. */
		readonly recordHref: string;
		readonly scheduleHref: string;
		readonly mapHref: string;
		/** The selected record's own CSV, only when a real figure and period exist. */
		readonly recordCsv: { readonly href: string; readonly filename: string } | null;
		readonly headingId: string;
		/** Whether this selection's read is actually in flight, so the preview never claims more. */
		readonly checking: boolean;
		readonly showBack: boolean;
		readonly onBack: () => void;
	}

	let {
		line,
		evidence,
		locale,
		providerName,
		recordHref,
		scheduleHref,
		mapHref,
		recordCsv,
		headingId,
		checking,
		showBack,
		onBack,
	}: LinesDirectoryPreviewProps = $props();

	const t = $derived(indexCopy[locale]);
	const share = $derived(reliabilityCopy[locale].record);
	const shareHref = $derived(new URL(recordHref, page.url.origin).href);
	const numberFmt = $derived(intl.number(locale));
	const mode = $derived(routeModeHint(line.type));

	const figure = $derived(
		evidence.percent == null ? null : fmtLocalePct(evidence.percent, locale, { rounding: 'round' }),
	);
	const supported = $derived(hasDirectoryFigure(evidence));
	const dates = $derived(
		evidence.from && evidence.to ? formatRecordDates(evidence.from, evidence.to, locale) : null,
	);
	const periodText = $derived(
		dates && evidence.days != null
			? t.period(dates, t.completeDays(numberFmt.format(evidence.days)))
			: dates,
	);
	const readingsText = $derived(
		evidence.readings == null ? null : t.basis(numberFmt.format(evidence.readings)),
	);
	const publishedText = $derived(
		/^\d{4}-\d{2}-\d{2}/u.test(evidence.publication.generatedUtc ?? '')
			? formatDateKey(evidence.publication.generatedUtc!.slice(0, 10), locale, true)
			: null,
	);

	/**
	 * The published citation, built from the same parts the Record view uses. A row without a
	 * real figure or complete days has nothing to cite, so it gets no Cite action at all.
	 */
	const citation = $derived.by(() => {
		// Only a supported figure with its own closed days can be cited; a low-sample record cannot.
		if (!figure || !hasDirectoryFigure(evidence)) return null;
		const citationDates = formatRecordDates(evidence.from!, evidence.to!, locale, { year: true });
		if (!citationDates) return null;
		return share.citation({
			host: page.url.host,
			line: line.short,
			provider: providerName,
			figure,
			dates: citationDates,
			readings: evidence.readings == null ? null : numberFmt.format(evidence.readings),
			published: /^\d{4}-\d{2}-\d{2}/u.test(evidence.publication.generatedUtc ?? '')
				? formatDateKey(evidence.publication.generatedUtc!.slice(0, 10), locale, true)
				: null,
			generation: evidence.publication.generationId,
			method: evidence.publication.methodVersion,
			href: shareHref,
		});
	});

	const excludedText = $derived(evidence.excluded == null ? null : t.unranked[evidence.excluded]);
	const stateText = $derived.by(() => {
		switch (evidence.state) {
			case 'loading':
				return checking ? t.loading : '';
			case 'failed':
				return t.failed;
			case 'not-published':
				return t.notPublished;
			case 'no-live':
				return t.noLive;
			case 'low-sample':
				return t.lowSample;
			case 'unranked':
				return excludedText;
			case 'uncertain':
				return evidence.hedge ?? t.uncertain;
			default:
				return null;
		}
	});
</script>

<section class="directory-preview" data-slot="directory-preview" aria-labelledby={headingId}>
	<header class="preview-head">
		<p class="preview-kicker">{t.previewHeading}</p>
		<h2 id={headingId} tabindex="-1" class="preview-heading">
			{t.lineHeading(line.short)}
		</h2>
		{#if line.long}<p class="preview-name">{t.routeName(line.long)}</p>{/if}
		<p class="preview-provider">
			<span>{providerName}</span>
			{#if mode.tag}<span class="preview-mode">{mode.tag}</span>{/if}
		</p>
	</header>

	<div class="preview-answer">
		{#if figure && supported}
			<p class="preview-figure" data-slot="directory-preview-figure" data-status={evidence.state}>
				{t.measure(figure)}
			</p>
		{:else if stateText}
			<p class="preview-figure preview-figure--absent" data-slot="directory-preview-figure">
				{stateText}
			</p>
		{/if}
		{#if figure && evidence.state === 'uncertain' && evidence.hedge}
			<p class="preview-hedge">{evidence.hedge}</p>
		{/if}
		{#if periodText}
			<p class="preview-dates">
				{periodText}
				{#if evidence.older}<span class="preview-older">{t.older}</span>{/if}
			</p>
		{/if}
		{#if readingsText}<p class="preview-basis">{readingsText}</p>{/if}
		{#if evidence.state === 'failed'}
			<p class="preview-recovery">{t.failed}</p>
		{/if}
	</div>

	{#if publishedText || evidence.publication.generationId || evidence.publication.methodVersion}
		<dl class="preview-publication">
			{#if publishedText}
				<dt>{t.publishedLabel}</dt>
				<dd>{publishedText}</dd>
			{/if}
			{#if evidence.publication.generationId}
				<dt>{t.generationLabel}</dt>
				<dd>{evidence.publication.generationId}</dd>
			{/if}
			{#if evidence.publication.methodVersion}
				<dt>{t.methodLabel}</dt>
				<dd>{evidence.publication.methodVersion}</dd>
			{/if}
		</dl>
	{/if}

	<div class="preview-actions">
		<a class="preview-link" href={recordHref}>{t.openRecord}</a>
		<a class="preview-link" href={scheduleHref}>{t.schedule}</a>
		<a class="preview-link" href={mapHref}>{t.map}</a>
		{#if recordCsv}
			<a
				class="preview-link"
				data-slot="directory-record-csv"
				download={recordCsv.filename}
				href={recordCsv.href}
			>
				{t.downloadSelected}
			</a>
		{/if}
	</div>

	<div class="preview-copy">
		<RecordCopyButton
			label={t.copyRecord}
			done={t.copyRecordDone}
			fallbackLabel={t.copyFallback}
			text={shareHref}
		/>
		{#if citation}
			<RecordCopyButton
				label={t.cite}
				done={t.citeDone}
				fallbackLabel={t.citeFallback}
				text={citation}
			/>
		{/if}
	</div>

	{#if showBack}
		<button type="button" class="preview-back tap-press" onclick={onBack}>{t.backToResults}</button>
	{/if}
</section>

<style>
	.directory-preview {
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
	.preview-kicker {
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
	.preview-name,
	.preview-provider,
	.preview-dates,
	.preview-basis,
	.preview-hedge,
	.preview-recovery {
		margin: 0;
		font-size: var(--text-small);
		line-height: 1.45;
		color: var(--muted-foreground);
		overflow-wrap: break-word;
	}
	.preview-name {
		color: var(--foreground);
		font-size: var(--text-body);
		overflow-wrap: anywhere;
	}
	.preview-provider {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: baseline;
	}
	.preview-mode {
		font-family: var(--font-mono);
		font-size: var(--text-micro);
		text-transform: uppercase;
		letter-spacing: var(--tracking-eyebrow);
		color: var(--accent-text);
	}
	.preview-answer {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		min-width: 0;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border-subtle);
	}
	.preview-figure {
		margin: 0;
		font-size: var(--text-body);
		font-weight: 600;
		line-height: 1.35;
		color: var(--foreground);
		font-variant-numeric: tabular-nums;
		overflow-wrap: break-word;
	}
	.preview-figure--absent {
		color: var(--muted-foreground);
		font-weight: 500;
	}
	.preview-older {
		margin-left: 0.375rem;
		padding: 0.0625rem 0.375rem;
		border: 1px solid var(--border-subtle);
		border-radius: var(--radius-sm);
		font-family: var(--font-mono);
		font-size: var(--text-micro);
		text-transform: uppercase;
		letter-spacing: var(--tracking-eyebrow);
	}
	.preview-publication {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: 0.25rem 0.75rem;
		margin: 0;
		font-size: var(--text-caption);
		color: var(--muted-foreground);
	}
	.preview-publication dt,
	.preview-publication dd {
		margin: 0;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.preview-publication dt {
		font-family: var(--font-mono);
		font-size: var(--text-micro);
		text-transform: uppercase;
		letter-spacing: var(--tracking-eyebrow);
	}
	.preview-publication dd {
		font-variant-numeric: tabular-nums;
		color: var(--foreground);
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
		.directory-preview {
			position: sticky;
			top: calc(var(--chrome-offset, 0px) + 0.5rem);
		}
	}
</style>
