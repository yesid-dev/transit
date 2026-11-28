import { defineCopy, type Locale } from '#lib/i18n/index.ts';
import type { PublicCity } from '#lib/v1/schemas/providers.ts';
import { longDate } from '#lib/site/presenter.ts';

export type LegalPageKind = 'privacy' | 'terms' | 'accessibility';
export const LEGAL_EFFECTIVE_DATES: Readonly<Record<LegalPageKind, string>> = {
	privacy: '2026-11-27',
	terms: '2026-11-27',
	accessibility: '2026-11-28',
};

export interface LegalLinkCopy {
	readonly href: string;
	readonly label: string;
}

export interface LegalSectionCopy {
	readonly id: string;
	readonly title: string;
	readonly paragraphs: readonly string[];
	readonly bullets?: readonly string[];
	readonly links?: readonly LegalLinkCopy[];
}

export interface LegalDocumentCopy {
	readonly kicker: string;
	readonly title: string;
	readonly effectiveLabel: string;
	readonly summary: string;
	readonly sections: readonly LegalSectionCopy[];
}

/** A document as shown: its effective date written the way the rest of the app writes dates. */
export interface LegalDocument extends LegalDocumentCopy {
	readonly effectiveDate: string;
}

export const legalCopy = defineCopy({
	fr: {
		footerAttribution:
			'Les droits liés au code ouvert et au contenu tiers sont indiqués dans les conditions, le fichier NOTICE et les crédits de source.',
	},
	en: {
		footerAttribution:
			'Open-source and third-party rights are identified in the Terms, NOTICE file and source credits.',
	},
});

