import { render, within } from '@testing-library/svelte';
import { describe, expect, it } from 'vitest';
import LegalDocument, { addressParts } from './LegalDocument.svelte';
import { LEGAL_EFFECTIVE_DATES, legalCopy, legalDocument } from './legal.copy';

const cases = [
	{ locale: 'fr' as const, kind: 'privacy' as const, title: 'Politique de confidentialité' },
	{ locale: 'fr' as const, kind: 'terms' as const, title: 'Conditions d’utilisation' },
	{ locale: 'en' as const, kind: 'privacy' as const, title: 'Privacy Policy' },
	{ locale: 'en' as const, kind: 'terms' as const, title: 'Terms of Use' },
] as const;

describe('LegalDocument', () => {
	it('exports factual bilingual footer attribution', () => {
		expect(legalCopy.en.footerAttribution).toContain('NOTICE');
		expect(legalCopy.fr.footerAttribution).toContain('NOTICE');
		expect(legalCopy.en.footerAttribution).not.toContain('review');
		expect(legalCopy.fr.footerAttribution).not.toContain('révision');
	});

	it.each(cases)(
		'renders the complete static $locale $kind document',
		({ locale, kind, title }) => {
			const { getByTestId } = render(LegalDocument, { props: { locale, kind } });
			const page = getByTestId('legal-document');
			const copy = legalDocument(locale, kind);

			expect(within(page).getByRole('heading', { level: 1, name: title })).toBeInTheDocument();
			expect(within(page).getAllByRole('heading', { level: 2 })).toHaveLength(copy.sections.length);
			expect(within(page).getByText(copy.effectiveDate)).toHaveAttribute(
				'datetime',
				LEGAL_EFFECTIVE_DATES[kind],
			);
			expect(within(page).queryByRole('button')).not.toBeInTheDocument();
			// jest-dom turns no-break spaces into spaces, so read the raw text.
			expect(page.querySelector('[data-slot="reading-frame-updated"]')?.textContent).toContain(
				copy.effectiveLabel + (locale === 'fr' ? '\u00a0:' : ':'),
			);
		},
	);

	it.each(['en', 'fr'] as const)(
		'lets %s addresses wrap between their parts without changing the text',
		(locale) => {
			const { getByTestId } = render(LegalDocument, { props: { locale, kind: 'privacy' } });
			const page = getByTestId('legal-document');
			const copy = legalDocument(locale, 'privacy');
			const texts = [...page.querySelectorAll('section p, section li')].map(
				(element) => element.textContent,
			);
			for (const section of copy.sections)
				for (const text of [
					...section.paragraphs,
					...(section.bullets ?? []),
					...(section.links ?? []).map(({ label }) => label),
				])
					expect(texts).toContain(text);
			const contact = [...page.querySelectorAll('section p, section li')].filter((element) =>
				element.textContent?.includes('contact@yesid.dev'),
			);
			expect(contact.length).toBeGreaterThan(0);
			for (const text of contact)
				expect(text.innerHTML.replaceAll('<!---->', '')).toContain('contact@<wbr>yesid.<wbr>dev');
			expect(addressParts('static.cloudflareinsights.com, 2.5 km. Next')).toEqual([
				'static.',
				'cloudflareinsights.',
				'com, 2.5 km. Next',
			]);
		},
	);

	it('keeps the privacy and licensing claims concrete in both languages', () => {
		for (const locale of ['en', 'fr'] as const) {
			const privacy = JSON.stringify(legalDocument(locale, 'privacy'));
			const terms = JSON.stringify(legalDocument(locale, 'terms'));

			expect(privacy).toContain('Cloudflare');
			expect(privacy).toContain('Cloudflare Web Analytics');
			expect(privacy).toContain('static.cloudflareinsights.com');
			expect(privacy).toContain('Geo.ca');
			expect(privacy).toContain('contact@yesid.dev');
			expect(terms).toContain('MIT');
			expect(terms).toContain('NOTICE');
			expect(terms).toContain('ODbL');
			expect(terms).toContain(locale === 'fr' ? 'Ville d’Ottawa' : 'City of Ottawa');
			expect(`${privacy}${terms}`.toLowerCase()).not.toContain('placeholder');
		}
		expect(JSON.stringify(legalDocument('en', 'privacy'))).toMatch(
			/URL.*withdraw.*outside Quebec.*30 days/su,
		);
		expect(JSON.stringify(legalDocument('fr', 'privacy'))).toMatch(
			/URL.*retirer.*extérieur du Québec.*30 jours/su,
		);
		expect(JSON.stringify(legalDocument('en', 'privacy'))).toContain('When this policy is amended');
		expect(JSON.stringify(legalDocument('fr', 'privacy'))).toContain(
			'Lorsque la présente politique est modifiée',
		);
		const enPrivacy = JSON.stringify(legalDocument('en', 'privacy'));
		const frPrivacy = JSON.stringify(legalDocument('fr', 'privacy'));
		expect(enPrivacy).toContain('fingerprint of the address, made with a secret key');
		expect(enPrivacy).toContain('midnight UTC');
		expect(enPrivacy).toContain('one-minute counting window');
		expect(enPrivacy).toContain('Search, Map and Live pages');
		expect(enPrivacy).toContain('insert the script');
		expect(enPrivacy).toContain('Pause live updates choice in sessionStorage');
		expect(frPrivacy).toContain('empreinte de l’adresse calculée avec une clé secrète');
		expect(frPrivacy).toContain('minuit UTC');
		expect(frPrivacy).toContain('fenêtre de comptage est d’une minute');
		expect(frPrivacy).toContain('pages Recherche, Carte et En direct');
		expect(frPrivacy).toContain('insérer le script');
		expect(frPrivacy).toContain('choix Suspendre les mises à jour dans sessionStorage');
		expect(enPrivacy).toContain('public website');
		expect(enPrivacy).not.toContain('public service');
		expect(frPrivacy).toContain('accessible au public');
		expect(frPrivacy).toContain('site public');
		expect(frPrivacy).not.toContain('projet public d’information');
		expect(frPrivacy).not.toContain('service public');
	});

	it.each(['privacy', 'terms'] as const)('keeps EN/FR %s sections aligned', (kind) => {
		const en = legalDocument('en', kind);
		const fr = legalDocument('fr', kind);

		expect(fr.sections.map(({ id }) => id)).toEqual(en.sections.map(({ id }) => id));
		for (const document of [en, fr]) {
			expect(document.sections.length).toBeGreaterThanOrEqual(7);
			expect(
				document.sections.every(({ title, paragraphs }) => title && paragraphs.length > 0),
			).toBe(true);
		}
	});

	it('binds both localized documents to the actual publication date, written as the app writes dates', () => {
		expect(LEGAL_EFFECTIVE_DATES).toEqual({
			privacy: '2026-11-27',
			terms: '2026-11-27',
			accessibility: '2026-11-26',
		});
		expect(legalDocument('en', 'privacy').effectiveDate).toBe('27 November 2026');
		expect(legalDocument('en', 'terms').effectiveDate).toBe('27 November 2026');
		expect(legalDocument('fr', 'privacy').effectiveDate).toBe('27 novembre 2026');
		expect(legalDocument('fr', 'terms').effectiveDate).toBe('27 novembre 2026');
	});

	it.each([
		['en', 'Pause live updates', 'until you press Enter', '26 November 2026'],
		['fr', 'Suspendre les mises à jour', 'avant la touche Entrée', '26 novembre 2026'],
	] as const)(
		'names the live pause and the city picker on the %s Accessibility page',
		(locale, pause, picker, date) => {
			const page = legalDocument(locale, 'accessibility');
			const text = JSON.stringify(page.sections);
			expect(text).toContain(pause);
			expect(text).toContain(picker);
			expect(page.effectiveDate).toBe(date);
		},
	);

	it('keeps both Privacy policies free of internal service terms', () => {
		for (const locale of ['en', 'fr'] as const) {
			const text = JSON.stringify(legalDocument(locale, 'privacy').sections);
			expect(text).not.toMatch(/Workers (?:Issues|Logs)|workflow|service worker|suivi d’un lien/u);
		}
		const en = JSON.stringify(legalDocument('en', 'privacy').sections);
		expect(en).toContain('Cloudflare’s error reports are turned off');
		expect(en).toContain('Cloudflare keeps these error logs for at most seven days');
		expect(en).toContain('a link to the automated check');
		expect(en).toContain('A browser offline module can keep on your device');
		const fr = JSON.stringify(legalDocument('fr', 'privacy').sections);
		expect(fr).toContain('le clic sur un lien vers yesid.dev');
	});

	it('describes only what this app stores and sends, without the old site', () => {
		for (const locale of ['en', 'fr'] as const) {
			const text = JSON.stringify([
				legalDocument(locale, 'privacy'),
				legalDocument(locale, 'terms'),
			]);
			for (const gone of ['receipt', 'reçu', ' /v1', ' /data', 'sections-choice', 'snapshot'])
				expect(text).not.toContain(gone);
			expect(text).not.toContain('instantané');
			expect(text).toContain('localStorage');
			expect(text).toContain('sessionStorage');
		}
		expect(JSON.stringify(legalDocument('en', 'privacy'))).toContain('map legend');
		expect(JSON.stringify(legalDocument('fr', 'privacy'))).toContain(
			'Tout déplier ou Tout replier',
		);
	});
});

