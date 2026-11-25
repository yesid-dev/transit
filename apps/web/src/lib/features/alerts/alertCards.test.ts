import { expect, it } from 'vitest';
import { agencyText, alertAgencyLink, genericAgencyHeading, type AlertCard } from './alertCards';

const card: AlertCard = {
	key: 'fixture',
	id: 'fixture',
	routes: ['24'],
	stops: [],
	header: { fr: 'Votre arrêt' },
	description: {
		fr: '<p><strong>Votre arrêt</strong></p><p>Suivez la <a href="https://example.com/avis">signalisation</a>.<br>Prévoyez plus de temps.</p>',
	},
	effect: 'STOP_MOVED',
	periods: [],
};

it('keeps agency section breaks and labels the source language on a fallback', () => {
	expect(agencyText(card.description, 'en')).toEqual({
		text: 'Votre arrêt\nSuivez la signalisation.\nPrévoyez plus de temps.',
		lang: 'fr',
	});
	expect(genericAgencyHeading(agencyText(card.header, 'en')?.text)).toBe(true);
	expect(agencyText({ ...card.description, en: 'Use the marked stop.' }, 'en')).toEqual({
		text: 'Use the marked stop.',
		lang: 'en',
	});
});

it('retains the agency link embedded in the selected message', () => {
	expect(alertAgencyLink(card, 'en')).toEqual({
		href: 'https://example.com/avis',
		lang: 'fr',
	});
});
