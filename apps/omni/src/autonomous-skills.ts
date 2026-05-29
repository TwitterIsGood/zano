import { createHash } from "crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { SupabaseClient } from "@supabase/supabase-js";

interface SkillRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  state: string;
  active_version_id: string | null;
}

interface SkillVersionRow {
  id: string;
  skill_id: string;
  version_number: number;
  content: string;
  content_hash: string;
}

interface MaterializeAutonomousSkillsOptions {
  displayName: string;
  serverId: string;
  supabase: SupabaseClient;
  workDir: string;
}

interface MaterializeAutonomousSkillsResult {
  promptContext: string;
  count: number;
  fingerprint: string;
}

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export async function materializeAutonomousSkills(
  options: MaterializeAutonomousSkillsOptions
): Promise<MaterializeAutonomousSkillsResult> {
  const skillsDir = join(options.workDir, ".zano", "autonomous-skills");

  const { data: skillRows, error: skillError } = await options.supabase
    .from("skills")
    .select("id, slug, name, description, state, active_version_id")
    .eq("server_id", options.serverId)
    .in("state", ["active", "probation"])
    .not("active_version_id", "is", null)
    .order("slug");

  if (skillError) {
    throw new Error(skillError.message);
  }

  const skills = (skillRows ?? []) as SkillRow[];
  const versionIds = skills
    .map((skill) => skill.active_version_id)
    .filter((versionId): versionId is string => Boolean(versionId));

  if (versionIds.length === 0) {
    if (existsSync(skillsDir)) rmSync(skillsDir, { recursive: true, force: true });
    return { promptContext: "", count: 0, fingerprint: "" };
  }

  const { data: versionRows, error: versionError } = await options.supabase
    .from("skill_versions")
    .select("id, skill_id, version_number, content, content_hash")
    .in("id", versionIds);

  if (versionError) {
    throw new Error(versionError.message);
  }

  const versionsById = new Map(
    ((versionRows ?? []) as SkillVersionRow[]).map((version) => [version.id, version])
  );

  rmSync(skillsDir, { recursive: true, force: true });
  mkdirSync(skillsDir, { recursive: true });

  const indexLines = [
    "# Autonomous Shared Skills",
    "",
    `Materialized for ${options.displayName} at ${new Date().toISOString()}.`,
    "",
  ];
  const promptLines = [
    "Active/probation shared skills are materialized under `.zano/autonomous-skills`.",
    "Use a skill only when its trigger fits the current situation.",
    "",
  ];

  const fingerprintParts: string[] = [];
  let materializedCount = 0;
  for (const skill of skills) {
    if (!skill.active_version_id) continue;

    const version = versionsById.get(skill.active_version_id);
    if (!version) continue;

    const skillDir = join(skillsDir, safePathSegment(skill.slug));
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), version.content, "utf-8");

    indexLines.push(
      `- ${skill.slug} v${version.version_number} (${skill.state}) — ${skill.name}: ${skill.description}`
    );
    promptLines.push(`- ${skill.slug} (${skill.state}) — ${skill.description}`);
    fingerprintParts.push(`${skill.id}:${version.id}:${version.content_hash}:${skill.state}`);
    materializedCount += 1;
  }

  writeFileSync(join(skillsDir, "INDEX.md"), `${indexLines.join("\n")}\n`, "utf-8");

  return {
    promptContext: materializedCount > 0 ? promptLines.join("\n") : "",
    count: materializedCount,
    fingerprint: materializedCount > 0 ? createHash("sha256").update(fingerprintParts.join("\n")).digest("hex") : "",
  };
}
