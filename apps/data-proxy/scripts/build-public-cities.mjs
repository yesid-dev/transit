import { readdir, readFile, writeFile } from "node:fs/promises";

const directory = new URL("../../db/config/providers/", import.meta.url);
const files = (await readdir(directory)).filter((name) => name.endsWith(".yaml")).sort();
const cities = [];

for (const file of files) {
  const id = file.slice(0, -".yaml".length);
  const declaration = Bun.YAML.parse(await readFile(new URL(file, directory), "utf8"));
  const active = declaration.provider
    ? declaration.provider.is_active === true && declaration.public?.enabled === true
    : declaration.stage === "public";
  if (active) cities.push(id);
}

const defaultCity = (await readFile(new URL("default-city.txt", directory), "utf8")).trim();
if (!cities.includes(defaultCity)) throw new Error("Default city must be a public provider");

await writeFile(new URL("../src/.generated-public-cities.json", import.meta.url), JSON.stringify(cities));
