import { vi } from "vitest";
import type { Request, Response } from "express";

export function makeHandle(
  proxy: { handleRequest: HandleRequest },
  mockAxiosGet: MockAxiosGet,
) {
  return async (
    path: string,
    data: unknown,
    status = 200,
  ): Promise<Response> => {
    mockAxiosGet.mockResolvedValue({ status, data, headers: {} });
    const res = makeRes();
    await proxy.handleRequest(makeReq(path), res);
    return res;
  };
}

type HandleRequest = (req: Request, res: Response) => Promise<void>;
type MockAxiosGet = { mockResolvedValue: (val: unknown) => void };

export function makeReq(
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Request {
  return { path, url: path, headers, method } as unknown as Request;
}

export function makeRes(): Response {
  const res = { headersSent: false } as Record<string, unknown>;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  res.end = vi.fn().mockReturnValue(res);
  res.type = vi.fn().mockReturnValue(res);
  res.set = vi.fn().mockReturnValue(res);
  res.setHeader = vi.fn().mockReturnValue(res);
  res.redirect = vi.fn().mockReturnValue(res);
  return res as unknown as Response;
}

export function responseBody(res: Response): Record<string, unknown> {
  return vi.mocked(res.json).mock.calls[0][0] as Record<string, unknown>;
}
