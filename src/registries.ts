/**
 * Flagship registries — the datasets people come to data.gov.ua for by name
 * (GSC May–Sep 2026: ~24% of search clicks name a registry; the top 50
 * datasets take 40% of dataset clicks). Used two ways:
 *
 * - `find_datasets` pins the registry when a query matches `aliases`, because
 *   portal search misses short names ("ЄДР", "реєстр ФОП", "авто").
 * - Entries with `mirror` are downloaded in full by `dist/sync.js` and indexed
 *   locally, so `lookup_record` can find one record in files of 30 MB–3 GB.
 *   Only top-demand registries are mirrored, with only the columns an answer
 *   needs; the rest stay search pins.
 */

export interface MirrorSpec {
  /** Pick this resource when a dataset holds several (matched on name + URL). */
  resource?: RegExp;
  /** How records are stored inside the (possibly zipped) file. */
  format: "csv" | "xml";
  /** XML element wrapping one record. */
  recordTag?: string;
  /** Code-like columns indexed for exact match (ЄДРПОУ, VIN, case number). */
  exact: string[];
  /** Columns in the full-text index (names, addresses). */
  text: string[];
  /** Rename unreadable source headers. */
  rename?: Record<string, string>;
  /**
   * Columns stored for answers (exact/text columns are always kept). Unset =
   * all. Trims boilerplate like ЄДР's statute text: the mirror holds what a
   * lookup answers, not a copy of the export.
   */
  keep?: string[];
}

export interface RegistryDef {
  key: string;
  title: string;
  /** CKAN dataset id or slug. */
  dataset: string;
  /** Matched against a lower-cased, NFKC-normalized query. */
  aliases: RegExp;
  /** What a lookup in this registry is good for (shown to the model). */
  lookupHint?: string;
  mirror?: MirrorSpec;
}

// Cyrillic-aware word boundary: JS \b only knows ASCII letters.
const W = (word: string) => `(?<!\\p{L})${word}(?!\\p{L})`;
const re = (...parts: string[]) => new RegExp(parts.join("|"), "u");

