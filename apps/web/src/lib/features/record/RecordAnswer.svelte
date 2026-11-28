<script lang="ts">
	import { AnswerLead, Stamp } from '@yesid/ui/brand';
	import type { StampProps } from '@yesid/ui/brand';
	import type { Snippet } from 'svelte';
	import type { Locale } from '#lib/i18n/index.ts';
	import { countedLabel } from '#lib/site/presenter.ts';
	import { lastGoodNote } from './recordText.ts';
	import StateMark from './StateMark.svelte';
	import type { RecordState } from './recordStates';

	let {
		heading,
		listing = false,
		value,
		sentence,
		state,
		statement,
		locale,
		time,
		comparison,
		actions,
		meta,
		evidence,
		fullWidthContext = false,
		size = 'lg',
	}: {
		heading?: Snippet;
		listing?: boolean;
		value: string | null;
		sentence: string;
		state?: RecordState;
		statement?: Snippet;
		locale: Locale;
		time?: StampProps;
		comparison?: string;
		actions?: Snippet;
		meta?: Snippet;
		evidence?: { sample: string; lastGood?: boolean };
		fullWidthContext?: boolean;
		size?: 'md' | 'lg';
	} = $props();
	const context = $derived(Boolean(time || comparison || evidence || meta));
	const secondRow = $derived(Boolean(comparison || evidence || meta));
	// On a wide answer the stamp moves beside the figure when actions share that row, or when the
	// stamp is all the context there is.
	const aside = $derived(Boolean(time) && (Boolean(actions) || !secondRow));
</script>