describe('generated source credits', () => {
	const licence = (name: string, source: { en: string; fr: string }) => ({
		attribution: { en: `${name} attribution`, fr: `Attribution ${name}` },
		name: { en: `${name} Licence`, fr: `Licence ${name}` },
		url: { en: `https://example.org/${name}/en`, fr: `https://example.org/${name}/fr` },
		source,
	});
	const providers = [
		{ download_licence: licence('Alpha', { en: 'the Alpha Agency', fr: 'de l’Agence Alpha' }) },
		{ download_licence: null },
		{ download_licence: licence('Beta', { en: 'Beta Transit', fr: 'de Beta Transit' }) },
	];

	it('links each published network’s licence on the terms page, in both languages', () => {
		const en = legalDocument('en', 'terms', providers).sections.find(({ id }) => id === 'licenses');
		const fr = legalDocument('fr', 'terms', providers).sections.find(({ id }) => id === 'licenses');
		expect(en?.links?.slice(0, 2)).toEqual([
			{ href: 'https://example.org/Alpha/en', label: 'Data from the Alpha Agency: Alpha Licence' },
			{ href: 'https://example.org/Beta/en', label: 'Data from Beta Transit: Beta Licence' },
		]);
		expect(fr?.links?.slice(0, 2)).toEqual([
			{ href: 'https://example.org/Alpha/fr', label: 'Données de l’Agence Alpha : Licence Alpha' },
			{ href: 'https://example.org/Beta/fr', label: 'Données de Beta Transit : Licence Beta' },
		]);
		expect(en?.links?.length).toBe(
			(legalDocument('en', 'terms').sections.find(({ id }) => id === 'licenses')?.links?.length ??
				0) + 2,
		);
	});

	it('names no network that is not in the published list', () => {
		for (const locale of ['en', 'fr'] as const) {
			const text = JSON.stringify(legalDocument(locale, 'terms', providers));
			expect(text).not.toMatch(/inacti|aucune donnée|no .* data is published/i);
			expect(legalDocument(locale, 'privacy', providers)).toEqual(legalDocument(locale, 'privacy'));
		}
	});

	it('renders the credits as links', () => {
		const { getByRole } = render(LegalDocument, {
			props: { locale: 'en', kind: 'terms', providers },
		});
		expect(getByRole('link', { name: 'Data from Beta Transit: Beta Licence' })).toHaveAttribute(
			'href',
			'https://example.org/Beta/en',
		);
	});
});
