import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";
import { RegistryProxy } from "./base.ts";
import { makeHandle, makeReq, makeRes } from "./test-helpers.ts";

vi.mock("axios", () => ({
  default: { get: vi.fn() },
}));

import axios from "axios";
const mockedGet = vi.mocked(axios.get);

// Minimal concrete implementation for testing the base class
class TestProxy extends RegistryProxy {
  readonly name = "test";

  override async handleRequest(req: Request, res: Response): Promise<void> {
    const upstreamBase = new URL(this.config.upstream);
    const reqUrl = new URL(req.url, upstreamBase);
    const upstreamUrl = `${upstreamBase.origin}${reqUrl.pathname}${reqUrl.search}`;
    try {
      if (!req.path.includes("/tarball/")) {
        const response = await axios.get<unknown>(upstreamUrl, {
          validateStatus: () => true,
          maxRedirects: 0,
        });
        if (response.status !== 200) {
          res.status(response.status).json(response.data);
          return;
        }
        res.status(200).json(response.data);
      } else {
        await this.handlePassthrough(req, res);
      }
    } catch (err) {
      if (!res.headersSent) {
        res.status(502).json({ error: "Bad Gateway", message: String(err) });
      }
    }
  }
}

const proxy = new TestProxy({
  upstream: "https://upstream.example.com",
  delayMs: 0,
});

const handle = makeHandle(proxy, mockedGet);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RegistryProxy.handleRequest – metadata requests", () => {
  it("fetches upstream metadata and returns filtered result on 200", async () => {
    const data = { name: "pkg", versions: {}, time: {}, "dist-tags": {} };
    const res = await handle("/pkg", data, 200);

    expect(mockedGet).toHaveBeenCalledWith(
      "https://upstream.example.com/pkg",
      expect.objectContaining({ validateStatus: expect.any(Function) }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(data);
  });

  it("proxies non-200 status codes without filtering", async () => {
    const data = { error: "not_found", reason: "document not found" };
    const res = await handle("/nonexistent", data, 404);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(data);
  });

  it("returns 502 Bad Gateway when upstream request throws", async () => {
    mockedGet.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = makeRes();
    await proxy.handleRequest(makeReq("/pkg"), res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "Bad Gateway" }),
    );
  });

  it("does not double-respond when headers are already sent on error", async () => {
    mockedGet.mockRejectedValue(new Error("network error"));

    const res = makeRes();
    (res as unknown as Record<string, unknown>).headersSent = true;

    await proxy.handleRequest(makeReq("/pkg"), res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
  });
});

describe("RegistryProxy.handleRequest – passthrough requests", () => {
  it("redirects to the upstream URL with 302", async () => {
    const res = makeRes();
    await proxy.handleRequest(makeReq("/pkg/tarball/pkg-1.0.0.tgz"), res);

    expect(res.redirect).toHaveBeenCalledWith(
      302,
      "https://upstream.example.com/pkg/tarball/pkg-1.0.0.tgz",
    );
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("preserves query string in redirect URL", async () => {
    const res = makeRes();
    await proxy.handleRequest(
      makeReq("/pkg/tarball/pkg-1.0.0.tgz?foo=bar"),
      res,
    );

    expect(res.redirect).toHaveBeenCalledWith(
      302,
      "https://upstream.example.com/pkg/tarball/pkg-1.0.0.tgz?foo=bar",
    );
  });
});

describe("RegistryProxy.handleRequest – header forwarding", () => {
  it("does not forward request headers to upstream", async () => {
    const data = { name: "pkg", versions: {}, time: {}, "dist-tags": {} };
    mockedGet.mockResolvedValue({ status: 200, data, headers: {} });

    const req = makeReq("/pkg", {
      accept: "application/vnd.npm.install-v1+json",
      "accept-encoding": "gzip",
      authorization: "Bearer secret-token",
      "x-custom-header": "should-not-forward",
    });

    await proxy.handleRequest(req, makeRes());

    const forwardedHeaders = mockedGet.mock.calls[0][1]?.headers as
      | Record<string, string>
      | undefined;
    expect(forwardedHeaders).toBeUndefined();
  });
});
