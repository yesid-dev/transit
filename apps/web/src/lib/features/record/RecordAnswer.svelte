<script lang="ts">
	import { AnswerLead, Stamp } from '@yesid/ui/brand';
	import type { StampProps } from '@yesid/ui/brand';
	import type { Snippet } from 'svelte';
	import type { Locale } from '#lib/i18n/index.ts';
	import { choose, lastGoodNote } from './recordText.ts';
	import StateMark from './StateMark.svelte';
	import type { RecordState } from './recordStates';

	let {
		value,
		sentence,
		state,
		locale,
		time,
		comparison,
		actions,
		meta,
		evidence,
		size = 'lg',
	}: {
		value: string | null;
		sentence: string;
		state?: RecordState;
		locale: Locale;
		time?: StampProps;
		comparison?: string;
		actions?: Snippet;
		meta?: Snippet;
		evidence?: { sample: string; lastGood?: boolean };
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
<div class="record-answer" data-slot="record-answer">
	<div
		class="answer-grid"
		class:has-actions={Boolean(actions)}
		class:aside
		class:one-row={!secondRow}
		class:bare={!context}
		class:short-context={!comparison && value !== null}
	>
		<div class="answer-statement">
			<AnswerLead {value} {sentence} absent={state ? absent : undefined} {size} />
		</div>
		{#if context}
			<div class="answer-context" data-slot="answer-context">
				{#if time}<span class="answer-stamp"><Stamp {...time} /></span>{/if}
				{#if secondRow}
					<div class="answer-details">
						{#if comparison}<p class="answer-comparison">{comparison}</p>{/if}
						{#if evidence || meta}
							<div class="answer-evidence" data-slot="answer-evidence">
								{#if evidence?.sample}<p>
										{`${choose(locale, 'Counted:', 'Ce qui est compté\u00a0:')} ${evidence.sample}`}
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
	@container (min-width: 36rem) {
		.has-actions.short-context {
			grid-template-areas: 'statement statement' 'context actions';
			grid-template-columns: minmax(0, 1fr) auto;
		}
		.has-actions.short-context .answer-statement {
			grid-area: statement;
		}
		.has-actions.short-context .answer-context {
			grid-area: context;
		}
		.has-actions.short-context .answer-actions {
			grid-area: actions;
			justify-content: end;
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
		.has-actions.bare {
			grid-template-areas: 'statement actions';
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
		.aside .answer-statement {
			grid-area: statement;
		}
		.aside .answer-context {
			display: contents;
		}
		.aside .answer-stamp {
			grid-area: stamp;
			align-self: center;
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
</style>
