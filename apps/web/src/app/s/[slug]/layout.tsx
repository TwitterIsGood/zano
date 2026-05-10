import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import { Sidebar, type SidebarInitialData } from "@/components/sidebar";
import { AgentActivityProvider } from "@/hooks/use-agent-activity";

interface ServerLayoutProps {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}

export default async function ServerLayout({ children, params }: ServerLayoutProps) {
  const { slug } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const admin = createAdminClient();
  const { data: server } = await admin
    .from("servers")
    .select("id, name, slug")
    .eq("slug", slug)
    .maybeSingle();

  if (!server) {
    redirect("/");
  }

  const [profileResult, membershipsResult, keysResult, channelMembershipsResult, agentsResult] =
    await Promise.all([
      admin.from("profiles").select("display_name").eq("id", user.id).maybeSingle(),
      admin.from("server_members").select("server_id").eq("member_id", user.id).eq("member_type", "human"),
      admin
        .from("machine_keys")
        .select("id, name, key_prefix, key_value, last_used_at")
        .eq("server_id", server.id)
        .eq("user_id", user.id)
        .order("created_at"),
      admin.from("channel_members").select("channel_id").eq("member_id", user.id),
      admin.from("agents").select("*").eq("server_id", server.id).order("created_at"),
    ]);

  const serverIds = (membershipsResult.data ?? []).map((m) => m.server_id);
  const { data: servers } = serverIds.length
    ? await admin.from("servers").select("id, name, slug").in("id", serverIds).order("created_at")
    : { data: [] };

  const channelIds = (channelMembershipsResult.data ?? []).map((m) => m.channel_id);
  const { data: channels } = channelIds.length
    ? await admin.from("channels").select("*").eq("server_id", server.id).in("id", channelIds).order("created_at")
    : { data: [] };

  const dmChannelIds = (channels ?? []).filter((ch) => ch.type === "dm").map((ch) => ch.id);
  const { data: dmMembers } = dmChannelIds.length
    ? await admin
        .from("channel_members")
        .select("channel_id, member_id, member_type")
        .in("channel_id", dmChannelIds)
        .eq("member_type", "agent")
    : { data: [] };

  const initialData: SidebarInitialData = {
    user: {
      id: user.id,
      email: user.email ?? "",
      display_name: profileResult.data?.display_name ?? "",
    },
    servers: servers ?? [],
    machineKeys: keysResult.data ?? [],
    channels: channels ?? [],
    agents: agentsResult.data ?? [],
    dmMembers: dmMembers ?? [],
  };

  return (
    <AgentActivityProvider>
      <div className="flex h-full bg-background p-2">
        <Sidebar
          serverSlug={server.slug}
          serverId={server.id}
          serverName={server.name}
          initialData={initialData}
        />
        <div className="flex flex-1 overflow-hidden rounded-xl bg-card shadow-border">
          {children}
        </div>
      </div>
    </AgentActivityProvider>
  );
}
