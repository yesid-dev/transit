const common = {
  checked_on: "2026-11-22",
  contact: "contact@yesid.dev",
  non_endorsement: {
    en: "Transit is independent of STM, the City of Ottawa and OC Transpo. None of these organisations sponsors or endorses Transit.",
    fr: "Transit est indépendant de la STM, de la Ville d’Ottawa et d’OC Transpo. Aucun de ces organismes ne commandite ni n’approuve Transit.",
  },
};

const licences = new Map([
  ["stm", {
    ...common,
    name: {
      en: "Creative Commons Attribution 4.0 (CC BY 4.0)",
      fr: "Creative Commons Attribution 4.0 (CC BY 4.0)",
    },
    attribution: {
      en: "Source: Société de transport de Montréal (STM), CC BY 4.0.",
      fr: "Source : Société de transport de Montréal (STM), CC BY 4.0.",
    },
    url: {
      en: "https://creativecommons.org/licenses/by/4.0/",
      fr: "https://creativecommons.org/licenses/by/4.0/deed.fr",
    },
    operator: "STM",
    limits: {
      en: "The data is provided as is, without warranty, and may contain errors. Scheduled metro times are indicative only.",
      fr: "Les données sont fournies telles quelles, sans garantie, et peuvent contenir des erreurs. Les horaires du métro sont donnés à titre indicatif seulement.",
    },
  }],
  ["octranspo", {
    ...common,
    name: {
      en: "Open Government Licence, City of Ottawa, v2.0",
      fr: "Licence du gouvernement ouvert, Ville d’Ottawa, version 2.0",
    },
    attribution: {
      en: "Contains information licensed under the Open Government Licence – City of Ottawa.",
      fr: "Contient de l’information visée par la Licence du gouvernement ouvert – Ville d’Ottawa.",
    },
    url: {
      en: "https://ottawa.ca/en/city-hall/open-transparent-and-accountable-government/open-data/open-data-licence-version-20",
      fr: "https://ottawa.ca/fr/hotel-de-ville/administration-ouverte-et-transparente-et-qui-rend-compte-de-ses-actes/donnees-ouvertes/version-20-de-la-licence-du-programme-de-donnees-ouvertes",
    },
    operator: "OC Transpo",
    limits: {
      en: "The data is provided as is, without warranty, and may contain errors. The City reports that vehicle positions are unknown about 5% of the time.",
      fr: "Les données sont fournies telles quelles, sans garantie, et peuvent contenir des erreurs. Selon la Ville, les positions des véhicules sont inconnues environ 5 % du temps.",
    },
  }],
]);

export function downloadLicence(city, date) {
  const source = licences.get(city);
  if (!source) return null;
  const { operator, ...licence } = source;
  return {
    ...licence,
    changes: {
      en: `Transit cleaned and derived these tables from ${operator} feeds for the ${date} service day. The data was modified and is unofficial.`,
      fr: `Transit a nettoyé et dérivé ces tables à partir des flux de ${operator} pour la journée de service du ${date}. Les données ont été modifiées et sont non officielles.`,
    },
  };
}

export function downloadReadme(licence, date, version, files) {
  return [
    `Transit | ${date} | Cleaning version / Version du nettoyage ${version}`,
    ...["en", "fr"].map((lang) => [
      licence.attribution[lang], licence.url[lang], licence.changes[lang],
      licence.non_endorsement[lang], licence.limits[lang],
      `${licence.name[lang]} | ${lang === "en" ? "Licence checked" : "Licence vérifiée le"} ${licence.checked_on}`,
      `${lang === "en" ? "Removal requests" : "Demandes de retrait"} | ${licence.contact}`,
    ].join("\n")),
    ["File / Fichier | Bytes / Octets | SHA-256", ...files.map(
      ({ name, byte_size, sha256 }) => `${name} | ${byte_size} | ${sha256}`,
    )].join("\n"),
  ].join("\n\n") + "\n";
}
