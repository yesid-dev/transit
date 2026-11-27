<script lang="ts">
	import { RoutePlate, SectionHeading } from '@yesid/ui/brand';
	import { recordPeriodNoticeReader } from '#lib/site/recordPeriodNoticeContext.ts';

	let {
		title,
		id,
		subtitle,
		hideSubtitle = false,
		plate,
		stopCode,
		back,
		compact = false,
		dot = true,
	}: {
		title: string;
		/** On the kit heading's wrapper, which holds the title alone. */
		id?: string;
		subtitle?: string;
		hideSubtitle?: boolean;
		plate?: string;
		stopCode?: string;
		/** The parent listing, shown as a breadcrumb before the plate on the title row. */
		back?: { href: string; label: string };
		compact?: boolean;
		/** The brand dot after the title. A line, stop, vehicle or departure has none. */
		dot?: boolean;
	} = $props();
	const readNotice = recordPeriodNoticeReader();
	const notice = $derived(readNotice());
</script>

<!--
	On a row of 44rem (704 px at the default text size) one line holds the breadcrumb, the plate or
	stop code, the title and its subtitle, so a screen's answer starts one line higher. Narrower, the
	plate sits beside the title and the back link at the right, as before; on a phone the breadcrumb
	shares the plate's row above the title. The row reads its width in rem, so it follows the reader's
	text size.
-->
<header class="screen-title" class:compact-title={compact} data-slot="screen-title">
	<div
		class="title-row"
		class:has-back={Boolean(back)}
		class:has-code={Boolean(plate || stopCode)}
		data-slot="screen-title-row"
	>
		<!-- Spaces between the parts keep the row's text readable as one line: "All lines / 51 Line 51". -->
		{#if back}<a class="record-link crumb" href={back.href} data-slot="screen-crumb">{back.label}</a
			>
			<span class="crumb-sep" aria-hidden="true">/</span>{/if}
		{#if stopCode}<span class="stop-code" aria-hidden="true">{stopCode}</span>{/if}
		{#if plate}<span class="route-code" aria-hidden="true"
				><RoutePlate code={plate} size="lg" /></span
			>{/if}
		<hgroup class="screen-heading-group" class:detail-heading={plate || stopCode}>
			<!-- flush: the kit's title sits on Transit's subtitle; the kit wraps long title words itself. -->
			<SectionHeading
				{id}
				class={compact ? 'screen-heading compact' : 'screen-heading'}
				heading={title}
				level={1}
				size="title"
				flush
				{dot}
			/>
			{#if subtitle}<p class="screen-subtitle text-muted-foreground" class:invisible={hideSubtitle}>
					{subtitle}
				</p>{/if}
		</hgroup>
		{#if notice}<p class="screen-notice" data-slot="record-start-notice">{notice}</p>{/if}
	</div>
</header>

<style>
	.screen-title {
		container-type: inline-size;
		min-inline-size: 0;
	}
	.title-row {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.25rem 0.75rem;
		min-inline-size: 0;
	}
	/* The kit reads the title size from this property, inherited from the header. */
	.compact-title {
		--section-heading-title-size: clamp(1.25rem, 8vi, var(--text-title));
	}
	.screen-heading-group {
		flex: 1 1 0;
		min-inline-size: min(100%, 12rem);
		margin: 0;
	}
	.screen-notice {
		flex-basis: 100%;
		margin: 0;
	}
	.stop-code {
		padding: 0.2em 0.45em;
		border: 1px solid var(--foreground);
		border-radius: var(--radius-sm);
		color: var(--foreground);
		font: 700 var(--text-heading)/1.25 var(--font-mono);
		font-variant-numeric: tabular-nums;
	}
	.route-code,
	.stop-code,
	.crumb,
	.crumb-sep {
		flex: none;
	}
	.crumb-sep {
		color: var(--muted-foreground);
	}
	/* A 44 px target that reaches into the space above the row, never into the title below it, so
	   the row stays as tall as the plate or the title beside it. */
	.crumb {
		margin-block-start: -0.5rem;
	}
	.record-link {
		display: inline-flex;
		align-items: center;
		min-block-size: 44px;
		color: var(--primary);
		text-decoration: underline;
	}
	/* Between a phone and a 44rem row: the plate beside the title, the back link at the right. */
	@media (width > 35em) {
		@container (max-width: 43.99rem) {
			.title-row:is(.has-back, .has-code) {
				display: grid;
				grid-template-areas: 'code main crumb';
				grid-template-columns: auto minmax(0, 1fr) fit-content(25%);
				align-items: start;
				column-gap: 0.75rem;
			}
			.title-row.has-code:not(.has-back) {
				grid-template-areas: 'code main';
				grid-template-columns: auto minmax(0, 1fr);
			}
			.title-row.has-back:not(.has-code) {
				grid-template-areas: 'main crumb';
				grid-template-columns: minmax(0, 1fr) fit-content(25%);
			}
			.title-row:is(.has-back, .has-code) > .screen-heading-group {
				grid-area: main;
			}
			/* The notice takes a row of its own only when there is one. */
			.title-row:is(.has-back, .has-code) > .screen-notice {
				grid-column: 1 / -1;
			}
			.crumb {
				grid-area: crumb;
				justify-self: end;
				margin-block: 0;
			}
			.crumb-sep {
				display: none;
			}
			.route-code,
			.stop-code {
				grid-area: code;
			}
			.route-code {
				margin-block-start: 0.25em;
			}
		}
	}
	@container (min-width: 44rem) {
		/* The subtitle follows the title on its row, and wraps under it when the title is long. */
		.screen-heading-group {
			display: flex;
			flex-wrap: wrap;
			align-items: baseline;
			gap: 0.25rem 1rem;
		}
		.screen-heading-group > p {
			margin: 0;
		}
	}
	@media (max-width: 35em) {
		/* The breadcrumb and the plate share one row above the title. */
		.detail-heading {
			flex-basis: 100%;
		}
		.screen-title:not(.compact-title) .detail-heading {
			--section-heading-title-size: var(--text-heading);
		}
	}
</style>
