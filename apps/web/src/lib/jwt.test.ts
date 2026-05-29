import { afterEach, describe, expect, test } from "vitest";
import { createBridgeConnectCredentials } from "./jwt";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("createBridgeConnectCredentials", () => {
  test("uses the service role key for bridge credentials when Supabase provides modern opaque secret keys", () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_self_hosted";
    process.env.SUPABASE_JWT_SECRET = "legacy-secret-that-modern-postgrest-will-not-accept";

    const credentials = createBridgeConnectCredentials({
      userId: "user-1",
      serverId: "server-1",
      agents: [{ id: "agent-1" }],
      expiresInSeconds: 60,
      supabaseAnonKey: "sb_publishable_self_hosted",
    });

    expect(credentials.supabaseKey).toBe("sb_secret_self_hosted");
    expect(credentials.bridgeToken).toBe("sb_secret_self_hosted");
    expect(credentials.agentAuthTokens).toEqual({ "agent-1": "sb_secret_self_hosted" });
  });
});
