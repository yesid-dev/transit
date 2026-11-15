<script lang="ts">
	import { tick } from 'svelte';
	import { Button } from '@yesid/ui/button';

	interface CopyActionProps {
		text: string;
		label: string;
		done: string;
		fallback: string;
		fallbackLabel: string;
	}
	let { text, label, done, fallback, fallbackLabel }: CopyActionProps = $props();
	const id = $props.id();
	let status = $state<'idle' | 'copied' | 'fallback'>('idle');
	let area = $state<HTMLTextAreaElement>();

	async function copy(): Promise<void> {
		try {
			await navigator.clipboard.writeText(text);
			status = 'copied';
		} catch {
			status = 'fallback';
			await tick();
			area?.focus();
			area?.select();
		}
	}
</script>

<div class="copy-action" data-slot="copy-action">
	<Button variant="outline" size="sm" class="min-h-11" onclick={copy}>{label}</Button>
	<p role="status" aria-live="polite" aria-atomic="true">
		{status === 'copied' ? done : status === 'fallback' ? fallback : ''}
	</p>
	{#if status === 'fallback'}
		<label for={id}>{fallbackLabel}</label>
		<textarea {id} bind:this={area} readonly value={text} rows="5"></textarea>
	{/if}
</div>

<style>
	.copy-action {
		display: grid;
		justify-items: start;
		gap: 0.375rem;
		min-width: 0;
	}
	p {
		margin: 0;
		font-size: var(--text-caption);
	}
	p:empty {
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