{#snippet absent()}{#if state}<StateMark {state} {locale} hiddenLabel />{/if}{/snippet}
<!--
	Two rows where the kit's answer stacks five. On a desktop: the figure and its sentence, with the
	stamp and the actions at the right; then the comparison and what was counted on one line.
	Narrower: the stamp, the comparison and what was counted share one wrapping line. The kit's
	AnswerLead keeps the statement; the reading order stays statement, stamp, context, actions.
-->
<div class="record-answer" class:listing-answer={listing} data-slot="record-answer">
	<div
		class="answer-grid"
		class:with-heading={Boolean(heading)}
		class:has-actions={Boolean(actions)}
		class:has-statement={Boolean(statement)}
		class:aside
		class:one-row={!secondRow}
		class:bare={!context}
		class:short-context={!comparison && !fullWidthContext && value !== null}
	>
		{#if heading}<div class="answer-heading" data-record-heading-row>{@render heading()}</div>{/if}
		<div class="answer-statement">
			{#if statement}{@render statement()}{:else}<AnswerLead
					{value}
					{sentence}
					absent={state ? absent : undefined}
					{size}
				/>{/if}
		</div>
		{#if context}
			<div class="answer-context" data-slot="answer-context">
				{#if time}<span class="answer-stamp"><Stamp {...time} /></span>{/if}
				{#if secondRow}
					<div class="answer-details">
						{#if comparison}<p class="answer-comparison" data-slot="answer-comparison">
								{comparison}
							</p>{/if}
						{#if evidence || meta}
							<div class="answer-evidence" data-slot="answer-evidence">
								{#if evidence?.sample}<p>
										{`${countedLabel(locale)} ${evidence.sample}`}
									</p>{/if}
								{#if evidence?.lastGood}<p>{lastGoodNote[locale]}</p>{/if}
								{@render meta?.()}
							</div>
						{/if}
					</div>
				{/if}
			</div>
		{/if}
		{#if actions}<div class="answer-actions">{@render actions()}</div>{/if}
	</div>
</div>

<style>
	.record-answer {
		container-type: inline-size;
		min-inline-size: 0;
	}
	/* Narrow: the statement, the context line and the actions, stacked in reading order. */
	.answer-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		gap: 0.75rem 1.5rem;
		min-inline-size: 0;
	}
	.answer-heading,
	.answer-statement {
		min-inline-size: 0;
	}
	.answer-context {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.375rem 1rem;
		min-inline-size: 0;
		overflow-wrap: anywhere;
	}
	.answer-context p {
		margin: 0;
	}
	/* Part of the context's wrapping line, until a wide answer gives it a row of its own. */
	.answer-details {
		display: contents;
	}
	.answer-evidence {
		display: grid;
		gap: 0.25rem;
		min-inline-size: 0;
		font-size: var(--text-small);
		color: var(--muted-foreground);
	}
	.answer-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: start;
		gap: 0.5rem;
		min-inline-size: 0;
	}
	/* From a tablet's reading width the actions sit at the right of the stamp and what was counted.
	   A comparison line keeps the full width, with the actions under it; so does an answer with no
	   figure, which keeps the height its figure-sized placeholder reserved. */
	@media (width < 64rem) {
		@container (min-width: 36rem) {
			.has-actions:where(.short-context) {
				grid-template-areas: 'statement statement' 'context actions';
				grid-template-columns: minmax(0, 1fr) auto;
			}
			.with-heading.has-actions:where(.short-context) {
				grid-template-areas: 'heading heading' 'statement statement' 'context actions';
			}
			.with-heading.has-actions:where(.short-context) .answer-heading {
				grid-area: heading;
			}
			.has-actions:where(.short-context) .answer-statement {
				grid-area: statement;
			}
			.has-actions:where(.short-context) .answer-context {
				grid-area: context;
			}
			.has-actions:where(.short-context) .answer-actions {
				grid-area: actions;
				justify-content: end;
			}
		}
	}
	/* On a desktop they move up beside the figure, and the context line takes the full width. */
	@container (min-width: 52rem) {
		.has-actions {
			grid-template-areas: 'statement actions' 'context context';
			grid-template-columns: minmax(0, 1fr) auto;
		}
		.has-actions .answer-statement {
			grid-area: statement;
		}
		.has-actions .answer-context {
			grid-area: context;
		}
		.has-actions .answer-actions {
			grid-area: actions;
			justify-content: end;
		}
		/* A custom statement can have a link on its last line. Keep the next focus stop beside it. */
		.has-actions.has-statement .answer-actions {
			align-self: end;
		}
		.has-actions.bare {
			grid-template-areas: 'statement actions';
		}
		.with-heading.has-actions {
			grid-template-areas: 'heading heading' 'statement actions' 'context context';
		}
		.with-heading.has-actions.bare {
			grid-template-areas: 'heading heading' 'statement actions';
		}
		.with-heading.has-actions .answer-heading {
			grid-area: heading;
		}
	}
	/* On a wide desktop answer the stamp joins the actions at the right of the figure, and the
	   comparison and what was counted share the row under it. A Live answer with only a stamp is
	   one row. */
	@container (min-width: 64rem) {
		.aside {
			grid-template-areas: 'statement stamp actions' 'details details details';
			grid-template-columns: minmax(0, 1fr) auto auto;
		}
		.aside.one-row {
			grid-template-areas: 'statement stamp actions';
		}
		.aside.one-row:not(.has-actions) {
			grid-template-areas: 'statement stamp';
			grid-template-columns: minmax(0, 1fr) auto;
		}
		/* The title keeps the width it needs on one line. The stamp and the actions sit beside it when
		   they fit, and wrap under it at the right when they do not (a French line title beside four
		   French buttons), so the title is never squeezed into a narrow column. The figure and the
		   context line keep the full width under them. */
		.with-heading.aside {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 0.75rem 1rem;
		}
		.with-heading.aside .answer-heading {
			flex: 1 1 auto;
		}
		/* The stamp takes the free space and sits at its end, so the stamp and the actions pack at
		   the right on whichever line they land; actions alone on a line keep to the right too. */
		.with-heading.aside .answer-stamp {
			display: flex;
			flex: 1 0 auto;
			justify-content: flex-end;
		}
		.with-heading.aside .answer-actions {
			margin-inline-start: auto;
		}
		.with-heading.aside .answer-statement {
			flex: 1 1 100%;
			order: 1;
		}
		.with-heading.aside .answer-details {
			flex: 1 1 100%;
			order: 2;
		}
		.aside .answer-statement {
			grid-area: statement;
		}
		.aside .answer-context {
			display: contents;
		}
		.aside .answer-stamp {
			grid-area: stamp;
			align-self: center;
			white-space: nowrap;
		}
		.aside .answer-actions {
			grid-area: actions;
			align-self: center;
		}
		.aside .answer-details {
			grid-area: details;
			display: flex;
			flex-wrap: wrap;
			align-items: baseline;
			gap: 0.375rem 1rem;
			min-inline-size: 0;
		}
	}

	/* ListingScreen owns the title. Its reading spans the title, statement and evidence rows. */
	@container listing-screen (min-width: 64rem) {
		.listing-answer {
			display: grid;
			grid-column: 1 / -1;
			grid-row: 1 / -1;
			grid-template-columns: subgrid;
			grid-template-rows: subgrid;
			container-type: normal;
		}
		.listing-answer .answer-grid,
		.listing-answer .answer-context {
			display: contents;
		}
		.listing-answer .answer-statement {
			grid-column: 1 / -1;
			grid-row: 2;
		}
		.listing-answer .answer-stamp {
			grid-column: 2;
			grid-row: 1;
			align-self: center;
			white-space: nowrap;
		}
		.listing-answer .answer-actions {
			grid-column: 3;
			grid-row: 1;
			align-self: center;
			justify-content: end;
		}
		.listing-answer .answer-details {
			display: flex;
			grid-column: 1 / -1;
			grid-row: 3;
			flex-wrap: wrap;
			align-items: baseline;
			gap: 0.375rem 1rem;
			min-inline-size: 0;
		}
	}
</style>
