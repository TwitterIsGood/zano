import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = join(__dirname, "..");

const agentDetailRoute = readFileSync(join(webRoot, "src", "app", "api", "agents", "[id]", "route.ts"), "utf8");
const settingsPanel = readFileSync(join(webRoot, "src", "components", "agent-settings-panel.tsx"), "utf8");
const sidebar = readFileSync(join(webRoot, "src", "components", "sidebar.tsx"), "utf8");
const serverLayout = readFileSync(join(webRoot, "src", "app", "s", "[slug]", "layout.tsx"), "utf8");
const messageArea = readFileSync(join(webRoot, "src", "components", "message-area.tsx"), "utf8");
const dmPage = readFileSync(join(webRoot, "src", "app", "s", "[slug]", "dm", "[channelId]", "page.tsx"), "utf8");
const resetRoute = readFileSync(join(webRoot, "src", "app", "api", "agents", "[id]", "reset", "route.ts"), "utf8");
const agentsRoute = readFileSync(join(webRoot, "src", "app", "api", "agents", "route.ts"), "utf8");
const createChannelDialog = readFileSync(join(webRoot, "src", "components", "create-channel-dialog.tsx"), "utf8");
const editChannelDialog = readFileSync(join(webRoot, "src", "components", "edit-channel-dialog.tsx"), "utf8");
const autonomousPage = readFileSync(join(webRoot, "src", "app", "s", "[slug]", "autonomous", "page.tsx"), "utf8");