export const REGISTRIES: RegistryDef[] = [
  {
    key: "edr-uo",
    title: "ЄДР — юридичні особи",
    dataset: "a1799820-195b-4982-8141-6e84f58103e7",
    aliases: re(
      W("(є|е)дрпоу"),
      W("(є|е)др"),
      "^(є|е)дин\\p{L}* державн\\p{L}* реєстр\\p{L}*$",
      "реєстр\\p{L}* юридичн",
      "юридичн\\p{L}* ос(іб|оби)",
    ),
    lookupHint: "компанія за кодом ЄДРПОУ або назвою: стан, керівник, засновники",
    mirror: {
      resource: /(^|\/)uo\.zip$/i,
      format: "xml",
      recordTag: "SUBJECT",
      exact: ["EDRPOU"],
      text: ["NAME", "SHORT_NAME"],
      keep: [
        "OPF",
        "STAN",
        "SIGNERS",
        "FOUNDERS",
        "BENEFICIARIES",
        "AUTHORIZED_CAPITAL",
        "REGISTRATION",
        "TERMINATION_STARTED_INFO",
        "BANKRUPTCY_READJUSTMENT_INFO",
        "TERMINATED_INFO",
      ],
    },
  },
  {
    key: "edr-fop",
    title: "ЄДР — фізичні особи-підприємці",
    dataset: "a1799820-195b-4982-8141-6e84f58103e7",
    aliases: re(W("фоп"), "фізичн\\p{L}* ос\\p{L}*[- ]підприєм"),
    lookupHint: "ФОП за ПІБ: стан, види діяльності, адреса",
    mirror: {
      resource: /(^|\/)fop\.zip$/i,
      format: "xml",
      recordTag: "SUBJECT",
      exact: [],
      text: ["NAME"],
      keep: ["STAN", "ADDRESS", "KVED", "REGISTRATION", "TERMINATED_INFO"],
    },
  },
  {
    key: "vehicles",
    title: "Транспортні засоби та їх власники (реєстраційні операції)",
    dataset: "06779371-308f-42d7-895e-5a39833375f0",
    aliases: re("транспортн\\p{L}* засоб", W("авто"), "автомоб", W("vin"), W("тз")),
    lookupHint: "авто за VIN: марка, модель, рік, реєстраційні операції (останній річний файл)",
    mirror: {
      format: "csv",
      exact: ["VIN"],
      text: ["BRAND", "MODEL"],
      rename: { "CD.OPER_CODE||'-'||CD.OPERAS": "OPERATION" },
      keep: ["OPERATION", "D_REG", "DEP", "MAKE_YEAR", "COLOR", "KIND", "BODY", "FUEL", "CAPACITY"],
    },
  },
  {
    key: "vat-payers",
    title: "Реєстр платників ПДВ",
    dataset: "4c65d66d-1923-4682-980a-9c11ce7ffdfe",
    aliases: re(W("пдв"), "додан\\p{L}* вартіст"),
    lookupHint: "платник ПДВ за ІПН (kod_pdv) або назвою",
    mirror: { format: "csv", exact: ["kod_pdv"], text: ["name"] },
  },
  {
    key: "single-tax",
    title: "Реєстр платників єдиного податку",
    dataset: "198185ea-44d6-48f0-877c-44251c413f64",
    aliases: re("єдин\\p{L}* податк"),
  },
  {
    key: "debtors",
    title: "Єдиний реєстр боржників",
    dataset: "506734bf-2480-448c-a2b4-90b6d06df11e",
    aliases: re("боржник", W("єрб")),
  },
  {
    key: "bankruptcy",
    title: "Відомості про справи про банкрутство",
    dataset: "vidomosti-pro-spravi-pro-bankrutstvo-1",
    aliases: re("банкрутств"),
    lookupHint: "справа про банкрутство за ЄДРПОУ, назвою або номером справи",
    mirror: { format: "csv", exact: ["firm_edrpou", "case_number"], text: ["firm_name"] },
  },
  {
    key: "court-schedule",
    title: "Список справ, призначених до розгляду",
    dataset: "42eaff6e-45da-4426-b4a1-f30989bfd36f",
    aliases: re("призначен\\p{L}* до розгляд", "судов\\p{L}* засідан", "розклад\\p{L}* суд"),
    lookupHint: "засідання за номером справи або учасником: дата, суд, судді",
    mirror: { format: "csv", exact: ["case"], text: ["case_involved", "court_name"] },
  },
  {
    key: "court-status",
    title: "Інформація щодо стану розгляду справ",
    dataset: "7e659fca-90c7-4002-bd96-00f9dbbbd251",
    aliases: re("стан\\p{L}* розгляд\\p{L}* справ"),
  },
  {
    key: "credit-bureaus",
    title: "Єдиний реєстр бюро кредитних історій",
    dataset: "bki-nfp",
    aliases: re("бюро кредитн", W("бкі"), "кредитн\\p{L}* істор"),
  },
  {
    key: "lustration",
    title: "Реєстр осіб, щодо яких застосовано Закон «Про очищення влади»",
    dataset: "8faa71c1-3a54-45e8-8f6e-06c92b1ff8bc",
    aliases: re("очищен\\p{L}* влад", "люстрац"),
  },
  {
    key: "disinfectants",
    title: "Державний реєстр дезінфекційних засобів",
    dataset: "reestr_dezzasobiv_moz",
    aliases: re("дезінфекц"),
  },
  {
    key: "water-use",
    title: "Реєстр дозволів на спеціальне водокористування",
    dataset: "water-use-permits",
    aliases: re("водокористуван", "спецводокорист"),
  },
  {
    key: "admin-offences",
    title: "Інформація про виявлені адміністративні правопорушення",
    dataset: "bcec050d-9a1d-40fa-a0a9-a9b8f20e75b2",
    aliases: re("адміністративн\\p{L}* правопоруш"),
  },
  {
    key: "katottg",
    title: "Кодифікатор адміністративно-територіальних одиниць (КАТОТТГ)",
    dataset: "43c2a113-a032-4c8a-a409-3b5e1660bb38",
    aliases: re("кодифікатор", W("катоттг"), W("коатуу")),
  },
];

export const MIRRORED = REGISTRIES.filter(
  (r): r is RegistryDef & { mirror: MirrorSpec } => r.mirror !== undefined,
);

export function registriesForQuery(query: string): RegistryDef[] {
  const q = query.normalize("NFKC").toLowerCase().trim();
  return REGISTRIES.filter((r) => r.aliases.test(q));
}
