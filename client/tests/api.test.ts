import { test, expect, describe, beforeEach, afterEach } from "bun:test";

// In-memory localStorage stub so CSRF storage has no disk side-effects.
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  },
});

const { api, ApiError, errorMessage, setCsrfToken, getCsrfToken } = await import("../src/config/api");

type Captured = { url: string; init: RequestInit };
let captured: Captured | null = null;
const realFetch = globalThis.fetch;

function mockFetch(body: unknown, status = 200, contentType = "application/json") {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured = { url, init };
    if (status === 204) return new Response(null, { status: 204 });
    const payload = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(payload, { status, headers: { "Content-Type": contentType } });
  }) as typeof fetch;
}

beforeEach(() => {
  store.clear();
  captured = null;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("api client", () => {
  test("POST sends JSON body, CSRF header, and same-origin credentials", async () => {
    setCsrfToken("tok-123");
    expect(getCsrfToken()).toBe("tok-123");
    mockFetch({ ok: true });
    const res = await api.post<{ ok: boolean }>("/x", { json: { a: 1 } });
    expect(res).toEqual({ ok: true });
    expect(captured!.init.method).toBe("POST");
    expect(captured!.init.credentials).toBe("same-origin");
    const headers = captured!.init.headers as Headers;
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-CSRF-Token")).toBe("tok-123");
    expect(captured!.init.body).toBe(JSON.stringify({ a: 1 }));
  });

  test("GET is not given a CSRF header", async () => {
    setCsrfToken("tok");
    mockFetch([1, 2, 3]);
    const res = await api.get<number[]>("/y", { query: { p: 1, skip: undefined } });
    expect(res).toEqual([1, 2, 3]);
    expect(captured!.url).toBe("/y?p=1");
    const headers = captured!.init.headers as Headers;
    expect(headers.get("X-CSRF-Token")).toBeNull();
  });

  test("204 returns undefined", async () => {
    mockFetch(null, 204);
    const res = await api.delete("/z");
    expect(res).toBeUndefined();
  });

  test("non-ok throws ApiError carrying detail", async () => {
    mockFetch({ detail: "nope" }, 404);
    try {
      await api.get("/missing");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).status).toBe(404);
      expect((err as ApiError).detail).toBe("nope");
    }
  });

  test("object detail (chunk incomplete) is preserved", async () => {
    mockFetch({ detail: { error: "incomplete", missing: [1, 2] } }, 409);
    try {
      await api.post("/files/upload/finalize", { json: {} });
    } catch (err) {
      expect((err as ApiError).status).toBe(409);
      expect((err as ApiError).detail).toEqual({ error: "incomplete", missing: [1, 2] });
    }
  });
});

describe("errorMessage", () => {
  test("string detail", () => {
    expect(errorMessage(new ApiError(401, "bad creds"))).toBe("bad creds");
  });
  test("object detail with error field", () => {
    expect(errorMessage(new ApiError(409, { error: "username taken" }))).toBe("username taken");
  });
  test("plain Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });
  test("unknown", () => {
    expect(errorMessage(42)).toBe("Something went wrong.");
  });
});
