import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentManagerPath = join(__dirname, "..", "src", "agent-manager.ts");
const systemPromptPath = join(__dirname, "..", "src", "system-prompt.ts");
const skillsPath = join(__dirname, "..", "src", "autonomous-skills.ts");
const connectRoutePath = join(__dirname, "..", "..", "web", "src", "app", "api", "omni", "connect", "route.ts");

const agentManager = readFileSync(agentManagerPath, "utf8");
const systemPrompt = readFileSync(systemPromptPath, "utf8");
const skills = readFileSync(skillsPath, "utf8");
const connectRoute = readFileSync(connectRoutePath, "utf8");

const checks = [
  {
    name: "autonomous skill materialization is feature-gated",
    source: agentManager,
    pattern: /ZANO_ENABLE_AUTONOMOUS_SKILLS === "1"/,
  },
  {
    name: "active skill index is injected into the prompt",
    source: systemPrompt,
    pattern: /# Active Shared Skills[\s\S]*\$\{autonomousSkillContext\}/,
  },
  {
    name: "materializer writes SKILL.md layout",
    source: skills,
    pattern: /writeFileSync\(join\(skillDir, "SKILL\.md"\), version\.content, "utf-8"\)/,
  },
  {
    name: "materializer returns a stable skill set fingerprint",
    source: skills,
    pattern: /fingerprint: materializedCount > 0 \? createHash\("sha256"\)/,
  },
  {
    name: "agent manager stores per-agent autonomous skill fingerprints",
    source: agentManager,
    pattern: /private autonomousSkillFingerprints = new Map<string, string>\(\)/,
  },
  {
    name: "agent manager restarts idle process when autonomous skill set changes",
    source: agentManager,
    pattern: /Autonomous skill set changed — restarting process for fresh system prompt/,
  },
  {
    name: "agent manager drains queued messages after autonomous skill restart",
    source: agentManager,
    pattern: /if \(restartedProc && !restartedProc\.busy\) this\.drainQueue\(agentId, restartedProc\)/,
  },
  {
    name: "omni connect route fails closed when agent query fails",
    source: connectRoute,
    pattern: /const \{ data: agents, error: agentsError \}[\s\S]*\.from\("agents"\)[\s\S]*if \(agentsError\)[\s\S]*status: 500/,
  },
];

const failures = checks.filter((check) => !check.pattern.test(check.source));

if (failures.length > 0) {
  console.error("Autonomous Omni verification failed:");
  for (const failure of failures) {
    console.error(`- ${failure.name}`);
  }
  process.exit(1);
}

console.log(`Autonomous Omni verification passed (${checks.length} checks).`);
