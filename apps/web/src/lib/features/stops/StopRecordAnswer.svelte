<script lang="ts">
	import { Button } from '@yesid/ui/button';
	import type { Locale } from '#lib/i18n/index.ts';
	import { transitTerms } from '#lib/i18n/transitTerms.copy.ts';
	import { fmtLocalePct } from '#lib/utils/format.ts';
	import type { StopRecordView } from './stopRecord';
	import { detailCopy } from './stops.copy';

	interface Props {
		view: StopRecordView;
		locale: Locale;
		/** The record's own address, copied by "Copy link" and closing the citation. */
		url: string;
	}

	let { view, locale, url }: Props = $props();

	const t = $derived(detailCopy[locale].record);
	const actions = $derived(transitTerms[locale].action);
	const uid = $props.id();
	const pending = $derived(view.state === 'pending');
	const measured = $derived(view.figure != null);
	// Holds the figure's room while there is no figure; never shown.
	const placeholderFigure = $derived(fmtLocalePct(88.8, locale, { noData: '' }));
	const csvHref = $derived(
		view.csv ? `data:text/csv;charset=utf-8,${encodeURIComponent(view.csv.text)}` : null,
	);

	let announcement = $state('');
	$effect(() => {
		void view.state;
		announcement = '';
	});

	async function copy(text: string, done: string): Promise<void> {
		try {
			if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
			await navigator.clipboard.writeText(text);
			announcement = done;
		} catch {
			announcement = t.copyUnavailable;
		}
	}
</script>

<div class="stop-record" data-slot="stop-record-answer" data-state={view.state}>
	<section class="stop-record__answer" aria-label={t.label} aria-busy={pending}>
		<p class="stop-record__measure">{view.measure}</p>
		<p class="stop-record__period" data-slot="stop-record-period">{view.period ?? ''}</p>
		<!-- Every state keeps the figure line's room: a state without a figure writes over a hidden copy. -->
		<div class="stop-record__body">
			<p
				class="stop-record__line"
				class:stop-record__line--held={!measured}
				aria-hidden={!measured}
			>
				<span class="stop-record__figure">{view.figure ?? placeholderFigure}</span>{view.sentence}
			</p>
			{#if !measured}
				<p
					class="stop-record__status"
					data-slot="stop-record-status"
					role="status"
					aria-live="polite"
				>
					{view.status}
				</p>
			{/if}
		</div>
		<p class="stop-record__note">{t.note}</p>
		<div class="stop-record__actions" role="group" aria-label={t.actions}>
			<Button
				variant="outline"
				size="cta-sm"
				class="stop-record__action"
				onclick={() => copy(url, t.linkCopied)}
			>
				{actions.copyLink}
			</Button>
			{#if view.csv && csvHref}
				<Button
					variant="outline"
					size="cta-sm"
					class="stop-record__action"
					href={csvHref}
					download={view.csv.filename}
				>
					{actions.downloadCsv}
				</Button>
			{:else if pending}
				<Button variant="outline" size="cta-sm" class="stop-record__action" disabled>
					{actions.downloadCsv}
				</Button>
			{/if}
			{#if view.citation}
				{@const citation = view.citation}
				<Button
					variant="outline"
					size="cta-sm"
					class="stop-record__action"
					onclick={() => copy(citation, t.citationCopied)}
				>
					{actions.citeRecord}
				</Button>
			{:else if pending}
				<Button variant="outline" size="cta-sm" class="stop-record__action" disabled>
					{actions.citeRecord}
				</Button>
			{/if}
		</div>
		<p class="stop-record__announcement" role="status" aria-live="polite">{announcement}</p>
	</section>

	<aside class="stop-record__evidence" aria-labelledby={`${uid}-evidence`}>
		<h2 class="stop-record__evidence-heading" id={`${uid}-evidence`}>{t.evidence}</h2>
		<dl class="stop-record__facts">
			{#each view.evidence as fact (fact.label)}
				<div>
					<dt>{fact.label}</dt>
					{#if fact.value != null}
						<dd>{fact.value}</dd>
					{:else}
						<dd class="stop-record__held" aria-hidden="true">{t.readingsUnpublished}</dd>
					{/if}
				</div>
			{/each}
		</dl>
		<p class="stop-record__caveat">{t.notOnTime}</p>
	</aside>
</div>

<style>
	.stop-record {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 1.25rem;
		min-width: 0;
	}
	.stop-record__answer {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		min-width: 0;
	}
	.stop-record__measure,
	.stop-record__period,
	.stop-record__line,
	.stop-record__note,
	.stop-record__status,
	.stop-record__announcement,
	.stop-record__caveat,
	.stop-record__evidence-heading {
		margin: 0;
	}
	.stop-record__measure {
		font-size: var(--text-small);
		font-weight: 600;
		color: var(--foreground);
	}
	.stop-record__period {
		/* One line of room for the period before it loads; two where it wraps. */
		min-block-size: 1.5em;
		font-size: var(--text-small);
		color: var(--muted-foreground);
	}
	.stop-record__line {
		max-width: 39ch;
		font-size: var(--text-body);
		line-height: 1.45;
		color: var(--foreground);
	}
	.stop-record__figure {
		display: block;
		margin-block-end: 0.25rem;
		font-size: clamp(2.5rem, 2rem + 2.5vw, 3.5rem);
		font-weight: 700;
		line-height: 1;
		letter-spacing: -0.02em;
		font-variant-numeric: tabular-nums;
	}
	.stop-record__note,
	.stop-record__caveat {
		max-width: 60ch;
		font-size: var(--text-small);
		line-height: 1.5;
		color: var(--muted-foreground);
	}
	.stop-record__body {
		position: relative;
		min-width: 0;
	}
	.stop-record__line--held {
		visibility: hidden;
	}
	.stop-record__status {
		position: absolute;
		inset-block-start: 0;
		inset-inline: 0;
		max-width: 48ch;
		padding-block: 0.5rem;
		font-size: var(--text-body);
		line-height: 1.45;
		color: var(--foreground);
	}
	.stop-record__held {
		visibility: hidden;
	}
	.stop-record__actions {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		margin-block-start: auto;
		padding-block-start: 0.5rem;
	}
	:global(.stop-record__action) {
		min-block-size: var(--size-tap-min, 44px);
	}
	.stop-record__announcement {
		min-block-size: 1.5em;
		font-size: var(--text-small);
		color: var(--muted-foreground);
	}
	.stop-record__evidence {
		display: flex;
		flex-direction: column;
		gap: 1rem;
		min-width: 0;
		padding: 1.25rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--card);
	}
	.stop-record__evidence-heading {
		font-size: var(--text-subheading, 1.125rem);
		font-weight: 600;
		line-height: 1.25;
	}
	.stop-record__facts {
		display: grid;
		gap: 0.75rem;
		margin: 0;
	}
	.stop-record__facts dt {
		font-size: var(--text-small);
		color: var(--muted-foreground);
	}
	.stop-record__facts dd {
		margin: 0;
		font-size: var(--text-body);
		line-height: 1.45;
	}

	@container (max-width: 22rem) {
		.stop-record__period {
			min-block-size: 3em;
		}
	}
	@container (min-width: 44rem) {
		.stop-record {
			grid-template-columns: minmax(0, 2fr) minmax(16rem, 1fr);
			align-items: start;
			gap: 2rem;
		}
	}
</style>
