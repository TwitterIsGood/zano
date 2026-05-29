import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export interface CliTransportMaterializerOptions {
  rootDir: string;
  agentsDir?: string;
  nodePath: string;
}

export interface CliTransportCredentialProxyInput {
  proxyUrl: string;
  proxyToken: string;
  activeCapabilities: readonly string[];
}

export interface CliTransportInput {
  agentId: string;
  cliEntrypoint: string;
  mode: "node" | "tsx";
  launchId: string;
  serverUrl: string;
  supabaseKey?: string;
  agentToken?: string;
  credentialProxy?: CliTransportCredentialProxyInput;
}

export interface CliTransportResult {
  wrapperPath: string;
  wrapperHash: string;
  body: string;
  tokenFilePath: string | null;
  proxyTokenFilePath: string | null;
  supabaseKeyFilePath: string | null;
  pathDir: string;
}

const SAFE_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;
const requireFromBridgeModule = createRequire(import.meta.url);
const TSX_IMPORT_URL = pathToFileURL(requireFromBridgeModule.resolve("tsx")).href;

function assertSafePathSegment(label: string, value: string): void {
  if (!SAFE_PATH_SEGMENT_PATTERN.test(value)) {
    throw new Error(`Unsafe CLI transport path segment: ${label}`);
  }
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function atomicWrite(path: string, body: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tempPath, body, { mode });
    chmodSync(tempPath, mode);
    renameSync(tempPath, path);
    chmodSync(path, mode);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function buildCommand(input: CliTransportInput, nodePath: string): string {
  if (input.mode === "node") {
    return `exec ${shellQuote(nodePath)} ${shellQuote(input.cliEntrypoint)} "$@"`;
  }

  return `exec ${shellQuote(nodePath)} --import ${shellQuote(TSX_IMPORT_URL)} ${shellQuote(input.cliEntrypoint)} "$@"`;
}

export class CliTransportMaterializer {
  constructor(private readonly options: CliTransportMaterializerOptions) {}

  materialize(input: CliTransportInput): CliTransportResult {
    assertSafePathSegment("agentId", input.agentId);
    assertSafePathSegment("launchId", input.launchId);

    const agentBaseDir = this.options.agentsDir ?? join(this.options.rootDir, "agents");
    const agentDir = join(agentBaseDir, input.agentId);
    const zanoDir = join(agentDir, ".zano");
    mkdirSync(zanoDir, { recursive: true });

    const wrapperPath = join(zanoDir, "zano");
    const localStatePath = join(zanoDir, "state.json");
    const directTokenPath = join(zanoDir, "agent-token");
    const supabaseKeyPath = join(zanoDir, "supabase-key");
    const hasProxy = input.credentialProxy !== undefined;
    const tokenFilePath = !hasProxy && input.agentToken ? directTokenPath : null;
    const proxyTokenFilePath = hasProxy
      ? join(this.options.rootDir, "agent-proxy-tokens", input.agentId, `${input.launchId}.token`)
      : null;
    const supabaseKeyFilePath = input.supabaseKey ? supabaseKeyPath : null;

    if (tokenFilePath) {
      atomicWrite(tokenFilePath, input.agentToken!, 0o600);
    }

    if (supabaseKeyFilePath) {
      atomicWrite(supabaseKeyFilePath, input.supabaseKey!, 0o600);
    }

    if (proxyTokenFilePath && input.credentialProxy) {
      rmSync(directTokenPath, { force: true });
      atomicWrite(proxyTokenFilePath, input.credentialProxy.proxyToken, 0o600);
    }

    const exports = [
      ["ZANO_HOME", zanoDir],
      ["ZANO_AGENT_ID", input.agentId],
      ["ZANO_AGENT_LAUNCH_ID", input.launchId],
      ["ZANO_SERVER_URL", input.serverUrl],
      ["ZANO_AGENT_LOCAL_STATE", localStatePath],
      ...(tokenFilePath ? [["ZANO_AGENT_TOKEN_FILE", tokenFilePath]] : []),
      ...(supabaseKeyFilePath ? [["ZANO_SUPABASE_KEY_FILE", supabaseKeyFilePath]] : []),
      ...(input.credentialProxy ? [["ZANO_AGENT_PROXY_URL", input.credentialProxy.proxyUrl]] : []),
      ...(proxyTokenFilePath ? [["ZANO_AGENT_PROXY_TOKEN_FILE", proxyTokenFilePath]] : []),
      ...(input.credentialProxy?.activeCapabilities.length
        ? [["ZANO_AGENT_ACTIVE_CAPABILITIES", JSON.stringify(input.credentialProxy.activeCapabilities)]]
        : []),
    ] as Array<[string, string]>;

    const body = [
      "#!/usr/bin/env bash",
      ...exports.map(([key, value]) => `export ${key}=${shellQuote(value)}`),
      buildCommand(input, this.options.nodePath),
      "",
    ].join("\n");

    atomicWrite(wrapperPath, body, 0o755);
    return {
      wrapperPath,
      wrapperHash: createHash("sha256").update(body).digest("hex"),
      body,
      tokenFilePath,
      proxyTokenFilePath,
      supabaseKeyFilePath,
      pathDir: zanoDir,
    };
  }
}
