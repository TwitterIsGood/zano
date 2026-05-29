import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = join(__dirname, "..");

const memberDetail = readFileSync(join(webRoot, "src", "components", "member-detail-page.tsx"), "utf8");
const settingsPanel = readFileSync(join(webRoot, "src", "components", "agent-settings-panel.tsx"), "utf8");
const activityTab = readFileSync(join(webRoot, "src", "components", "member-activity-tab.tsx"), "utf8");

const provenanceFields = ["created_by_type", "created_by_id", "parent_agent_id", "creation_reason", "generation"];

const checks = [
  {
    name: "member detail defines provenance display model",
    pass: memberDetail.includes("interface AgentProvenanceInfo") && provenanceFields.every((field) => memberDetail.includes(`${field}:`)),
  },
  {
    name: "member detail renders agent provenance block",
    pass:
      memberDetail.includes("Provenance") &&
      memberDetail.includes("Created by:") &&
      memberDetail.includes("Parent agent:") &&
      memberDetail.includes("Reason:") &&
      memberDetail.includes("Generation:") &&
      memberDetail.includes("agentProvenance"),
  },
  {
    name: "settings panel defines provenance display model",
    pass: settingsPanel.includes("interface AgentProvenanceInfo") && provenanceFields.every((field) => settingsPanel.includes(`${field}:`)),
  },
  {
    name: "settings panel renders agent provenance block",
    pass:
      settingsPanel.includes("Provenance") &&
      settingsPanel.includes("Created by:") &&
      settingsPanel.includes("Parent agent:") &&
      settingsPanel.includes("Reason:") &&
      settingsPanel.includes("Generation:") &&
      settingsPanel.includes("provenanceInfo"),
  },
  {
    name: "activity tab labels agent-created children distinctly",
    pass:
      activityTab.includes('event.event_type === "agent.created"') &&
      activityTab.includes('event.metadata?.creation_source === "agent"') &&
      activityTab.includes("Created child agent"),
  },
];

const failures = checks.filter((check) => !check.pass);

if (failures.length > 0) {
  console.error("Agent provenance UI verification failed:");
  for (const failure of failures) {
    console.error(`- ${failure.name}`);
  }
  process.exit(1);
}

console.log(`Agent provenance UI verification passed (${checks.length} checks).`);
