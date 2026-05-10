import { NextRequest, NextResponse } from "next/server";
import { randomBytes, createHash } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// GET /api/servers — list servers the user belongs to
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const slugParam = request.nextUrl.searchParams.get("slug");

  // Single server lookup (used by /s/[slug] page)
  if (slugParam) {
    const { data: server, error: serverError } = await admin
      .from("servers")
      .select("*")
      .eq("slug", slugParam)
      .maybeSingle();

    if (serverError) {
      return NextResponse.json({ error: serverError.message }, { status: 500 });
    }

    if (!server) {
      return NextResponse.json({ stats: null });
    }

    const { data: membership } = await admin
      .from("server_members")
      .select("server_id")
      .eq("server_id", server.id)
      .eq("member_id", user.id)
      .eq("member_type", "human")
      .maybeSingle();

    if (!membership) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const [
      { count: agentCount },
      { count: channelCount },
      { count: memberCount },
      { data: keys },
    ] = await Promise.all([
      admin.from("agents").select("*", { count: "exact", head: true }).eq("server_id", server.id),
      admin.from("channels").select("*", { count: "exact", head: true }).eq("server_id", server.id),
      admin.from("server_members").select("*", { count: "exact", head: true }).eq("server_id", server.id),
      admin
        .from("machine_keys")
        .select("id, key_prefix, name, created_at, last_used_at")
        .eq("server_id", server.id)
        .eq("user_id", user.id)
        .order("created_at", { ascending: false }),
    ]);

    return NextResponse.json({
      stats: {
        id: server.id,
        name: server.name,
        description: server.description,
        agentCount: agentCount ?? 0,
        channelCount: channelCount ?? 0,
        memberCount: memberCount ?? 0,
      },
      keys: keys ?? [],
    });
  }

  // List all user's servers
  const { data: memberships } = await admin
    .from("server_members")
    .select("server_id")
    .eq("member_id", user.id)
    .eq("member_type", "human");

  if (!memberships || memberships.length === 0) {
    return NextResponse.json({ servers: [] });
  }

  const serverIds = memberships.map((m) => m.server_id);
  const { data: servers, error } = await admin
    .from("servers")
    .select("*")
    .in("id", serverIds)
    .order("created_at");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ servers: servers ?? [] });
}

// POST /api/servers — create a new server
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const { name, description, slug: userSlug } = body;

  if (!name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  // Use user-provided slug or generate from name
  const rawSlug = (userSlug?.trim() || name.trim())
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

  if (!rawSlug) {
    return NextResponse.json({ error: "Invalid slug" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Check slug uniqueness
  const { data: existing, error: existingError } = await admin
    .from("servers")
    .select("id")
    .eq("slug", rawSlug)
    .maybeSingle();

  if (existingError) {
    return NextResponse.json({ error: existingError.message }, { status: 500 });
  }

  if (existing) {
    return NextResponse.json(
      { error: "This slug is already taken. Please choose another one." },
      { status: 409 }
    );
  }

  const slug = rawSlug;

  const { data: server, error } = await admin
    .from("servers")
    .insert({
      name: name.trim(),
      slug,
      description: description?.trim() || null,
      owner_id: user.id,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { error: membershipError } = await admin.from("server_members").insert({
    server_id: server.id,
    member_id: user.id,
    member_type: "human",
    role: "owner",
  });

  if (membershipError) {
    return NextResponse.json({ error: membershipError.message }, { status: 500 });
  }

  const rawKey = randomBytes(32).toString("hex");
  const apiKey = `zk_${rawKey}`;
  const keyPrefix = `zk_${rawKey.substring(0, 8)}`;
  const keyHash = createHash("sha256").update(apiKey).digest("hex");

  const { error: keyError } = await admin.from("machine_keys").insert({
    key_prefix: keyPrefix,
    key_hash: keyHash,
    key_value: apiKey,
    user_id: user.id,
    server_id: server.id,
    name: "Default",
  });

  if (keyError) {
    return NextResponse.json({ error: keyError.message }, { status: 500 });
  }

  return NextResponse.json({ server, apiKey });
}
