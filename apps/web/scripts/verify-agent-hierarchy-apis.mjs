import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = join(__dirname, "..");

const sidebarRoute = readFileSync(join(webRoot, "src", "app", "api", "sidebar", "route.ts"), "utf8");
const agentsRoute = readFileSync(join(webRoot, "src", "app", "api", "agents", "route.ts"), "utf8");
const agentDetailRoute = readFileSync(join(webRoot, "src", "app", "api", "agents", "[id]", "route.ts"), "utf8");
const sidebarComponent = readFileSync(join(webRoot, "src", "components", "sidebar.tsx"), "utf8");

const hierarchyFields = [
  "created_by_id",
  "created_by_type",
  "parent_agent_id",
  "root_agent_id",
  "creation_source",
  "creation_reason",
  "creation_context",
  "provenance",
  "generation",
  "archived_at",
];

const agentSelectFields = [
  "id",
  "name",
  "display_name",
  "status",
  "description",
  "server_id",
  "owner_id",
  ...hierarchyFields,
  "created_at",
];

const detailSelectFields = [
  "id",
  "name",
  "display_name",
  "description",
  "system_prompt",
  "status",
  "owner_id",
  "server_id",
  ...hierarchyFields,
  "created_at",
];

function agentSelect(source) {
  return source.match(/from\("agents"\)[\s\S]*?\.select\("([^"]*)"\)/)?.[1] ?? "";
}

function hasAgentSelect(source, fields) {
  const selected = agentSelect(source);
  return fields.every((field) => selected.split(",").includes(field));
}

const checks = [
  {
    name: "sidebar API returns current active agent hierarchy fields",
    pass:
      !/from\("agents"\)\.select\("\*"\)/.test(sidebarRoute) &&
      hasAgentSelect(sidebarRoute, agentSelectFields) &&
      !agentSelect(sidebarRoute).includes("avatar_url") &&
      sidebarRoute.includes('.eq("server_id", serverId)') &&
      sidebarRoute.includes('.is("archived_at", null)'),
  },
  {
    name: "agent creation verifies human server membership before service-role writes",
    pass:
      agentsRoute.includes('.from("server_members")') &&
      agentsRoute.includes('.eq("server_id", server_id)') &&
      agentsRoute.includes('.eq("member_id", user.id)') &&
      agentsRoute.includes('.eq("member_type", "human")') &&
      agentsRoute.includes("currentMembership") &&
      agentsRoute.includes("Forbidden"),
  },
  {
    name: "human-created agents store hierarchy provenance",
    pass:
      agentsRoute.includes("created_by_id: user.id") &&
      agentsRoute.includes('created_by_type: "human"') &&
      agentsRoute.includes("parent_agent_id: null") &&
      agentsRoute.includes('creation_source: "human"') &&
      agentsRoute.includes("creation_reason: null") &&
      agentsRoute.includes("creation_context: {}") &&
      agentsRoute.includes('provenance: { created_by_type: "human", created_by_id: user.id }') &&
      agentsRoute.includes("generation: 0"),
  },
  {
    name: "agent.created activity records hierarchy metadata",
    pass:
      agentsRoute.includes('created_by_type: "human"') &&
      agentsRoute.includes("created_by_id: userId") &&
      agentsRoute.includes("parent_agent_id: null"),
  },
  {
    name: "agent detail API returns hierarchy fields explicitly",
    pass:
      !/from\("agents"\)[\s\S]*\.select\("\*"\)/.test(agentDetailRoute) &&
      hasAgentSelect(agentDetailRoute, detailSelectFields),
  },
  {
    name: "sidebar Agent type includes hierarchy fields",
    pass: hierarchyFields.every((field) => sidebarComponent.includes(`${field}:`)) && sidebarComponent.includes("created_at: string"),
  },
];

const failures = checks.filter((check) => !check.pass);

if (failures.length > 0) {
  console.error("Agent hierarchy API verification failed:");
  for (const failure of failures) {
    console.error(`- ${failure.name}`);
  }
  process.exit(1);
}

console.log(`Agent hierarchy API verification passed (${checks.length} checks).`);
