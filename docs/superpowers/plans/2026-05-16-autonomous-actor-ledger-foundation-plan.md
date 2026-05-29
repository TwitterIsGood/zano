# Autonomous Actor Ledger Foundation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the first implementation layer for Zano's autonomous skill, knowledge, and agent evolution system.

**Architecture:** Start with actor identity, ledger schema, and bridge compatibility. Omni should be able to receive per-agent actor tokens without breaking existing owner-token RLS flows, while the database gains the canonical tables and helper functions needed for future autonomous writes.

**Tech Stack:** TypeScript, Next.js API routes, Node bridge daemon, Supabase SQL, pnpm workspaces.

---

### Task 1: Actor JWT Foundation

**Files:**
- Modify: `apps/web/src/lib/jwt.ts`
- Modify: `apps/web/src/app/api/omni/connect/route.ts`
- Modify: `apps/omni/src/index.ts`
- Modify: `apps/omni/src/bridge.ts`
- Modify: `apps/omni/src/agent-manager.ts`

**Steps:**

1. Add generic actor JWT helpers with `actor_type`, `actor_id`, `server_id`, `owner_id`, `machine_key_id`, and `scope` claims.
2. Keep the existing bridge owner token for current bridge Supabase operations.
3. Add per-agent actor tokens to Omni connect response.
4. Store per-agent tokens in Omni and agent manager.
5. Expose per-agent token to spawned agent processes as `ZANO_AGENT_AUTH_TOKEN`, while keeping `ZANO_AUTH_TOKEN` as the current compatible owner token.

**Verification:**

- `pnpm --filter @zano/web lint`
- `pnpm --filter @zano/bridge build`

### Task 2: Autonomous Ledger Schema

**Files:**
- Create: `packages/db/src/autonomous.sql`
- Modify: `packages/db/src/index.ts`

**Steps:**

1. Add actor context helper functions.
2. Add ledger tables for skills, skill versions, files, events, attestations, episodes, candidates, knowledge items, blueprints, spawn events, turns, tool events, policy evaluations, lint results, and projection runs.
3. Add conservative indexes and constraints.
4. Add RLS enablement and initial server membership policies.
5. Export the SQL from the db package.

**Verification:**

- `pnpm --filter @zano/db build`

### Task 3: Runtime Evidence Hooks

**Files:**
- Modify: `apps/omni/src/agent-manager.ts`

**Steps:**

1. Add non-invasive placeholders for durable turn/tool event collection.
2. Do not change existing runtime behavior yet.
3. Keep all writes best-effort and disabled until schema application is confirmed.

**Verification:**

- Existing bridge build continues to pass.

### Task 4: Documentation Sync

**Files:**
- Modify: `docs/superpowers/specs/2026-05-16-autonomous-skill-knowledge-system-design.md`

**Steps:**

1. Add implementation notes if code diverges from target behavior for compatibility.
2. Mark owner-token compatibility as a temporary bridge mode.

**Verification:**

- Review file references and ensure implementation notes match code.
