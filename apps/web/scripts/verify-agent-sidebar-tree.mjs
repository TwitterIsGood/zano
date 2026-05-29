import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const sidebar = readFileSync(join(__dirname, "..", "src", "components", "sidebar.tsx"), "utf8");

const checks = [
  {
    name: "sidebar defines agent tree nodes",
    pass: sidebar.includes("interface AgentTreeNode") && sidebar.includes("children: AgentTreeNode[]") && sidebar.includes("depth: number"),
  },
  {
    name: "sidebar builds child agents under parent agents",
    pass:
      sidebar.includes("function buildAgentTree(dmChannels: DmChannel[])") &&
      sidebar.includes("childrenByParent") &&
      sidebar.includes("parent_agent_id") &&
      sidebar.includes("byAgentId.has(parentId)"),
  },
  {
    name: "sidebar sorts tree siblings by creation time",
    pass: sidebar.includes("created_at") && sidebar.includes("localeCompare"),
  },
  {
    name: "sidebar renders agent tree recursively",
    pass:
      sidebar.includes("const agentTree = buildAgentTree(dmChannels)") &&
      sidebar.includes("function renderAgentNode") &&
      sidebar.includes("node.children.map(renderAgentNode)") &&
      sidebar.includes("agentTree.map(renderAgentNode)"),
  },
  {
    name: "sidebar visually indents child agents with connector",
    pass:
      sidebar.includes("depth * 18") &&
      sidebar.includes("rounded-bl") &&
      sidebar.includes("border-b") &&
      sidebar.includes("border-l") &&
      sidebar.includes("border-border/70"),
  },
  {
    name: "sidebar preserves child-agent creation reason as title",
    pass: sidebar.includes("creation_reason") && sidebar.includes("Created by parent agent"),
  },
];

const failures = checks.filter((check) => !check.pass);

if (failures.length > 0) {
  console.error("Agent sidebar tree verification failed:");
  for (const failure of failures) {
    console.error(`- ${failure.name}`);
  }
  process.exit(1);
}

console.log(`Agent sidebar tree verification passed (${checks.length} checks).`);
