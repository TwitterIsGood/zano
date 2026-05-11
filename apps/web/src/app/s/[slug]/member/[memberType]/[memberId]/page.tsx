import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { MemberDetailPage } from "@/components/member-detail-page";

interface PageProps {
  params: Promise<{ slug: string; memberType: string; memberId: string }>;
}

const VALID_MEMBER_TYPES = new Set(["agent", "human"]);

export default async function MemberDetailPageRoute({ params }: PageProps) {
  const { slug, memberType, memberId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = createAdminClient();

  const { data: server } = await admin
    .from("servers")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (!server) redirect("/");

  const serverId = server.id;

  const { data: membership } = await admin
    .from("server_members")
    .select("member_id, role, joined_at")
    .eq("server_id", serverId)
    .eq("member_id", user.id)
    .eq("member_type", "human")
    .maybeSingle();
  if (!membership) redirect("/");

  if (!VALID_MEMBER_TYPES.has(memberType)) {
    redirect(`/s/${slug}`);
  }

  let member: Record<string, unknown> | null = null;
  let creatorProfile: { id: string; display_name: string | null } | null = null;
  let humanMembership: { role: string; joined_at: string } | null = null;

  if (memberType === "agent") {
    const { data: agent } = await admin
      .from("agents")
      .select("*")
      .eq("id", memberId)
      .eq("server_id", serverId)
      .maybeSingle();
    member = agent;

    if (agent?.owner_id) {
      const { data: owner } = await admin
        .from("profiles")
        .select("id, display_name")
        .eq("id", agent.owner_id)
        .maybeSingle();
      creatorProfile = owner;
    }
  }

  if (memberType === "human") {
    const { data: sm } = await admin
      .from("server_members")
      .select("role, joined_at")
      .eq("server_id", serverId)
      .eq("member_id", memberId)
      .eq("member_type", "human")
      .maybeSingle();
    humanMembership = sm;

    if (humanMembership) {
      const { data: profile } = await admin
        .from("profiles")
        .select("*")
        .eq("id", memberId)
        .maybeSingle();
      member = profile;
    }
  }

  if (!member) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-sm text-muted-foreground">Member not found</p>
      </div>
    );
  }

  return (
    <MemberDetailPage
      serverId={serverId}
      serverSlug={slug}
      memberType={memberType as "agent" | "human"}
      memberId={memberId}
      member={member}
      currentUserId={user.id}
      currentMembershipRole={membership.role ?? undefined}
      creatorProfile={creatorProfile}
      humanMembership={humanMembership}
    />
  );
}
