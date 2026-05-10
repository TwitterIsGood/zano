import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { TaskBoard } from "@/components/task-board";

interface TasksPageProps {
  params: Promise<{ slug: string }>;
}

export default async function TasksPage({ params }: TasksPageProps) {
  const { slug } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const admin = createAdminClient();
  const { data: server } = await admin.from("servers").select("id").eq("slug", slug).single();
  if (!server) redirect("/");

  return <TaskBoard serverId={server.id} userId={user.id} />;
}
