<script lang="ts" generics="Key extends string">
	import { ChevronToggle } from '@yesid/ui/brand';
	import { Button } from '@yesid/ui/button';
	import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@yesid/ui/collapsible';

	let {
		label,
		options,
		value,
		onSelect,
	}: {
		label: string;
		options: readonly { key: Key; label: string }[];
		value: Key;
		onSelect: (key: Key) => void;
	} = $props();
	let open = $state(false);
	let trigger = $state<HTMLButtonElement | null>(null);
	const selected = $derived(options.find((option) => option.key === value)?.label);

	function close() {
		open = false;
		trigger?.focus();
	}
</script>

<Collapsible bind:open class="grid w-full min-w-0 gap-1">
	<p aria-hidden="true">{label}</p>
	<CollapsibleTrigger bind:ref={trigger}>
		{#snippet child({ props })}
			<Button {...props} class="min-h-11 w-full justify-between" variant="outline" wrap>
				<span><span class="sr-only">{label} </span>{selected}</span>
				<ChevronToggle {open} size="sm" direction="down" />
			</Button>
		{/snippet}
	</CollapsibleTrigger>
	<CollapsibleContent>
		<ul class="grid gap-1" aria-label={label}>
			{#each options as option (option.key)}
				<li>
					<Button
						class="min-h-11 w-full justify-start text-start"
						variant={option.key === value ? 'default' : 'outline'}
						aria-pressed={option.key === value}
						wrap
						onkeydown={(event: KeyboardEvent) => {
							if (event.key === 'Escape') close();
						}}
						onclick={() => {
							close();
							onSelect(option.key);
						}}>{option.label}</Button
					>
				</li>
			{/each}
		</ul>
	</CollapsibleContent>
</Collapsible>
