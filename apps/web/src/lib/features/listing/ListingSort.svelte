<script lang="ts">
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import { SegmentedChoice } from '@yesid/ui/brand';
	import { Button } from '@yesid/ui/button';
	import type { Locale } from '#lib/i18n/index.ts';
	import type { RecordTableSort } from '../record/RecordDataTable.svelte';

	let {
		locale,
		sort,
	}: {
		locale: Locale;
		sort: RecordTableSort & { choices: NonNullable<RecordTableSort['choices']> };
	} = $props();

	const label = $derived(locale === 'fr' ? 'Trier par' : 'Sort by');
	const reverse = $derived(locale === 'fr' ? 'Inverser l’ordre' : 'Reverse the order');
</script>

<div class="listing-sort" data-slot="listing-sort">
	<div class="sort-row">
		<span class="sort-label" aria-hidden="true">{label}</span>
		<div class="sort-options">
			<SegmentedChoice
				{label}
				options={sort.choices.options}
				value={sort.key}
				onSelect={sort.choices.onSelect}
			/>
		</div>
		<select
			class="sort-select rounded-md border border-input bg-card px-2 text-foreground"
			aria-label={label}
			value={sort.key}
			onchange={(event) => sort.choices.onSelect(event.currentTarget.value)}
		>
			{#each sort.choices.options as option (option.key)}
				<option value={option.key}>{option.label}</option>
			{/each}
		</select>
		<Button
			type="button"
			variant="outline"
			class="size-11 shrink-0 p-0"
			aria-label={reverse}
			title={reverse}
			onclick={() => sort.onSort(sort.key)}
		>
			{#if sort.direction === 'asc'}<ArrowUp size={18} aria-hidden="true" />{:else}<ArrowDown
					size={18}
					aria-hidden="true"
				/>{/if}
		</Button>
	</div>
</div>

<style>
	.listing-sort {
		container-type: inline-size;
	}

	.sort-row {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-block-size: 54px;
	}

	.sort-options,
	.sort-label {
		display: none;
	}

	.sort-select {
		flex: 1;
		min-inline-size: 0;
		min-block-size: 44px;
		font-size: var(--text-small);
	}

	/* The full translated labels and direction button fit together at this card width. */
	@container (inline-size >= 34rem) {
		.sort-options {
			display: block;
			white-space: nowrap;
		}

		.sort-options :global([data-slot='segmented-choice']) {
			flex-wrap: nowrap;
		}

		.sort-options :global([role='radio']) {
			font-family: var(--font-body);
			white-space: nowrap;
			padding-inline: 0.375rem;
		}

		.sort-select {
			display: none;
		}
	}

	@container (inline-size >= 38rem) {
		.sort-label {
			display: block;
			white-space: nowrap;
		}
	}
</style>
