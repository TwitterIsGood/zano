import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ApiKeysSection } from "@/components/api-keys-section";
import { SetupWizardWrapper } from "@/components/setup-wizard-wrapper";

interface ServerHomePageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ setup?: string }>;
}

export default async function ServerHomePage({ params, searchParams }: ServerHomePageProps) {
  const { slug } = await params;
  const { setup } = await searchParams;
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
    .select("id, name, description")
    .eq("slug", slug)
    .maybeSingle();

  if (!server) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-sm text-muted-foreground">Workspace not found</div>
      </div>
    );
  }

  const { data: membership } = await admin
    .from("server_members")
    .select("server_id")
    .eq("server_id", server.id)
    .eq("member_id", user.id)
    .eq("member_type", "human")
    .maybeSingle();

  if (!membership) {
    redirect("/");
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

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8">
      <div className="max-w-md w-full text-center">
        <Avatar className="size-16 mx-auto mb-6">
          <AvatarFallback className="text-2xl font-bold">
            {server.name.charAt(0).toUpperCase()}
          </AvatarFallback>
        </Avatar>

        <h1 className="text-xl font-semibold text-foreground mb-2">
          {server.name}
        </h1>
        {server.description && (
          <p className="text-sm text-muted-foreground mb-6">{server.description}</p>
        )}

        <div className="flex justify-center gap-8 mb-8">
          <div className="text-center">
            <div className="text-2xl font-semibold text-foreground">
              {agentCount ?? 0}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">Agents</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-semibold text-foreground">
              {channelCount ?? 0}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">Channels</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-semibold text-foreground">
              {memberCount ?? 0}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">Members</div>
          </div>
        </div>

        <p className="text-sm text-muted-foreground mb-8">
          Select an agent or channel from the sidebar to start a conversation.
        </p>

        <div className="flex justify-center">
          <ApiKeysSection serverId={server.id} initialKeys={keys ?? []} />
        </div>
      </div>

      {setup === "true" && (
        <SetupWizardWrapper serverId={server.id} serverSlug={slug} />
      )}
    </div>
  );
}
