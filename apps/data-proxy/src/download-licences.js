export function downloadLicence(provider, date) {
  const licence = provider.download_licence;
  const languages = ["en", "fr"];
  const fields = ["name", "attribution", "url", "limits", "non_endorsement", "source"];
  if (!licence || !/^\d{4}-\d{2}-\d{2}$/.test(licence.checked_on) ||
      !fields.every((field) => languages.every(
        (lang) => typeof licence[field]?.[lang] === "string" && licence[field][lang].trim(),
      ))) return null;
  const { en, fr } = licence.source;
  const localized = ({ en, fr }) => ({ en, fr });
  return {
    checked_on: licence.checked_on,
    contact: "contact@yesid.dev",
    non_endorsement: localized(licence.non_endorsement),
    name: localized(licence.name),
    attribution: localized(licence.attribution),
    url: localized(licence.url),
    limits: localized(licence.limits),
    changes: {
      en: `Transit cleaned and derived these tables from ${en} feeds for the ${date} service day. The data was modified and is unofficial.`,
      fr: `Transit a nettoyé et dérivé ces tables à partir des flux ${fr} pour la journée de service du ${date}. Les données ont été modifiées et sont non officielles.`,
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
