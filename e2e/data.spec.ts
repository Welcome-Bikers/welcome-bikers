import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

type CountrySnapshot = {
  title: string;
  iso: string;
  flag: string;
};

test("country snapshot uses valid ISO flag codes", async () => {
  const file = path.resolve(process.cwd(), "public/data/countries.json");
  const countries = JSON.parse(await readFile(file, "utf8")) as CountrySnapshot[];

  for (const country of countries) {
    expect(country.iso, country.title).toMatch(/^[a-z]{2}$/);
    expect(country.flag, country.title).toContain(`/4x3/${country.iso}.svg`);
  }
});
