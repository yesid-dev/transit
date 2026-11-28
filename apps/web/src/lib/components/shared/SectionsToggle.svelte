<script lang="ts">
	import { SectionsToggle as UiSectionsToggle } from '@yesid/ui/brand';
	import { getLocale } from '#lib/i18n/index.ts';
	import { sectionsToggleCopy } from './sectionsToggle.copy';

	let { class: className = '' }: { class?: string } = $props();
</script>

<!-- An action label reads in the body font; monospace stays for codes, numbers and dates. -->
<UiSectionsToggle
	copy={sectionsToggleCopy[getLocale()]}
	class={[
		'[&_.sections-toggle]:[font-family:var(--font-body)]! [&_.sections-toggle]:tracking-normal!',
		className,
	]
		.filter(Boolean)
		.join(' ')}
/>
