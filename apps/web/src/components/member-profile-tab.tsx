"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useAgentActivity } from "@/hooks/use-agent-activity";

type MemberType = "agent" | "human";

interface MemberProfileTabProps {
  memberType: MemberType;
  member: Record<string, unknown>;
  memberId: string;
  currentUserId: string;
  creatorProfile?: { id: string; display_name: string | null } | null;
  humanMembership?: { role: string; joined_at: string } | null;
}

function asString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  if (!children) return null;

  return (
    <div className="grid gap-1">
      <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-sm text-foreground">{children}</dd>
    </div>
  );
}

export function MemberProfileTab({
  memberType,
  member,
  memberId,
  currentUserId,
  creatorProfile,
  humanMembership,
}: MemberProfileTabProps) {
  const activities = useAgentActivity();
  const activity = memberType === "agent" ? activities.get(memberId) : null;

  if (memberType === "agent") {
    const displayName = asString(member.display_name);
    const handle = asString(member.name);
    const description = asString(member.description);
    const status = asString(member.status);
    const createdAt = asString(member.created_at);

    return (
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-5 sm:grid-cols-2">
            <Field label="Display name">{displayName}</Field>
            <Field label="Handle">{handle ? `@${handle}` : null}</Field>
            <Field label="Description">{description}</Field>
            <Field label="Status">{status ? <Badge variant="outline">{status}</Badge> : null}</Field>
            <Field label="Live activity">
              {activity ? (
                <span>
                  {activity.label || activity.activity}
                  {activity.detail ? <span className="text-muted-foreground"> · {activity.detail}</span> : null}
                </span>
              ) : (
                <span className="text-muted-foreground">Idle</span>
              )}
            </Field>
            <Field label="Created">{createdAt ? formatDate(createdAt) : null}</Field>
            <Field label="Creator">
              {creatorProfile?.display_name ? creatorProfile.display_name : null}
            </Field>
          </dl>
        </CardContent>
      </Card>
    );
  }

  const displayName = asString(member.display_name);
  const email = asString(member.email);
  const createdAt = asString(member.created_at);
  const isCurrentUser = memberId === currentUserId;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-5 sm:grid-cols-2">
          <Field label="Display name">{displayName}</Field>
          <Field label="Email">{email}</Field>
          <Field label="Created">{createdAt ? formatDate(createdAt) : null}</Field>
          <Field label="Current user">{isCurrentUser ? <Badge variant="secondary">You</Badge> : null}</Field>
          <Field label="Server role">{humanMembership?.role}</Field>
          <Field label="Joined server">
            {humanMembership?.joined_at ? formatDate(humanMembership.joined_at) : null}
          </Field>
        </dl>
      </CardContent>
    </Card>
  );
}
