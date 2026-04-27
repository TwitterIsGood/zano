import { NextResponse } from "next/server";
import { readdir, readFile, lstat } from "fs/promises";
import { join, resolve } from "path";
import { homedir } from "os";

interface Skill {
  name: string;
  description: string;
}

// GET /api/skills — read Claude Code skills from ~/.claude/skills/
export async function GET() {
  const skillsDir = join(homedir(), ".claude", "skills");
  const skills: Skill[] = [];

  try {
    const entries = await readdir(skillsDir);

    for (const entry of entries) {
      if (entry.startsWith(".")) continue;

      const entryPath = join(skillsDir, entry);
      const stat = await lstat(entryPath);

      // Resolve symlinks
      const resolvedPath = stat.isSymbolicLink()
        ? resolve(skillsDir, entry)
        : entryPath;

      // Look for SKILL.md (case-insensitive)
      for (const filename of ["SKILL.md", "skill.md"]) {
        const skillFile = join(resolvedPath, filename);
        try {
          const content = await readFile(skillFile, "utf-8");
          const description = extractDescription(content);
          skills.push({
            name: entry,
            description: description || entry,
          });
          break;
        } catch {
          // File doesn't exist, try next
        }
      }
    }
  } catch {
    // Skills directory doesn't exist
  }

  return NextResponse.json({ skills });
}

function extractDescription(content: string): string {
  // Parse YAML frontmatter for description field
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return "";

  const frontmatter = fmMatch[1];
  const descMatch = frontmatter.match(/^description:\s*(.+)$/m);
  if (!descMatch) return "";

  // Strip surrounding quotes if present
  let desc = descMatch[1].trim();
  if ((desc.startsWith('"') && desc.endsWith('"')) || (desc.startsWith("'") && desc.endsWith("'"))) {
    desc = desc.slice(1, -1);
  }
  return desc;
}