const documents = {
	en: {
		privacy: {
			kicker: 'LEGAL',
			title: 'Privacy Policy',
			effectiveLabel: 'Effective and last updated',
			summary:
				'This policy explains the limited personal information processing involved when you use Transit. Transit has no user accounts, payments, advertising, newsletter or direct marketing.',
			sections: [
				{
					id: 'operator',
					title: 'Operator and Privacy Officer',
					paragraphs: [
						'Transit is a public transit information and portfolio project operated by Yesid Fernando Otalora, a sole proprietor in Quebec, Canada.',
						'Yesid Fernando Otalora is the person in charge of the protection of personal information for Transit. Title: Privacy Officer. Contact: contact@yesid.dev.',
					],
				},
				{
					id: 'processing',
					title: 'Information processed when you visit',
					paragraphs: [
						'Cloudflare delivers and protects the site. It processes ordinary network request information, such as an IP address, request path, headers and security signals, to route requests, prevent abuse and operate the service.',
						'Transit also keeps server error logs in Cloudflare to diagnose reliability. Application error entries describe which page or request failed, without search text, query strings, headers, IP addresses, error messages or stack traces. Automatic request invocation logs, traces and Cloudflare’s error reports are turned off, and query strings are redacted from log metadata. Cloudflare keeps these error logs for at most seven days. Scheduled checks of public pages and data access open a GitHub issue on repeated failure; those reports contain only the fixed public check URL, failure category and a link to the automated check, with no visitor data.',
						'When Plausible Analytics Cloud is enabled, Transit counts visits to understand which pages and sources people use and to improve the site. Plausible Insights OÜ operates the service from Estonia. When a page loads, your browser sends the page path, the referring site (its address without the path), campaign tags in the link, and your browser, operating-system and device category to Transit’s own address, which passes them on to Plausible; the rest of the page address, including searches and selected map locations, is removed in your browser before anything is sent. Transit also sends Plausible the name of a few interactions: choosing a search result, using “Use my location”, picking an address suggestion or a nearby stop, following a link to yesid.dev or Transit’s GitHub repository, and opening a page that does not exist. Every page view and event also carries the interface language (English or French) and the transit network shown; a search result adds its type (line, stop, vehicle or address) and a link adds where it sat on the page (menu, footer or page body). Nothing else is attached, never the search text, address, coordinates or stop. Transit passes your IP address and User-Agent on with each request: Plausible derives an approximate country, region and city from the IP address, combines both values with a salt that changes every day to count that day’s visitors, then discards them. They are never stored. Visitor data is processed and stored in the European Union.',
						'Plausible uses no cookies, no browser storage and no persistent identifier, and does not follow you across sites, devices or apps. It has no function that identifies, locates or profiles you within the meaning of section 8.1 of the Act respecting the protection of personal information in the private sector, so there is nothing to switch on and no banner. For visitors covered by the EU General Data Protection Regulation, the basis is Transit’s legitimate interest in understanding how the site is used (Article 6(1)(f)). Plausible keeps aggregate statistics while the account is active and no record of individual visitors. You can object by writing to contact@yesid.dev.',
						'When Cloudflare Web Analytics is enabled, Transit uses it to measure page speed and visits. Cloudflare can insert the script when it serves a page. Transit can also add the script when configured to do so. The script can run on Search, Map and Live pages. It sends Cloudflare page and referrer information, browser and device information, and measurements such as page load time and Core Web Vitals. Cloudflare receives your IP address with the request, may use it for an approximate country, and states that it discards it at the receiving data centre without storing it. The script sets no cookies, uses no browser storage and keeps no identifier between visits. Like Plausible, it has no function that identifies, locates or profiles you, and the same legitimate-interest basis applies. You can block static.cloudflareinsights.com in your browser. When Transit enables its own Web Vitals collection, the browser sends the measurements with a temporary measurement identifier, the page path and the connection category. Transit stores the measurements with an approved route template and connection category and discards the temporary identifier.',
					],
					links: [
						{ href: 'https://plausible.io/data-policy', label: 'Plausible data policy' },
						{ href: 'https://plausible.io/dpa', label: 'Plausible data processing agreement' },
						{
							href: 'https://developers.cloudflare.com/speed/observatory/rum-beacon/',
							label: 'Cloudflare Web Analytics data collection',
						},
					],
				},
				{
					id: 'search-location',
					title: 'Network selection, address search and device location',
					paragraphs: [
						'To choose the initial transit network, Transit uses the approximate coordinates Cloudflare derives from your internet connection. It checks the published network areas and defaults to STM when no single area matches. This does not request device-location permission. Transit does not store these coordinates or send them to your browser. A network selected in the page URL takes priority; you can change it in the network selector.',
						'When you type an address or place into map search, the query is sent to the Transit server and then to the Government of Canada Geo.ca geolocation service. Geo.ca receives the query from Transit, not a direct browser request from you.',
						'When you select a result, its normalized label, coordinates and precision are written to the page URL so the view can be restored or shared. Anyone who receives that URL can see those values. Clearing the selected location removes them. Do not select a sensitive address before sharing a map link.',
						'Transit uses the connecting IP address to limit requests and protect the site. When the data service fetches an uncached answer, it uses a fingerprint of the address, made with a secret key, for Cloudflare’s request limit. The key changes each day at midnight UTC. Transit uses the fingerprint only for the rate limiter’s one-minute counting window. The address search uses Cloudflare’s rate limiter when available. Its fallback keeps a temporary table in memory with up to 10,000 address entries per running copy of the server. Inactive entries can be removed after ten minutes, and a restart clears the table. Transit does not write that table to persistent storage. When Transit receives analytics requests, it uses Cloudflare’s rate limiter. Cloudflare and Geo.ca may separately process requests under their own practices.',
						'If you choose “Use my location,” your browser asks for permission. The coordinates stay in your browser and are used only to centre the map and sort nearby stops. Transit does not add them to the URL or send them to its server.',
					],
					links: [
						{
							href: 'https://natural-resources.canada.ca/maps-tools-publications/satellite-elevation-air-photos/geolocation-service',
							label: 'Government of Canada Geo.ca geolocation service',
						},
					],
				},
				{
					id: 'device-storage',
					title: 'Storage on your device',
					paragraphs: [
						'Transit uses localStorage to remember your theme, the map’s motion setting and whether the map legend is open. On the archived method page, it also remembers your Expand all or Collapse all choice. These preferences remain until you change them or clear site data. Transit keeps your scroll positions and Pause live updates choice in sessionStorage while the tab is open.',
						'When you close a site announcement, Transit remembers that choice in localStorage using the announcement’s ID.',
						'A browser offline module can keep on your device the application’s code, fonts and icons, for speed and to show an offline page, until an update, its removal or the clearing of browser data. It never keeps transit data: live positions, the record and search results are fetched fresh each time.',
					],
				},
				{
					id: 'choices',
					title: 'Your choices and consent',
					paragraphs: [
						'Where consent is the basis for processing, you may withdraw it for future processing. You can deny or revoke device-location permission in your browser, clear a selected map location and clear browser storage. Those choices may disable the related convenience feature. You can stop Cloudflare Web Analytics by blocking static.cloudflareinsights.com in your browser or with a content blocker.',
						'Essential request delivery, security and abuse prevention are necessary to provide the public website and cannot be disabled through Transit settings.',
					],
				},
				{
					id: 'purposes-sharing',
					title: 'Purposes and sharing',
					paragraphs: [
						'The information above is processed only to deliver and secure Transit, choose the initial transit network, answer an address search, remember your interface choices, diagnose reliability and understand aggregate performance.',
						'Transit does not sell or rent personal information and does not use it for advertising or direct marketing. Information may be handled by Cloudflare, Plausible and the Government of Canada service described above, or disclosed when required by law.',
						'Provider processing may occur outside Quebec. Cloudflare states that it primarily stores information in the United States and the European Economic Area. Information processed elsewhere may be subject to the laws of that location. This policy does not claim a particular Cloudflare data-localization configuration. Plausible processes and stores visitor data in the European Union.',
					],
					links: [
						{
							href: 'https://www.cloudflare.com/privacypolicy/',
							label: 'Cloudflare Privacy Policy',
						},
						{ href: 'https://plausible.io/privacy', label: 'Plausible privacy policy' },
					],
				},
				{
					id: 'retention-security',
					title: 'Retention and safeguards',
					paragraphs: [
						'Transit keeps no account profile or payment record because those features do not exist. The in-memory geocode rate limit is short-lived as described above. Browser preferences remain under your browser’s control. Cloudflare controls the retention of its network records under its own policies and keeps Web Analytics measurements in full for seven days, then as sampled aggregate statistics; Plausible keeps aggregate statistics while the Transit account is active and never stores IP addresses or User-Agent values.',
						'Transit accepts address searches only from its own site, checks their contents, limits how often they can be made and prevents browsers from keeping the replies. Cloudflare also provides delivery and security controls. No Internet service or transmission method is completely secure.',
					],
				},
				{
					id: 'rights',
					title: 'Your rights',
					paragraphs: [
						'You may ask whether Transit holds personal information about you and request access, correction or portability where applicable. You may also withdraw consent for future processing where consent applies.',
						'Send a written request to contact@yesid.dev with the right you want to exercise and enough detail to locate the information. Identity may need to be verified. A written response to an access or correction request will be provided within 30 days.',
						'To make a complaint, email the same address with the concern, what happened and the resolution requested. The Privacy Officer handles requests, complaints and incidents and reviews the practices and providers described here. If a concern is not resolved, you may contact the Commission d’accès à l’information du Québec.',
					],
					links: [
						{
							href: 'mailto:contact@yesid.dev',
							label: 'Email the Transit Privacy Officer',
						},
						{
							href: 'https://www.cai.gouv.qc.ca/',
							label: 'Commission d’accès à l’information du Québec',
						},
					],
				},
				{
					id: 'changes',
					title: 'Changes and contact',
					paragraphs: [
						'This policy may change when Transit, its providers or applicable requirements change. The effective and last-updated date above identifies the current version. When this policy is amended, a notice will be published on this page or elsewhere on the site when the amendment takes effect.',
						'Questions about this policy are welcome in English or French at contact@yesid.dev.',
					],
				},
			],
		},
		terms: {
			kicker: 'LEGAL',
			title: 'Terms of Use',
			effectiveLabel: 'Effective and last updated',
			summary:
				'These terms govern the hosted Transit website and addresses that serve its public data. Repository source is licensed separately. Transit is an independent informational project, not an official transit-agency service.',
			sections: [
				{
					id: 'operator-acceptance',
					title: 'Operator and acceptance',
					paragraphs: [
						'Transit is operated by Yesid Fernando Otalora, a sole proprietor in Quebec, Canada. By using the hosted service, you agree to these terms. If you do not agree, do not use the service.',
					],
				},
				{
					id: 'information',
					title: 'Information only',
					paragraphs: [
						'Transit presents public transit data, derived reliability measures and explanatory material. Source feeds may be late, incomplete, unavailable or corrected after publication.',
						'Do not rely on Transit for emergencies, personal safety, guaranteed arrival times or decisions where an error could cause harm. Confirm time-sensitive travel information with the applicable transit agency.',
					],
				},
				{
					id: 'independence',
					title: 'Independent project',
					paragraphs: [
						'Transit is not affiliated with, sponsored by or endorsed by STM, OC Transpo or the City of Ottawa, STO, the Government of Canada or Natural Resources Canada, the OpenStreetMap Foundation, or Protomaps. Their names and marks remain those of their respective owners; data and other material are governed by the cited source licences and terms.',
					],
				},
				{
					id: 'licenses',
					title: 'Software, data and attribution',
					paragraphs: [
						'These terms govern the hosted website and public data addresses. Use and reuse of repository source are governed by its LICENSE, NOTICE and applicable GitHub terms.',
						'Original Transit software is available under the MIT License. That license does not relicense transit-agency data, map material, fonts, trademarks or other third-party content.',
						'The repository NOTICE file, provider manifests and visible map or data credits identify the applicable sources and terms. Those third-party terms control your reuse of their material.',
						'Each network’s data is used under the licence linked below for that network, and its required attribution appears with that data on every page. OpenStreetMap data is available under ODbL and credited as © OpenStreetMap contributors; Protomaps basemap credit remains visible.',
					],
					links: [
						{
							href: 'https://github.com/yesid-dev/transit/blob/main/LICENSE',
							label: 'Transit MIT License',
						},
						{
							href: 'https://github.com/yesid-dev/transit/blob/main/NOTICE',
							label: 'Transit notices and attribution',
						},
						{
							href: 'https://www.openstreetmap.org/copyright',
							label: 'OpenStreetMap copyright and ODbL information',
						},
					],
				},
				{
					id: 'acceptable-use',
					title: 'Acceptable use and security',
					paragraphs: [
						'You may use the public site and endpoints lawfully. Do not disrupt the service, bypass access controls, impose unreasonable load, access information that is not yours or test production in a way that creates risk or cost.',
						'Report suspected vulnerabilities through the private reporting path in the repository Security Policy. Do not publish exploit details before a safe fix can be coordinated.',
					],
					links: [
						{
							href: 'https://github.com/yesid-dev/transit/security/policy',
							label: 'Transit Security Policy',
						},
					],
				},
				{
					id: 'warranty-liability',
					title: 'No warranty and limitation of liability',
					paragraphs: [
						'Transit is provided “as is” and “as available,” without a promise that it will be uninterrupted, current, complete or error-free.',
						'To the extent permitted by applicable law, the operator is not liable for indirect, incidental or consequential loss arising from use of Transit or reliance on its content. Nothing in these terms limits liability that cannot legally be excluded under Quebec law, including liability for intentional or gross fault or for bodily or moral injury.',
					],
				},
				{
					id: 'links-law-changes',
					title: 'Third-party links, governing law and changes',
					paragraphs: [
						'Links and embedded source references lead to services Transit does not control. Their terms and privacy practices apply when you use them.',
						'These terms are governed by the laws of Quebec and the applicable laws of Canada. Subject to any mandatory rule that grants another forum, disputes relating to Transit fall within the competent courts of the judicial district of Montreal.',
						'These terms may change when Transit, its providers or applicable requirements change. The effective date above identifies the current version. Questions are welcome at contact@yesid.dev.',
					],
					links: [
						{
							href: 'mailto:contact@yesid.dev',
							label: 'Contact the operator',
						},
					],
				},
			],
		},
		accessibility: {
			kicker: 'LEGAL',
			title: 'Accessibility',
			effectiveLabel: 'Last updated',
			summary:
				'Transit aims to meet the Web Content Accessibility Guidelines (WCAG) 2.2, level AA. It is built on yesid.design, the same shared packages as yesid.dev, so the header, menu, footer, colors, focus and motion are checked on every release.',
			sections: [
				{
					id: 'works',
					title: 'What works today',
					paragraphs: [],
					bullets: [
						'A skip link, then the same landmarks on every page.',
						'A visible focus ring for the keyboard, also in Windows High Contrast.',
						'Charts come with a data table that screen readers can read.',
						'Use Search and the line, stop and vehicle lists to find a service without using the map.',
						'The Pause live updates switch holds the live figures still while you read.',
						'The city picker changes nothing until you press Enter.',
						'Reduced motion is respected.',
						'The site is available in English and French.',
					],
				},
				{
					id: 'limitations',
					title: 'Known limitations',
					paragraphs: [],
					bullets: [
						'The map is pointer-first: its markers cannot be reached by keyboard. Exact vehicle positions and some map readings are available on the map.',
						'Data comes from the transit agencies’ public feeds. When a feed is late or missing, the page says so instead of showing zeros.',
						'Transit has not been formally audited by a third party. This statement is based on automated checks and my own keyboard testing.',
					],
				},
				{
					id: 'report',
					title: 'Tell me what is not working',
					paragraphs: [
						'If something is hard or impossible to use, write to contact@yesid.dev with the page, what you were trying to do and, if you can, your browser and assistive technology. You can write in English or French.',
					],
					links: [{ href: 'mailto:contact@yesid.dev', label: 'Email contact@yesid.dev' }],
				},
			],
		},
	},
	fr: {
		privacy: {
			kicker: 'JURIDIQUE',
			title: 'Politique de confidentialité',
			effectiveLabel: 'Entrée en vigueur et dernière mise à jour',
			summary:
				'La présente politique explique le traitement limité de renseignements personnels lié à l’utilisation de Transit. Transit ne propose aucun compte, paiement, publicité, infolettre ni marketing direct.',
			sections: [
				{
					id: 'operator',
					title: 'Exploitant et responsable de la protection des renseignements personnels',
					paragraphs: [
						'Transit est un projet d’information sur le transport collectif et de portfolio accessible au public, exploité par Yesid Fernando Otalora, travailleur autonome exploitant une entreprise individuelle au Québec, au Canada.',
						'Yesid Fernando Otalora est la personne responsable de la protection des renseignements personnels pour Transit. Titre : Responsable de la protection des renseignements personnels. Contact : contact@yesid.dev.',
					],
				},
				{
					id: 'processing',
					title: 'Renseignements traités lors d’une visite',
					paragraphs: [
						'Cloudflare livre et protège le site. L’entreprise traite des renseignements ordinaires liés aux requêtes réseau, comme l’adresse IP, le chemin demandé, les en-têtes et les signaux de sécurité, afin d’acheminer les requêtes, de prévenir les abus et d’exploiter le service.',
						'Transit conserve aussi des journaux d’erreurs serveur chez Cloudflare pour diagnostiquer la fiabilité. Les entrées d’erreur de l’application décrivent sur quelle page ou demande l’erreur s’est produite, sans texte recherché, paramètres d’URL, en-têtes, adresse IP, message d’erreur ni trace de pile. Les journaux automatiques de requêtes, les traces et les signalements d’erreurs de Cloudflare sont désactivés, et les paramètres d’URL sont masqués dans les métadonnées des journaux. Cloudflare conserve ces journaux d’erreurs pendant au plus sept jours. Des vérifications planifiées de pages publiques et de l’accès aux données ouvrent un signalement GitHub après un échec répété; ces rapports contiennent seulement l’URL publique fixe vérifiée, la catégorie d’échec et le lien vers la vérification automatisée, sans données de visiteur.',
						'Lorsque Plausible Analytics Cloud est activé, Transit compte les visites pour comprendre quelles pages et quelles sources sont utilisées et améliorer le site. Plausible Insights OÜ exploite ce service depuis l’Estonie. Au chargement d’une page, votre navigateur envoie le chemin de la page, le site d’origine (son adresse sans le chemin), les balises de campagne du lien et les catégories de navigateur, de système d’exploitation et d’appareil à l’adresse même de Transit, qui les transmet à Plausible; le reste de l’adresse de la page, y compris les recherches et les lieux sélectionnés sur la carte, est retiré dans votre navigateur avant tout envoi. Transit envoie aussi à Plausible le nom de quelques interactions : le choix d’un résultat de recherche, l’utilisation de « Utiliser ma position », le choix d’une adresse suggérée ou d’un arrêt à proximité, le clic sur un lien vers yesid.dev ou le dépôt GitHub de Transit et l’ouverture d’une page qui n’existe pas. Chaque page vue et chaque événement indiquent aussi la langue de l’interface (anglais ou français) et le réseau affiché; un résultat de recherche ajoute son type (ligne, arrêt, véhicule ou adresse) et un lien ajoute son emplacement dans la page (menu, pied de page ou corps de la page). Rien d’autre n’est joint, jamais le texte recherché, l’adresse, les coordonnées ni l’arrêt. Transit transmet aussi votre adresse IP et votre agent utilisateur avec chaque requête : Plausible déduit de l’adresse IP un pays, une région et une ville approximatifs, combine les deux valeurs à un sel renouvelé chaque jour pour compter les visiteurs de la journée, puis les élimine. Elles ne sont jamais conservées. Les données de visite sont traitées et conservées dans l’Union européenne.',
						'Plausible n’utilise ni témoins, ni stockage du navigateur, ni identifiant persistant, et ne vous suit pas d’un site, d’un appareil ou d’une application à l’autre. Il ne comporte aucune fonction permettant de vous identifier, de vous localiser ou d’effectuer votre profilage au sens de l’article 8.1 de la Loi sur la protection des renseignements personnels dans le secteur privé; il n’y a donc rien à activer et aucune bannière. Pour les personnes visées par le Règlement général sur la protection des données de l’Union européenne, le fondement est l’intérêt légitime de Transit à comprendre l’utilisation du site (article 6(1)(f)). Plausible conserve des statistiques agrégées tant que le compte est actif et aucun dossier sur les visiteurs individuels. Vous pouvez vous y opposer en écrivant à contact@yesid.dev.',
						'Lorsque Cloudflare Web Analytics est activé, Transit l’utilise pour mesurer la vitesse des pages et les visites. Cloudflare peut insérer le script lorsqu’il transmet une page. Transit peut aussi ajouter le script si le site est configuré à cette fin. Le script peut fonctionner sur les pages Recherche, Carte et En direct. Il envoie à Cloudflare des renseignements sur les pages visitées, les pages d’origine, le navigateur et l’appareil, ainsi que des mesures comme le temps de chargement et les signaux Web essentiels. Cloudflare reçoit votre adresse IP avec la requête, peut en déduire un pays approximatif et indique l’éliminer au centre de données qui la reçoit, sans la conserver. Le script ne crée aucun témoin, n’utilise pas le stockage du navigateur et ne conserve aucun identifiant d’une visite à l’autre. Comme Plausible, il ne comporte aucune fonction permettant de vous identifier, de vous localiser ou d’effectuer votre profilage, et le même fondement d’intérêt légitime s’applique. Vous pouvez bloquer static.cloudflareinsights.com dans votre navigateur. Lorsque Transit active sa propre collecte des signaux Web essentiels, le navigateur envoie les mesures avec un identifiant temporaire de mesure, le chemin de la page et la catégorie de connexion. Transit conserve les mesures avec un modèle de route et une catégorie de connexion autorisés, puis écarte l’identifiant temporaire.',
					],
					links: [
						{
							href: 'https://plausible.io/data-policy',
							label: 'Politique de données de Plausible',
						},
						{
							href: 'https://plausible.io/dpa',
							label: 'Entente de traitement des données de Plausible',
						},
						{
							href: 'https://developers.cloudflare.com/speed/observatory/rum-beacon/',
							label: 'Données recueillies par Cloudflare Web Analytics (en anglais)',
						},
					],
				},
				{
					id: 'search-location',
					title: 'Choix du réseau, recherche d’adresse et localisation de l’appareil',
					paragraphs: [
						'Pour choisir le réseau de transport initial, Transit utilise les coordonnées approximatives que Cloudflare déduit de votre connexion Internet. Il les compare aux zones publiées des réseaux et choisit la STM si aucune zone unique ne correspond. Aucune permission de localisation de l’appareil n’est demandée. Transit ne conserve pas ces coordonnées et ne les envoie pas à votre navigateur. Le réseau sélectionné dans l’URL de la page est prioritaire; vous pouvez le modifier dans le sélecteur de réseau.',
						'Lorsque vous saisissez une adresse ou un lieu dans la recherche cartographique, la requête est envoyée au serveur de Transit, puis au service de géolocalisation Geo.ca du gouvernement du Canada. Geo.ca reçoit la requête de Transit, et non une requête directe de votre navigateur.',
						'Lorsque vous sélectionnez un résultat, son libellé normalisé, ses coordonnées et son niveau de précision sont inscrits dans l’URL afin de restaurer ou de partager la vue. Toute personne qui reçoit cette URL peut voir ces valeurs. L’effacement du lieu sélectionné les retire. Ne sélectionnez pas une adresse sensible avant de partager un lien cartographique.',
						'Transit utilise l’adresse IP de connexion pour limiter les requêtes et protéger le site. Lorsque le service de données récupère une réponse absente du cache, il utilise une empreinte de l’adresse calculée avec une clé secrète pour le limiteur de Cloudflare. La clé change chaque jour à minuit UTC. Transit utilise cette empreinte uniquement pour le limiteur, dont la fenêtre de comptage est d’une minute. La recherche d’adresse utilise le limiteur de Cloudflare lorsqu’il est disponible. À défaut, elle utilise une table temporaire en mémoire, limitée à 10 000 entrées d’adresse IP par copie active du serveur. Les entrées inactives peuvent être retirées après dix minutes et un redémarrage vide la table. Transit n’enregistre pas cette table dans un stockage persistant. Transit utilise le limiteur de Cloudflare lorsqu’il reçoit des requêtes d’analyse. Cloudflare et Geo.ca peuvent traiter séparément les requêtes selon leurs propres pratiques.',
						'Si vous choisissez « Utiliser ma position », votre navigateur demande votre permission. Les coordonnées restent dans votre navigateur et servent seulement à centrer la carte et à trier les arrêts à proximité. Transit ne les ajoute pas à l’URL et ne les envoie pas à son serveur.',
					],
					links: [
						{
							href: 'https://ressources-naturelles.canada.ca/carte-outils-publications/imagerie-satellitaire-donnees-elevation-photos-aeriennes/service-geolocalisation',
							label: 'Service de géolocalisation Geo.ca du gouvernement du Canada',
						},
					],
				},
				{
					id: 'device-storage',
					title: 'Stockage sur votre appareil',
					paragraphs: [
						'Transit utilise localStorage pour mémoriser le thème, le réglage des animations de la carte et l’état ouvert ou fermé de sa légende. Sur la page archivée de la méthode, il mémorise aussi votre choix Tout déplier ou Tout replier. Ces préférences restent jusqu’à leur modification ou l’effacement des données du site. Transit conserve vos positions de défilement et votre choix Suspendre les mises à jour dans sessionStorage tant que l’onglet est ouvert.',
						'Lorsque vous fermez une annonce du site, Transit mémorise ce choix dans localStorage à l’aide de l’identifiant de l’annonce.',
						'Un module hors ligne du navigateur peut garder sur votre appareil le code, les polices et les icônes de l’application, pour accélérer le chargement et afficher une page hors ligne, jusqu’à une mise à jour, son retrait ou l’effacement des données du navigateur. Il ne garde jamais de données de transport\u00a0: les positions en direct, le bilan et les résultats de recherche sont chargés à neuf chaque fois.',
					],
				},
				{
					id: 'choices',
					title: 'Vos choix et votre consentement',
					paragraphs: [
						'Lorsque le consentement fonde un traitement, vous pouvez le retirer pour l’avenir. Vous pouvez refuser ou révoquer la permission de localisation dans votre navigateur, effacer un lieu sélectionné et supprimer les données du navigateur. Ces choix peuvent désactiver la fonction pratique concernée. Vous pouvez arrêter Cloudflare Web Analytics en bloquant static.cloudflareinsights.com dans votre navigateur ou avec un bloqueur de contenu.',
						'La livraison essentielle des requêtes, la sécurité et la prévention des abus sont nécessaires pour fournir le site public et ne peuvent pas être désactivées dans les réglages de Transit.',
					],
				},
				{
					id: 'purposes-sharing',
					title: 'Finalités et communication',
					paragraphs: [
						'Les renseignements décrits ci-dessus sont traités uniquement pour livrer et protéger Transit, choisir le réseau de transport initial, répondre à une recherche d’adresse, mémoriser vos choix d’interface, diagnostiquer la fiabilité et comprendre la performance globale.',
						'Transit ne vend ni ne loue de renseignements personnels et ne les utilise pas à des fins de publicité ou de marketing direct. Des renseignements peuvent être traités par Cloudflare, Plausible et le service du gouvernement du Canada décrit ci-dessus, ou communiqués lorsque la loi l’exige.',
						'Le traitement par les fournisseurs peut avoir lieu à l’extérieur du Québec. Cloudflare indique stocker principalement les renseignements aux États-Unis et dans l’Espace économique européen. Les renseignements traités ailleurs peuvent être assujettis aux lois de cet endroit. La présente politique ne prétend pas qu’une configuration particulière de localisation des données Cloudflare est activée. Plausible traite et conserve les données de visite dans l’Union européenne.',
					],
					links: [
						{
							href: 'https://www.cloudflare.com/fr-fr/privacypolicy/',
							label: 'Politique de confidentialité de Cloudflare',
						},
						{
							href: 'https://plausible.io/privacy',
							label: 'Politique de confidentialité de Plausible',
						},
					],
				},
				{
					id: 'retention-security',
					title: 'Conservation et mesures de protection',
					paragraphs: [
						'Transit ne conserve aucun profil de compte ni dossier de paiement, puisque ces fonctions n’existent pas. La limite de recherche en mémoire est de courte durée, comme décrit ci-dessus. Les préférences du navigateur restent sous votre contrôle. Cloudflare contrôle la conservation de ses registres réseau selon ses propres politiques et conserve les mesures de Web Analytics au complet pendant sept jours, puis sous forme de statistiques agrégées échantillonnées; Plausible conserve des statistiques agrégées tant que le compte de Transit est actif et ne conserve jamais d’adresse IP ni d’agent utilisateur.',
						'Transit accepte les recherches d’adresse seulement depuis son propre site, en vérifie le contenu, limite leur fréquence et empêche les navigateurs de garder les réponses. Cloudflare assure aussi la livraison et la sécurité du site. Aucun service Internet ni mode de transmission n’est entièrement sûr.',
					],
				},
				{
					id: 'rights',
					title: 'Vos droits',
					paragraphs: [
						'Vous pouvez demander si Transit détient des renseignements personnels à votre sujet et demander leur accès, leur rectification ou leur portabilité, lorsque ces droits s’appliquent. Vous pouvez aussi retirer votre consentement pour l’avenir lorsque le traitement repose sur celui-ci.',
						'Envoyez une demande écrite à contact@yesid.dev en indiquant le droit exercé et assez de détails pour retrouver les renseignements. Votre identité peut devoir être vérifiée. Une réponse écrite à une demande d’accès ou de rectification sera fournie dans les 30 jours.',
						'Pour déposer une plainte, écrivez à la même adresse en décrivant la préoccupation, les faits et la solution demandée. Le responsable traite les demandes, plaintes et incidents et révise les pratiques et fournisseurs décrits ici. Si une préoccupation n’est pas résolue, vous pouvez vous adresser à la Commission d’accès à l’information du Québec.',
					],
					links: [
						{
							href: 'mailto:contact@yesid.dev',
							label: 'Écrire au responsable de Transit',
						},
						{
							href: 'https://www.cai.gouv.qc.ca/',
							label: 'Commission d’accès à l’information du Québec',
						},
					],
				},
				{
					id: 'changes',
					title: 'Modifications et contact',
					paragraphs: [
						'La présente politique peut changer lorsque Transit, ses fournisseurs ou les exigences applicables changent. La date d’entrée en vigueur et de dernière mise à jour ci-dessus indique la version actuelle. Lorsque la présente politique est modifiée, un avis est publié sur cette page ou ailleurs sur le site au moment de l’entrée en vigueur de la modification.',
						'Les questions sur cette politique sont les bienvenues en français ou en anglais à contact@yesid.dev.',
					],
				},
			],
		},
		terms: {
			kicker: 'JURIDIQUE',
			title: 'Conditions d’utilisation',
			effectiveLabel: 'Entrée en vigueur et dernière mise à jour',
			summary:
				'Les présentes conditions régissent le site Transit hébergé et ses adresses publiques qui servent les données. Le code du dépôt est offert sous une licence distincte. Transit est un projet d’information indépendant, et non un service officiel d’une société de transport.',
			sections: [
				{
					id: 'operator-acceptance',
					title: 'Exploitant et acceptation',
					paragraphs: [
						'Transit est exploité par Yesid Fernando Otalora, travailleur autonome exploitant une entreprise individuelle au Québec, au Canada. En utilisant le service hébergé, vous acceptez les présentes conditions. Si vous ne les acceptez pas, n’utilisez pas le service.',
					],
				},
				{
					id: 'information',
					title: 'Information seulement',
					paragraphs: [
						'Transit présente des données publiques de transport collectif, des mesures de fiabilité dérivées et du contenu explicatif. Les flux de source peuvent être en retard, incomplets, indisponibles ou corrigés après leur publication.',
						'Ne vous fiez pas à Transit pour une urgence, votre sécurité, une heure d’arrivée garantie ou une décision dont l’erreur pourrait causer un préjudice. Confirmez les renseignements de déplacement sensibles au temps auprès de la société de transport concernée.',
					],
				},
				{
					id: 'independence',
					title: 'Projet indépendant',
					paragraphs: [
						'Transit n’est ni affilié, ni commandité, ni approuvé par la STM, OC Transpo ou la Ville d’Ottawa, la STO, le gouvernement du Canada ou Ressources naturelles Canada, la Fondation OpenStreetMap, ou Protomaps. Leurs noms et marques demeurent ceux de leurs propriétaires respectifs; les données et autres éléments sont régis par les licences et conditions de source citées.',
					],
				},
				{
					id: 'licenses',
					title: 'Logiciel, données et attribution',
					paragraphs: [
						'Les présentes conditions régissent le site hébergé et les adresses publiques qui servent les données. L’utilisation et la réutilisation du code du dépôt sont régies par ses fichiers LICENSE et NOTICE ainsi que par les conditions applicables de GitHub.',
						'Le logiciel original de Transit est offert selon la licence MIT. Cette licence ne remet pas sous licence les données des sociétés de transport, le contenu cartographique, les polices, les marques de commerce ni les autres éléments de tiers.',
						'Le fichier NOTICE du dépôt, les manifestes de fournisseur et les crédits visibles de carte ou de données indiquent les sources et conditions applicables. Ces conditions de tiers régissent la réutilisation de leur contenu.',
						'Les données de chaque réseau sont utilisées selon la licence indiquée ci-dessous pour ce réseau, et l’attribution exigée accompagne ces données sur chaque page. Les données OpenStreetMap sont offertes selon l’ODbL et attribuées par la mention © contributeurs OpenStreetMap; le crédit de fond de carte Protomaps demeure visible.',
					],
					links: [
						{
							href: 'https://github.com/yesid-dev/transit/blob/main/LICENSE',
							label: 'Licence MIT de Transit',
						},
						{
							href: 'https://github.com/yesid-dev/transit/blob/main/NOTICE',
							label: 'Mentions et attributions de Transit',
						},
						{
							href: 'https://www.openstreetmap.org/copyright',
							label: 'Droits d’auteur et renseignements ODbL d’OpenStreetMap',
						},
					],
				},
				{
					id: 'acceptable-use',
					title: 'Utilisation acceptable et sécurité',
					paragraphs: [
						'Vous pouvez utiliser le site public et ses adresses de données conformément à la loi. Vous ne devez pas perturber le service, contourner des contrôles d’accès, imposer une charge déraisonnable, accéder à des renseignements qui ne vous appartiennent pas ni tester la production d’une manière qui crée un risque ou un coût.',
						'Signalez toute vulnérabilité présumée au moyen du canal privé indiqué dans la politique de sécurité du dépôt. Ne publiez pas de détails d’exploitation avant qu’une correction sûre puisse être coordonnée.',
					],
					links: [
						{
							href: 'https://github.com/yesid-dev/transit/security/policy',
							label: 'Politique de sécurité de Transit',
						},
					],
				},
				{
					id: 'warranty-liability',
					title: 'Absence de garantie et limitation de responsabilité',
					paragraphs: [
						'Transit est fourni « tel quel » et « selon sa disponibilité », sans promesse de fonctionnement ininterrompu, actuel, complet ou exempt d’erreurs.',
						'Dans la mesure permise par la loi applicable, l’exploitant n’est pas responsable des pertes indirectes, accessoires ou consécutives découlant de l’utilisation de Transit ou de la confiance accordée à son contenu. Rien dans les présentes conditions ne limite une responsabilité qui ne peut légalement être exclue au Québec, notamment en cas de faute intentionnelle ou lourde ou de préjudice corporel ou moral.',
					],
				},
				{
					id: 'links-law-changes',
					title: 'Liens de tiers, droit applicable et modifications',
					paragraphs: [
						'Les liens et références de source mènent à des services que Transit ne contrôle pas. Leurs conditions et pratiques de confidentialité s’appliquent lorsque vous les utilisez.',
						'Les présentes conditions sont régies par les lois du Québec et les lois applicables du Canada. Sous réserve de toute règle impérative accordant un autre for, les litiges relatifs à Transit relèvent des tribunaux compétents du district judiciaire de Montréal.',
						'Les présentes conditions peuvent changer lorsque Transit, ses fournisseurs ou les exigences applicables changent. La date d’entrée en vigueur ci-dessus indique la version actuelle. Les questions sont les bienvenues à contact@yesid.dev.',
					],
					links: [
						{
							href: 'mailto:contact@yesid.dev',
							label: 'Communiquer avec l’exploitant',
						},
					],
				},
			],
		},
		accessibility: {
			kicker: 'JURIDIQUE',
			title: 'Accessibilité',
			effectiveLabel: 'Dernière mise à jour',
			summary:
				'Transit vise les Règles pour l’accessibilité des contenus Web (WCAG) 2.2, niveau AA. Le site repose sur yesid.design, les mêmes paquets partagés que yesid.dev : l’en-tête, le menu, le pied de page, les couleurs, le focus et les animations sont vérifiés à chaque version.',
			sections: [
				{
					id: 'works',
					title: 'Ce qui fonctionne aujourd’hui',
					paragraphs: [],
					bullets: [
						'Un lien d’évitement, puis les mêmes repères sur chaque page.',
						'Un focus visible au clavier, aussi en Contraste élevé de Windows.',
						'Chaque graphique a un tableau lisible par les lecteurs d’écran.',
						'Utilisez la recherche et les listes de lignes, d’arrêts et de véhicules pour trouver un service sans utiliser la carte.',
						'L’interrupteur Suspendre les mises à jour fige les chiffres en direct.',
						'Le choix de la ville ne change rien avant la touche Entrée.',
						'Le réglage de réduction des animations est respecté.',
						'Le site est offert en français et en anglais.',
					],
				},
				{
					id: 'limitations',
					title: 'Limites connues',
					paragraphs: [],
					bullets: [
						'La carte est d’abord pensée pour le pointeur : ses marqueurs ne sont pas accessibles au clavier. Les positions exactes des véhicules et certaines mesures sont offertes sur la carte.',
						'Les données proviennent des flux publics des sociétés de transport. Quand un flux est en retard ou absent, la page l’indique au lieu d’afficher des zéros.',
						'Transit n’a pas fait l’objet d’un audit externe. Cette déclaration repose sur des vérifications automatisées et sur mes propres essais au clavier.',
					],
				},
				{
					id: 'report',
					title: 'Signalez-moi ce qui ne fonctionne pas',
					paragraphs: [
						'Si quelque chose est difficile ou impossible à utiliser, écrivez à contact@yesid.dev en précisant la page, ce que vous tentiez de faire et, si possible, votre navigateur et votre technologie d’aide. Vous pouvez écrire en français ou en anglais.',
					],
					links: [{ href: 'mailto:contact@yesid.dev', label: 'Écrire à contact@yesid.dev' }],
				},
			],
		},
	},
} as const satisfies Record<Locale, Record<LegalPageKind, LegalDocumentCopy>>;

type LicensedCity = Pick<PublicCity, 'download_licence'>;

/** One link per published network, built from its declared download licence. */
export function sourceCreditLinks(
	locale: Locale,
	providers: readonly LicensedCity[],
): LegalLinkCopy[] {
	return providers.flatMap(({ download_licence: licence }) => {
		if (!licence?.name || !licence.url || !licence.source) return [];
		const label =
			locale === 'fr'
				? `Données ${licence.source.fr}\u00a0: ${licence.name.fr}`
				: `Data from ${licence.source.en}: ${licence.name.en}`;
		return [{ href: licence.url[locale], label }];
	});
}

export function legalDocument(
	locale: Locale,
	kind: LegalPageKind,
	providers: readonly LicensedCity[] = [],
): LegalDocument {
	const document: LegalDocument = {
		...documents[locale][kind],
		effectiveDate: longDate(LEGAL_EFFECTIVE_DATES[kind], locale),
	};
	const credits = sourceCreditLinks(locale, providers);
	if (kind !== 'terms' || credits.length === 0) return document;
	return {
		...document,
		sections: document.sections.map((section) =>
			section.id === 'licenses'
				? { ...section, links: [...credits, ...(section.links ?? [])] }
				: section,
		),
	};
}
