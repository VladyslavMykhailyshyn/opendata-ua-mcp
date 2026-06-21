import { describe, it, expect } from "vitest";
import AdmZip from "adm-zip";
import { pickBestZipEntry } from "../../src/util/zip.js";

function makeZip(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.from(content, "utf-8"));
  }
  return zip.toBuffer();
}

describe("pickBestZipEntry", () => {
  it("picks CSV over PDF inside the archive", () => {
    const buf = makeZip({ "readme.pdf": "x", "data.csv": "a,b\n1,2" });
    const { best, names } = pickBestZipEntry(buf);
    expect(best?.name).toBe("data.csv");
    expect(best?.format).toBe("CSV");
    expect(names).toHaveLength(2);
  });

  it("returns no best when nothing parseable", () => {
    const buf = makeZip({ "a.pdf": "x", "b.docx": "y" });
    const { best, names } = pickBestZipEntry(buf);
    expect(best).toBeUndefined();
    expect(names).toContain("a.pdf");
  });

  it("prefers CSV over XML", () => {
    const buf = makeZip({ "data.xml": "<r/>", "data.csv": "a\n1" });
    expect(pickBestZipEntry(buf).best?.format).toBe("CSV");
  });
});
