import { afterEach, describe, expect, it, vi } from "vitest";
import { SonosAuth, type Store } from "../src/sonos";

function memoryStore(): Store & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async (key, value) => void data.set(key, value),
    delete: async (key) => void data.delete(key),
  };
}

const settings = { clientId: "key", clientSecret: "secret", apiBase: "https://api.test", authBase: "https://auth.test" };

function answer(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

afterEach(() => vi.unstubAllGlobals());

describe("SonosAuth.exchangeCode", () => {
  it("saves the tokens Sonos returns", async () => {
    answer(200, { access_token: "a", refresh_token: "r", expires_in: 86400 });
    const store = memoryStore();
    await new SonosAuth(settings, store, () => 0).exchangeCode("code", "https://x/oauth/callback");
    expect(store.data.get("tokens")).toEqual({ accessToken: "a", refreshToken: "r", expiresAt: 86_400_000 });
  });

  it("names the Secret when Sonos gives only a bare invalid_request", async () => {
    // What Sonos really answers for a wrong Key or Secret: no description at all.
    answer(400, { error: "invalid_request" });
    const auth = new SonosAuth(settings, memoryStore());
    await expect(auth.exchangeCode("code", "https://x/oauth/callback")).rejects.toThrow(/SONOS_CLIENT_SECRET/);
  });

  it("passes on Sonos's own description when it gives one", async () => {
    answer(400, { error: "invalid_grant", error_description: "Invalid authorization code" });
    const auth = new SonosAuth(settings, memoryStore());
    await expect(auth.exchangeCode("code", "https://x/oauth/callback")).rejects.toThrow("Sonos sign-in failed: Invalid authorization code");
  });
});
