import "dotenv/config";
import { Bridge } from "./bridge.js";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const userId = process.env.ZANO_USER_ID;
const agentsDir = (process.env.ZANO_AGENTS_DIR || "~/.zano/agents").replace(
  "~",
  process.env.HOME || ""
);

if (!supabaseUrl || !supabaseKey || !userId) {
  console.error(
    "Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ZANO_USER_ID"
  );
  console.error("Copy .env.example to .env and fill in your values.");
  process.exit(1);
}

console.log(`
  ╔══════════════════════════════════════╗
  ║         Zano Local Bridge            ║
  ╚══════════════════════════════════════╝
`);
console.log(`  Supabase:   ${supabaseUrl}`);
console.log(`  User:       ${userId}`);
console.log(`  Agents dir: ${agentsDir}`);
console.log("");

const bridge = new Bridge({
  supabaseUrl,
  supabaseKey,
  userId,
  agentsDir,
});

bridge.start();

process.on("SIGINT", () => {
  console.log("\n  Shutting down bridge...");
  bridge.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  bridge.stop();
  process.exit(0);
});
