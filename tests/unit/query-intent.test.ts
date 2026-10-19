import { describe, it, expect } from "vitest";
import { registriesForQuery } from "../../src/registries.js";
import { relaxQuery, wrongDoors } from "../../src/util/query-intent.js";

const keys = (q: string) => registriesForQuery(q).map((r) => r.key);

describe("registriesForQuery (real GSC queries)", () => {
  it.each([
    ["ЄДР", "edr-uo"],
    ["єдиний державний реєстр", "edr-uo"],
    ["пошук за ЄДРПОУ 12345678", "edr-uo"],
    ["єдиний державний реєстр юридичних осіб", "edr-uo"],
    ["реєстр фоп", "edr-fop"],
    ["реєстр платників пдв", "vat-payers"],
    ["реєстр платників єдиного податку", "single-tax"],
    ["data.gov.ua авто", "vehicles"],
    ["бюро кредитних історій", "credit-bureaus"],
    ["дозволи на спецводокористування", "water-use"],
    ["список справ призначених до розгляду", "court-schedule"],
  ])("%s → %s", (q, key) => {
    expect(keys(q)).toContain(key);
  });

  it("does not pin unrelated registries that share words", () => {
    expect(keys("єдиний державний реєстр тварин")).toEqual([]);
    expect(keys("автобусні маршрути")).toEqual([]); // "авто" only as a whole word
    expect(keys("закупівлі громади 2024")).toEqual([]);
  });
});

describe("wrongDoors", () => {
  it("routes services that are not open data", () => {
    expect(wrongDoors("дія вхід").map((d) => d.url)).toEqual(["https://diia.gov.ua"]);
    expect(wrongDoors("реєстр судових рішень")[0]?.url).toBe("https://reyestr.court.gov.ua");
  });

  it("stays quiet for normal data queries", () => {
    expect(wrongDoors("бюджет громади")).toEqual([]);
    expect(wrongDoors("дії поліції")).toEqual([]);
  });
});

describe("relaxQuery", () => {
  it("stems, drops stopwords, tries AND then OR", () => {
    expect(relaxQuery("тролейбуси Полтава")).toEqual([
      "text:(тролейбу* AND полта*)",
      "text:(тролейбу* OR полта*)",
    ]);
    expect(relaxQuery("зарплата по регіонах 2024")).toEqual([
      "text:(зарпла* AND регіон* AND 2024)",
      "text:(зарпла* OR регіон* OR 2024)",
    ]);
  });

  it("keeps short words exact and handles a single word", () => {
    expect(relaxQuery("дані про ціни")).toEqual(["text:(ціни)"]);
    expect(relaxQuery("в на")).toEqual([]);
  });
});
