import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { downloadCapped, isPrivateAddress } from "../../src/util/safe-fetch.js";
import { ToolError } from "../../src/util/errors.js";

const UA = "test-agent";
const loopback = { allowLoopback: true };

let server: http.Server;
let base: string;
const hanging = new Set<http.ServerResponse>();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    switch (url.pathname) {
      case "/ok":
        res.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
        res.end("a;b\n1;2\n");
        return;
      case "/missing":
        res.writeHead(404);
        res.end("nope");
        return;
      case "/to-private":
        res.writeHead(302, { location: "http://10.0.0.1/secret" });
        res.end();
        return;
      case "/to-ok":
        res.writeHead(301, { location: "/ok" });
        res.end();
        return;
      case "/loop":
        res.writeHead(302, { location: "/loop" });
        res.end();
        return;
      case "/gzip": {
        const body = zlib.gzipSync(Buffer.alloc(1_000_000, 0x61));
        res.writeHead(200, { "content-encoding": "gzip", "content-type": "text/plain" });
        res.end(body);
        return;
      }
      case "/hang":
        hanging.add(res); // never answered
        return;
      default:
        res.writeHead(500);
        res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  for (const res of hanging) res.destroy();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

describe("isPrivateAddress", () => {
  it("flags every internal range", () => {
    for (const ip of [
      "127.0.0.1",
      "127.255.255.254",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:7f00:1",
      "64:ff9b::7f00:1",
      "2002:7f00:1::",
      "not-an-ip",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("passes public addresses", () => {
    for (const ip of [
      "8.8.8.8",
      "172.32.0.1",
      "100.128.0.1",
      "2001:4860:4860::8888",
      "::ffff:8.8.8.8",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});

describe("downloadCapped", () => {
  it("refuses loopback and other private targets unless explicitly allowed", async () => {
    await expect(downloadCapped(`${base}/ok`, 1000, 2000, UA)).rejects.toThrow(
      new ToolError("Недопустима адреса ресурсу."),
    );
    await expect(
      downloadCapped("http://10.0.0.1/x", 1000, 2000, UA, undefined, loopback),
    ).rejects.toThrow("Недопустима адреса ресурсу.");
    await expect(downloadCapped("http://localhost/x", 1000, 2000, UA)).rejects.toThrow(
      "Недопустима адреса ресурсу.",
    );
  });

  it("refuses non-http schemes", async () => {
    for (const url of ["ftp://example.com/x", "file:///etc/passwd", "gopher://x", "not a url"]) {
      await expect(downloadCapped(url, 1000, 2000, UA, undefined, loopback)).rejects.toThrow(
        ToolError,
      );
    }
  });

  it("downloads a body with its content type and final URL", async () => {
    const r = await downloadCapped(`${base}/ok`, 1000, 2000, UA, undefined, loopback);
    expect(r.buffer.toString()).toBe("a;b\n1;2\n");
    expect(r.bytes).toBe(8);
    expect(r.truncated).toBe(false);
    expect(r.contentType).toBe("text/csv; charset=utf-8");
    expect(r.finalUrl).toBe(`${base}/ok`);
  });

  it("follows a redirect and reports the final URL", async () => {
    const r = await downloadCapped(`${base}/to-ok`, 1000, 2000, UA, undefined, loopback);
    expect(r.buffer.toString()).toBe("a;b\n1;2\n");
    expect(r.finalUrl).toBe(`${base}/ok`);
  });

  it("refuses a redirect to a private address", async () => {
    await expect(
      downloadCapped(`${base}/to-private`, 1000, 2000, UA, undefined, loopback),
    ).rejects.toThrow("Недопустима адреса ресурсу.");
  });

  it("stops after five redirects", async () => {
    await expect(
      downloadCapped(`${base}/loop`, 1000, 2000, UA, undefined, loopback),
    ).rejects.toThrow("Забагато перенаправлень.");
  });

  it("turns a non-2xx status into a ToolError", async () => {
    await expect(
      downloadCapped(`${base}/missing`, 1000, 2000, UA, undefined, loopback),
    ).rejects.toThrow(new ToolError("Джерело відповіло HTTP 404."));
  });

  it("caps gzip bodies after decompression", async () => {
    const r = await downloadCapped(`${base}/gzip`, 100_000, 5000, UA, undefined, loopback);
    expect(r.truncated).toBe(true);
    expect(r.bytes).toBe(100_000);
    expect(r.buffer.length).toBe(100_000);
    expect(r.buffer[0]).toBe(0x61);
  });

  it("returns an uncapped gzip body in full", async () => {
    const r = await downloadCapped(`${base}/gzip`, 2_000_000, 5000, UA, undefined, loopback);
    expect(r.truncated).toBe(false);
    expect(r.bytes).toBe(1_000_000);
  });

  it("aborts on timeout with an AbortError", async () => {
    const started = Date.now();
    await expect(
      downloadCapped(`${base}/hang`, 1000, 200, UA, undefined, loopback),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("aborts on the caller's signal", async () => {
    const ac = new AbortController();
    const p = downloadCapped(`${base}/hang`, 1000, 10_000, UA, ac.signal, loopback);
    setTimeout(() => ac.abort(), 50);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});
