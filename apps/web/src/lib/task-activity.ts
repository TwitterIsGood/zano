import { createAdminClient } from "@/lib/supabase/admin";

export async function deriveTaskVisibility(
  admin: ReturnType<typeof createAdminClient>,
  channelId: string
): Promise<{
  visibility: "dm" | "channel";
  channel_id: string;
  server_id: string;
}> {
  const { data: channel, error } = await admin
    .from("channels")
    .select("type, server_id")
    .eq("id", channelId)
    .single();

  if (error) throw error;

  return {
    visibility: channel.type === "dm" ? "dm" : "channel",
    channel_id: channelId,
    server_id: channel.server_id,
  };
}
