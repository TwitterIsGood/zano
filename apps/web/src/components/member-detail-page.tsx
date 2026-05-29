"use client";

import { useMemo, useState } from "react";
import { ArrowLeft, MessageCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { GeneratedAvatar } from "@/components/generated-avatar";
import { MessageArea } from "@/components/message-area";
import { MemberActivityTab } from "@/components/member-activity-tab";
import { MemberProfileTab } from "@/components/member-profile-tab";
import { MemberTasksTab } from "@/components/member-tasks-tab";
import { MemberWorkspaceTab } from "@/components/member-workspace-tab";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { createClient } from "@/lib/supabase/client";

interface Channel {
  id: string;
  name: string;
  type: string;
  description: string | null;
}

interface MemberDetailPageProps {
  serverId: string;
  serverSlug: string;
  memberType: "agent" | "human";
  memberId: string;
  member: Record<string, unknown>;
  currentUserId: string;
  currentMembershipRole?: string;
  creatorProfile?: { id: string; display_name: string | null } | null;
  humanMembership?: { role: string; joined_at: string } | null;
}

interface AgentProvenanceInfo {
  created_by_type: "human" | "agent" | "system";
  created_by_id: string | null;
  parent_agent_id: string | null;
  creation_reason: string | null;
  generation: number;
}

function asString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function avatarName(memberType: "agent" | "human", member: Record<string, unknown>) {
  return memberType === "agent"
    ? asString(member.display_name) || asString(member.name) || "Agent"
    : asString(member.display_name) || asString(member.email) || "Human";
}

function publicAgentHandle(displayName: string | null, fallback: string | null) {
  const handle = displayName
    ?.trim()
    .replace(/\s+/gu, "")
    .replace(/[^\p{L}\p{N}_-]+/gu, "");
  return handle || fallback;
}

function memberHandle(memberType: "agent" | "human", member: Record<string, unknown>) {
  if (memberType === "agent") return publicAgentHandle(asString(member.display_name), asString(member.name));
  return asString(member.email);
}

function memberStatus(memberType: "agent" | "human", member: Record<string, unknown>) {
  if (memberType === "agent") return asString(member.status);
  return null;
}

function creatorLabel(createdByType: AgentProvenanceInfo["created_by_type"]) {
  if (createdByType === "agent") return "Agent";
  if (createdByType === "human") return "Human";
  return "System";
}

function agentProvenance(member: Record<string, unknown>): AgentProvenanceInfo {
  const createdByType = member.created_by_type === "agent" || member.created_by_type === "system" ? member.created_by_type : "human";
  return {
    created_by_type: createdByType,
    created_by_id: asString(member.created_by_id),
    parent_agent_id: asString(member.parent_agent_id),
    creation_reason: asString(member.creation_reason),
    generation: typeof member.generation === "number" ? member.generation : 0,
  };
}

function AgentProvenanceBlock({ provenance }: { provenance: AgentProvenanceInfo }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <div className="text-xs font-semibold text-muted-foreground">Provenance</div>
      <div className="mt-2 space-y-1 text-sm">
        <div>
          <span className="text-muted-foreground">Created by: </span>
          <span>{creatorLabel(provenance.created_by_type)}</span>
        </div>
        {provenance.parent_agent_id ? (
          <div>
            <span className="text-muted-foreground">Parent agent: </span>
            <span>{provenance.parent_agent_id}</span>
          </div>
        ) : null}
        {provenance.creation_reason ? (
          <div>
            <span className="text-muted-foreground">Reason: </span>
            <span>{provenance.creation_reason}</span>
          </div>
        ) : null}
        <div>
          <span className="text-muted-foreground">Generation: </span>
          <span>{provenance.generation}</span>
        </div>
      </div>
    </div>
  );
}

