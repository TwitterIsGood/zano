"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SetupWizard } from "@/components/setup-wizard";

export function SetupWizardWrapper({
  serverId,
  serverSlug,
}: {
  serverId: string;
  serverSlug: string;
}) {
  const [open, setOpen] = useState(true);
  const router = useRouter();

  if (!open) return null;

  return (
    <SetupWizard
      serverId={serverId}
      serverSlug={serverSlug}
      onComplete={() => {
        setOpen(false);
        router.replace(`/s/${serverSlug}`);
      }}
    />
  );
}
