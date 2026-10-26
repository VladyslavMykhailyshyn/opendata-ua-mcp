import { describe, it, expect } from "vitest";
import { assertPlainQuery, buildFq } from "../../src/ckan/solr.js";

describe("buildFq", () => {
  it("leaves plain slugs unquoted", () => {
    expect(buildFq({ organization: "mvs", category: "ekolohiia" })).toEqual([
      "organization:mvs",
      "groups:ekolohiia",
    ]);
  });

  it("quotes values with spaces and escapes quotes and backslashes", () => {
    expect(buildFq({ tags: ['a" OR *:* OR "b', "back\\slash"] })).toEqual([
      'tags:"a\\" OR *:* OR \\"b"',
      'tags:"back\\\\slash"',
    ]);
  });

  it("cannot be broken out of with a trailing backslash", () => {
    const [fq] = buildFq({ organization: 'x\\"' });
    expect(fq).toBe('organization:"x\\\\\\""');
  });
});

describe("assertPlainQuery", () => {
  it("accepts ordinary and Solr-syntax queries", () => {
    expect(() => assertPlainQuery("викрадені авто")).not.toThrow();
    expect(() => assertPlainQuery("text:(бюджет* AND 2024)")).not.toThrow();
    expect(() => assertPlainQuery(undefined)).not.toThrow();
  });

  it("rejects local params", () => {
    expect(() => assertPlainQuery("{!xmlparser v='<x/>'}")).toThrow("Недопустимі символи");
  });
});