export function MemberDetailPage({
  serverId,
  serverSlug,
  memberType,
  memberId,
  member,
  currentUserId,
  creatorProfile,
  humanMembership,
}: MemberDetailPageProps) {
  const [activeTab, setActiveTab] = useState<"profile" | "activity" | "tasks" | "workspace">("profile");
  const [mode, setMode] = useState<"detail" | "message">("detail");
  const [messageChannel, setMessageChannel] = useState<Channel | null>(null);
  const [dmError, setDmError] = useState<string | null>(null);
  const [loadingMessage, setLoadingMessage] = useState(false);

  const displayName = avatarName(memberType, member);
  const handle = memberHandle(memberType, member);
  const status = memberStatus(memberType, member);
  const isSelf = memberType === "human" && memberId === currentUserId;
  const headerBadge = memberType === "agent" ? "Agent" : "Human";
  const provenanceInfo = memberType === "agent" ? agentProvenance(member) : null;

  async function openMessage() {
    setDmError(null);
    setLoadingMessage(true);

    try {
      if (memberType === "human") {
        if (isSelf) {
          setDmError("You can't message yourself");
          return;
        }

        const supabase = createClient();
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) throw new Error("Unauthorized");

        const res = await fetch("/api/channels/dm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ server_id: serverId, target_user_id: memberId }),
        });
        const payload = await res.json().catch(() => ({})) as { channel?: Channel; error?: string };
        if (!res.ok || !payload.channel) {
          throw new Error(payload.error || "Failed to create DM channel");
        }
        setMessageChannel(payload.channel);
        setMode("message");
        return;
      }

      const res = await fetch(`/api/sidebar?server_id=${serverId}`);
      const payload = await res.json().catch(() => ({})) as {
        channels?: Channel[];
        dmMembers?: Array<{ channel_id: string; member_id: string }>;
        agents?: Array<{ id: string; display_name: string }>;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(payload.error || "Failed to load sidebar data");
      }

      const dm = (payload.channels || []).find((channel) => channel.type === "dm" &&
        payload.dmMembers?.some((memberRow) => memberRow.channel_id === channel.id && memberRow.member_id === memberId));

      if (!dm) {
        throw new Error("Unable to find the agent DM channel");
      }

      setMessageChannel(dm);
      setMode("message");
    } catch (err) {
      setDmError(err instanceof Error ? err.message : "Failed to open message") ;
      setMode("detail");
    } finally {
      setLoadingMessage(false);
    }
  }

  const messageButtonLabel = useMemo(() => {
    return loadingMessage ? "Opening..." : "Message";
  }, [loadingMessage]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-4 border-b px-6 py-4">
        {mode === "message" ? (
          <Button variant="ghost" size="sm" onClick={() => setMode("detail")}>
            <ArrowLeft className="size-4" />
            Back to profile
          </Button>
        ) : null}

        <GeneratedAvatar id={memberId} name={displayName} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-lg font-semibold">{displayName}</h1>
            <Badge variant="secondary">{headerBadge}</Badge>
            {status ? <Badge variant="outline">{status}</Badge> : null}
            {memberType === "human" && isSelf ? <Badge variant="info">You</Badge> : null}
          </div>
          <p className="truncate text-sm text-muted-foreground">{handle ? `@${handle}` : memberId}</p>
        </div>
        {mode === "detail" ? (
          <div className="flex flex-col items-end gap-1">
            <Button onClick={openMessage} disabled={loadingMessage || isSelf}>
              <MessageCircle className="size-4" />
              {messageButtonLabel}
            </Button>
            {isSelf ? <span className="text-xs text-muted-foreground">You can&apos;t message yourself</span> : null}
          </div>
        ) : (
          <Button variant="outline" onClick={() => setMode("detail")}>
            <ArrowLeft className="size-4" />
            Back to profile
          </Button>
        )}
      </div>

      {dmError ? <div className="px-6 pt-4 text-sm text-destructive">{dmError}</div> : null}

      {mode === "message" && messageChannel ? (
        <div className="flex min-h-0 flex-1 flex-col px-4 pb-4 pt-3">
          <MessageArea channel={messageChannel} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col px-6 py-4">
          <Tabs className="min-h-0 flex-1" value={activeTab} onValueChange={(value) => setActiveTab(value as "profile" | "activity" | "tasks" | "workspace")}>
            <TabsList>
              <TabsTrigger value="profile">Profile</TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
              <TabsTrigger value="tasks">Tasks</TabsTrigger>
              {memberType === "agent" ? <TabsTrigger value="workspace">Workspace</TabsTrigger> : null}
            </TabsList>
            <TabsContent value="profile" className="mt-4 min-h-0 overflow-y-auto pr-1">
              <div className="space-y-4">
                {provenanceInfo ? <AgentProvenanceBlock provenance={provenanceInfo} /> : null}
                <MemberProfileTab
                  memberType={memberType}
                  member={member}
                  memberId={memberId}
                  currentUserId={currentUserId}
                  creatorProfile={creatorProfile}
                  humanMembership={humanMembership}
                />
              </div>
            </TabsContent>
            <TabsContent value="activity" className="mt-4 min-h-0 overflow-y-auto pr-1">
              <MemberActivityTab
                serverId={serverId}
                serverSlug={serverSlug}
                memberType={memberType}
                memberId={memberId}
              />
            </TabsContent>
            <TabsContent value="tasks" className="mt-4 min-h-0 overflow-y-auto pr-1">
              <MemberTasksTab
                serverId={serverId}
                memberType={memberType}
                memberId={memberId}
              />
            </TabsContent>
            {memberType === "agent" ? (
              <TabsContent value="workspace" className="mt-4 min-h-0 overflow-y-auto pr-1">
                <MemberWorkspaceTab memberType={memberType} agentId={memberId} />
              </TabsContent>
            ) : null}
          </Tabs>
        </div>
      )}
    </div>
  );
}
