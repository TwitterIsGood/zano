import { createHmac } from "crypto";

export type ActorJwtType = "human" | "agent" | "system";

export interface ActorJwtOptions {
  actorId: string;
  actorType: ActorJwtType;
  expiresInSeconds?: number;
  machineKeyId?: string;
  ownerId?: string;
  scope?: string;
  serverId?: string;
  systemActor?: string;
}

/**
 * Sign a minimal Supabase-compatible JWT using HMAC-SHA256.
 * This produces a token that auth.uid() in RLS policies will recognize.
 */
export function signOmniJwt(userId: string, serverId: string, expiresInSeconds = 7 * 24 * 3600): string {
  return signActorJwt({
    actorId: userId,
    actorType: "human",
    expiresInSeconds,
    scope: "bridge",
    serverId,
  });
}

/**
 * Sign an actor-scoped JWT for autonomous Zano actors.
 *
 * Supabase RLS still reads auth.uid() from the `sub` claim, while Zano-specific
 * policies can read actor metadata from custom claims.
 */
export function signActorJwt(options: ActorJwtOptions): string {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    throw new Error("Missing SUPABASE_JWT_SECRET env var");
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresInSeconds = options.expiresInSeconds ?? 7 * 24 * 3600;

  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub: options.actorId,
    role: "authenticated",
    aud: "authenticated",
    iss: "supabase",
    iat: now,
    exp: now + expiresInSeconds,
    actor_id: options.actorId,
    actor_type: options.actorType,
    ...(options.machineKeyId ? { machine_key_id: options.machineKeyId } : {}),
    ...(options.ownerId ? { owner_id: options.ownerId } : {}),
    ...(options.scope ? { scope: options.scope } : {}),
    ...(options.serverId ? { server_id: options.serverId } : {}),
    ...(options.systemActor ? { system_actor: options.systemActor } : {}),
  };

  const segments = [
    base64url(JSON.stringify(header)),
    base64url(JSON.stringify(payload)),
  ];

  const signingInput = segments.join(".");
  const signature = createHmac("sha256", secret)
    .update(signingInput)
    .digest("base64url");

  return `${signingInput}.${signature}`;
}

export function signAgentJwt(options: {
  agentId: string;
  ownerId: string;
  serverId: string;
  machineKeyId: string;
  expiresInSeconds?: number;
}): string {
  return signActorJwt({
    actorId: options.agentId,
    actorType: "agent",
    expiresInSeconds: options.expiresInSeconds,
    machineKeyId: options.machineKeyId,
    ownerId: options.ownerId,
    scope: "agent",
    serverId: options.serverId,
  });
}

export function createOmniConnectCredentials(input: {
  userId: string;
  serverId: string;
  agents: Array<{ id: string }>;
  expiresInSeconds: number;
  machineKeyId?: string;
  supabaseAnonKey: string;
}): {
  supabaseKey: string;
  omniToken: string;
  agentAuthTokens: Record<string, string>;
} {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (serviceRoleKey?.startsWith("sb_secret_")) {
    return {
      supabaseKey: serviceRoleKey,
      omniToken: serviceRoleKey,
      agentAuthTokens: Object.fromEntries(input.agents.map((agent) => [agent.id, serviceRoleKey])),
    };
  }

  return {
    supabaseKey: input.supabaseAnonKey,
    omniToken: signOmniJwt(input.userId, input.serverId, input.expiresInSeconds),
    agentAuthTokens: Object.fromEntries(
      input.agents.map((agent) => [
        agent.id,
        signAgentJwt({
          agentId: agent.id,
          ownerId: input.userId,
          serverId: input.serverId,
          machineKeyId: input.machineKeyId ?? "",
          expiresInSeconds: input.expiresInSeconds,
        }),
      ])
    ),
  };
}

function base64url(str: string): string {
  return Buffer.from(str, "utf-8").toString("base64url");
}
