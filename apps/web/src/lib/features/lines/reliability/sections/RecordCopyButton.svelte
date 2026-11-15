<script lang="ts">
	import { tick } from 'svelte';
	import { Button } from '@yesid/ui/button';

	interface RecordCopyButtonProps {
		label: string;
		/** Announced once the clipboard holds `text`. */
		done: string;
		/** Labels the selectable text shown when the clipboard refuses. */
		fallbackLabel: string;
		text: string;
	}

	let { label, done, fallbackLabel, text }: RecordCopyButtonProps = $props();
	const id = $props.id();
	let copyState = $state<'idle' | 'copied' | 'fallback'>('idle');
	/** The text the clipboard took; a new period's text is not announced as copied. */
	let copied = $state<string | null>(null);
	let fallback = $state<HTMLTextAreaElement>();

	async function copy(): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			copied = text;
			copyState = 'copied';
		} catch {
			copyState = 'fallback';
			await tick();
			fallback?.focus();
			fallback?.select();
		}
	}
</script>

<div class="record-copy" data-slot="record-copy">
	<Button variant="outline" size="sm" class="min-h-11" onclick={copy}>{label}</Button>
	<p class="record-copy__status" role="status" aria-live="polite" aria-atomic="true">
		{copyState === 'copied' && copied === text ? done : ''}
	</p>
	{#if copyState === 'fallback'}
		<label class="record-copy__label" for={id}>{fallbackLabel}</label>
		<textarea {id} bind:this={fallback} readonly value={text} rows="4"></textarea>
	{/if}
</div>

<style>
	.record-copy {
		display: grid;
		justify-items: start;
		gap: 0.375rem;
		min-width: 0;
	}
	.record-copy__status,
	.record-copy__label {
		margin: 0;
		font-size: var(--text-caption);
		color: var(--muted-foreground);
	}
	.record-copy__status:empty {
		display: none;
	}
	textarea {
		width: 100%;
		min-width: 0;
		padding: 0.75rem;
		border: 1px solid var(--border);
		border-radius: var(--radius-sm);
		background: var(--background);
		color: var(--foreground);
		font: inherit;
		resize: vertical;
	}
</style>
