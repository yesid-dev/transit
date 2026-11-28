import { render } from '@testing-library/svelte';
import { expect, it } from 'vitest';
import MapFrameLegend from './MapFrameLegend.svelte';

it.each([
	['en', true, /Rail: schedule only/],
	['fr', true, /horaire seulement/],
	['en', false, null],
	['fr', false, null],
] as const)('%s legend with schedule-only lines %s', (locale, scheduleOnlyLines, rail) => {
	const { container } = render(MapFrameLegend, {
		props: { locale, layer: 'live', colourBy: 'status', staleCutoffS: 600, scheduleOnlyLines },
	});
	const text = container.textContent ?? '';
	if (rail) expect(text).toMatch(rail);
	else expect(text).not.toMatch(/Rail|horaire seulement/);
	expect(text).toMatch(locale === 'fr' ? /Sélection/ : /Selected/);
	expect(text).toContain(locale === 'fr' ? 'En avance (violet)' : 'Early (violet)');
});

it.each(['en', 'fr'] as const)(
	'%s Record legend says a capped view colours only the worst and keys only what it draws',
	(locale) => {
		const fr = locale === 'fr';
		const props = { locale, layer: 'clear-run', colourBy: 'status', staleCutoffS: 600 } as const;
		const capped = render(MapFrameLegend, { props: { ...props, capped: 300 } });
		const note = capped.container.querySelector('[data-record-cap-legend-note]');
		expect(note).toHaveTextContent(
			fr
				? 'Seuls les 300 pires sont en couleur à ce zoom. Zoomez pour les voir tous, bons et mauvais.'
				: 'Only the 300 worst are coloured at this zoom. Zoom in to see all of them, good and bad.',
		);
		expect(capped.container.textContent).not.toContain(
			fr ? 'Trop peu pour juger' : 'Too few to judge',
		);
		expect(capped.container.textContent).toContain(
			fr
				? 'Temps perdu entre deux arrêts, par rapport aux trajets les plus rapides'
				: 'Time lost between two stops, against the fastest trips',
		);
		capped.unmount();

		const all = render(MapFrameLegend, { props });
		expect(all.container.querySelector('[data-record-cap-legend-note]')).toBeNull();
		expect(all.container.textContent).toContain(fr ? 'Trop peu pour juger' : 'Too few to judge');
	},
);