const patchRoute = agentDetailRoute.split("// DELETE /api/agents/[id]")[0].split("export async function PATCH")[1] ?? "";
const deleteRoute = agentDetailRoute.split("export async function DELETE")[1] ?? "";
const deleteAgentDeleteIndex = deleteRoute.search(/from\("agents"\)[\s\S]*?\.delete\(/);
const deleteMessagesDeleteIndex = deleteRoute.search(/from\("messages"\)[\s\S]*?\.delete\(/);
const resetChildRejectIndex = resetRoute.indexOf("Cannot reset child agent");
const resetMessagesDeleteIndex = resetRoute.search(/from\("messages"\)[\s\S]*?\.delete\(/);

const checks = [
  {
    name: "agent detail API exposes PATCH handler for archive-only updates",
    pass:
      agentDetailRoute.includes("export async function PATCH") &&
      patchRoute.includes("patchBody.archived !== true") &&
      patchRoute.includes("archived_at: new Date().toISOString()") &&
      patchRoute.includes('status: "offline"'),
  },
  {
    name: "agent detail PATCH keeps existing ownership boundary and rejects unsupported bodies",
    pass:
      patchRoute.includes('.eq("id", id)') &&
      patchRoute.includes('.eq("owner_id", user.id)') &&
      patchRoute.includes("parent_agent_id") &&
      patchRoute.includes("Cannot archive root agent") &&
      patchRoute.includes('.eq("parent_agent_id", id)') &&
      patchRoute.includes("Archive child agents first") &&
      patchRoute.includes("Unsupported PATCH body") &&
      patchRoute.includes("try {") &&
      patchRoute.includes("await request.json()") &&
      patchRoute.includes("Array.isArray") &&
      !/from\("messages"\)[\s\S]*?\.delete\(/.test(patchRoute) &&
      !/from\("channels"\)[\s\S]*?\.delete\(/.test(patchRoute) &&
      !/from\("channel_members"\)[\s\S]*?\.delete\(/.test(patchRoute) &&
      !/from\("tasks"\)[\s\S]*?\.delete\(/.test(patchRoute),
  },
  {
    name: "settings panel loads archived child-agent state",
    pass:
      settingsPanel.includes("archived_at: string | null") &&
      settingsPanel.includes("const isChildAgent = Boolean(provenanceInfo?.parent_agent_id)") &&
      settingsPanel.includes("const canArchiveChildAgent = Boolean(isChildAgent && !archivedAt)") &&
      settingsPanel.includes("archived_at"),
  },
  {
    name: "settings panel renders child-only archive action",
    pass:
      settingsPanel.includes("Archive child agent") &&
      settingsPanel.includes("canArchiveChildAgent") &&
      settingsPanel.includes("parent_agent_id") &&
      settingsPanel.includes("!archivedAt"),
  },
  {
    name: "settings panel hides destructive reset/delete actions for child agents",
    pass:
      settingsPanel.includes("const isChildAgent = Boolean(provenanceInfo?.parent_agent_id)") &&
      settingsPanel.includes("!isChildAgent ? (") &&
      settingsPanel.includes("Reset Conversation") &&
      settingsPanel.includes("Delete Agent") &&
      settingsPanel.includes("This will permanently delete the agent and all conversation history"),
  },
  {
    name: "settings panel archives through PATCH and refreshes local agent data",
    pass:
      settingsPanel.includes("handleArchive") &&
      settingsPanel.includes("method: 'PATCH'") &&
      settingsPanel.includes("archived: true") &&
      settingsPanel.includes("await loadAgent()") &&
      settingsPanel.includes("onUpdated({") &&
      settingsPanel.includes("Failed to archive"),
  },
  {
    name: "agent detail DELETE blocks child hard-delete and uses atomic DB cleanup",
    pass:
      deleteRoute.includes("parent_agent_id") &&
      deleteRoute.includes("Cannot delete child agent") &&
      deleteRoute.includes("Archive child agents instead") &&
      deleteRoute.includes('.eq("parent_agent_id", id)') &&
      !deleteRoute.includes('.is("archived_at", null)') &&
      deleteRoute.includes('.rpc("delete_root_agent"') &&
      !/from\("agents"\)[\s\S]*?\.delete\(/.test(deleteRoute) &&
      !/from\("messages"\)[\s\S]*?\.delete\(/.test(deleteRoute) &&
      !/from\("channels"\)[\s\S]*?\.delete\(/.test(deleteRoute) &&
      !/from\("channel_members"\)[\s\S]*?\.delete\(/.test(deleteRoute),
  },
  {
    name: "agent reset blocks child-agent history deletion",
    pass:
      resetRoute.includes("parent_agent_id") &&
      resetRoute.includes("Cannot reset child agent") &&
      resetRoute.includes("Archive child agents instead") &&
      resetChildRejectIndex !== -1 &&
      resetMessagesDeleteIndex !== -1 &&
      resetChildRejectIndex < resetMessagesDeleteIndex &&
      resetRoute.includes('select("id, type, name")') &&
      resetRoute.includes('ch.name === `dm-${id}`') &&
      resetRoute.includes('.eq("member_type", "agent")') &&
      resetRoute.includes('(agentMembers ?? []).length === 1') &&
      resetRoute.includes('agentMembers?.[0]?.member_id === id'),
  },
  {
    name: "generic and autonomous agent lists/selectors exclude archived agents",
    pass:
      agentsRoute.includes('.is("archived_at", null)') &&
      createChannelDialog.includes('.is("archived_at", null)') &&
      editChannelDialog.includes('.is("archived_at", null)') &&
      autonomousPage.includes('.is("archived_at", null)'),
  },
  {
    name: "sidebar removes archived agent DMs instead of rendering ghosts",
    pass:
      sidebar.includes("function agentIdFromDmChannelName") &&
      sidebar.includes("const agentMembers = dmMembers.filter((member) => member.channel_id === ch.id)") &&
      sidebar.includes("const targetAgentId = agentIdFromDmChannelName(ch.name)") &&
      sidebar.includes("targetAgentId ? agentMembers.find((member) => member.member_id === targetAgentId) : agentMembers[0]") &&
      sidebar.includes("if (agentMember && (!agent || agent.archived_at)) continue;") &&
      serverLayout.includes('.is("archived_at", null)') &&
      sidebar.includes("if (updated.archived_at)") &&
      sidebar.includes("prev.filter((agent) => agent.id !== updated.id)") &&
      sidebar.includes("prev.filter((dm) => dm.agent?.id !== updated.id)"),
  },
  {
    name: "message area does not rehydrate archived DM agents",
    pass:
      messageArea.includes("archived_at: string | null") &&
      messageArea.includes("id, name, display_name, status, description, archived_at") &&
      messageArea.includes(".is('archived_at', null)") &&
      messageArea.includes("function agentIdFromDmChannelName") &&
      messageArea.includes("function getDmTargetAgent") &&
      messageArea.includes("if (!channel.name) return null") &&
      messageArea.includes("const activeAgents = (agentsData ?? []) as AgentInfo[]") &&
      messageArea.includes("const targetAgentId = agentIdFromDmChannelName(channel.name)") &&
      messageArea.includes("return agents.find((agent) => agent.id === targetAgentId) ?? null") &&
      messageArea.includes("const dmAgent = getDmTargetAgent(channel, activeAgents)") &&
      messageArea.includes("setChannelAgents(dmAgent ? new Map([[dmAgent.id, dmAgent]]) : new Map())") &&
      messageArea.includes("setAgentInfo(dmAgent)"),
  },
  {
    name: "message area blocks stale archived-agent DMs from sending",
    pass:
      messageArea.includes("const [dmAgentUnavailable, setDmAgentUnavailable] = useState(false)") &&
      messageArea.includes("if (channel.type === 'dm' && dmAgentUnavailable) return") &&
      messageArea.includes("async function verifyDmTargetActive") &&
      messageArea.includes("if (channel.type === 'dm' && !(await verifyDmTargetActive())) return") &&
      messageArea.includes("const shouldExpectAgentResponse = channel.type === 'dm' ? Boolean(agentInfo) : channelAgents.size > 0") &&
      messageArea.includes("This DM is no longer active because the agent was archived") &&
      messageArea.includes("disabled={sending || dmAgentUnavailable}") &&
      messageArea.includes("disabled={sending || !hasContent || dmAgentUnavailable}"),
  },
  {
    name: "DM page passes the persisted channel name into message area",
    pass:
      dmPage.includes("from('channels')") &&
      dmPage.includes("select('name,type,description')") &&
      dmPage.includes("setChannel({") &&
      !dmPage.includes('name: ""'),
  },
];

const failures = checks.filter((check) => !check.pass);

if (failures.length > 0) {
  console.error("Agent archive UI/API verification failed:");
  for (const failure of failures) {
    console.error(`- ${failure.name}`);
  }
  process.exit(1);
}

console.log(`Agent archive UI/API verification passed (${checks.length} checks).`);
