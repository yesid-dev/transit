<script lang="ts">
	import { AnswerLead } from '@yesid/ui/brand';

	let { value, sentence }: { value: string; sentence: string } = $props();
</script>

<div data-slot="screen-answer">
	<AnswerLead {value} {sentence} size="md" />
</div>
