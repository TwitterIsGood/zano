"use client";

import { useState } from "react";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldLabel } from "@/components/ui/field";
import { CheckIcon, CopyIcon, MonitorIcon } from "lucide-react";

interface MachineKey {
  id: string;
  name: string;
  key_prefix: string;
  key_value: string | null;
  last_used_at: string | null;
}

interface MachineDetailDialogProps {
  open: boolean;
  onClose: () => void;
  machine: MachineKey;
  serverId: string;
  onUpdated: () => void;
}

export function MachineDetailDialog({
  open,
  onClose,
  machine,
  serverId,
  onUpdated,
}: MachineDetailDialogProps) {
  const [name, setName] = useState(machine.name);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const nameChanged = name.trim() !== machine.name;

  const apiKeyDisplay = machine.key_value || `${machine.key_prefix}...`;
  const npxCommand = `npx @fehey/zano-bridge --api-key ${apiKeyDisplay}`;

  async function handleSaveName() {
    if (!nameChanged) return;
    setSaving(true);
    try {
      const res = await fetch("/api/bridge/keys", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: machine.id, name: name.trim() }),
      });
      if (res.ok) {
        onUpdated();
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(npxCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary mb-2">
            <MonitorIcon className="size-6" />
          </div>
          <DialogTitle className="text-center">Machine Details</DialogTitle>
          <DialogDescription className="text-center">
            Manage this machine connection and get the bridge command.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-4">
            <Field>
              <FieldLabel>Machine Name</FieldLabel>
              <div className="flex gap-2">
                <Input
                  type="text"
                  value={name}
                  onChange={(e) => setName((e.target as HTMLInputElement).value)}
                  placeholder="e.g. My MacBook, Work PC..."
                />
                {nameChanged && (
                  <Button
                    size="sm"
                    onClick={handleSaveName}
                    loading={saving}
                    className="flex-shrink-0"
                  >
                    Save
                  </Button>
                )}
              </div>
            </Field>

            <Field>
              <FieldLabel>Bridge Command</FieldLabel>
              <div className="relative">
                <div className="rounded-lg border bg-muted/50 p-3 pr-10 font-mono text-xs break-all select-all leading-relaxed">
                  {npxCommand}
                </div>
                <button
                  onClick={handleCopy}
                  className="absolute right-2 top-2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                  title="Copy command"
                >
                  {copied ? (
                    <CheckIcon className="size-3.5 text-green-500" />
                  ) : (
                    <CopyIcon className="size-3.5" />
                  )}
                </button>
              </div>
            </Field>

            <div className="flex items-center justify-between text-xs text-muted-foreground pt-1">
              <span>Key: {machine.key_prefix}...</span>
              <span>
                {machine.last_used_at
                  ? `Last used ${new Date(machine.last_used_at).toLocaleString()}`
                  : "Never used"}
              </span>
            </div>
          </div>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
