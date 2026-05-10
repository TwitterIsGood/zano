import { redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export default async function ChatRedirect() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const admin = createAdminClient();
  const { data: memberships } = await admin
    .from("server_members")
    .select("server_id")
    .eq("member_id", user.id)
    .eq("member_type", "human")
    .limit(1);

  const serverId = memberships?.[0]?.server_id;
  if (!serverId) {
    redirect("/onboarding");
  }

  const { data: server } = await admin
    .from("servers")
    .select("slug")
    .eq("id", serverId)
    .maybeSingle();

  if (!server) {
    redirect("/onboarding");
  }

  redirect(`/s/${server.slug}`);
}
