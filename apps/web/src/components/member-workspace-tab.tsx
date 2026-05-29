"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { Copy, File, Folder, FolderOpen, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";

interface FileEntry {
  name: string;
  type: "file" | "directory";
  size: number;
  modified: string;
}

interface WorkspaceResponse {
  workspace_path?: string;
  files?: FileEntry[];
  notes_files?: FileEntry[];
  error?: string;
  message?: string;
}

interface FileResponse {
  content?: string;
  error?: string;
}

type BridgeRpcFn = (action: string, extra?: Record<string, unknown>) => Promise<Record<string, unknown>>;
type BridgeRpcResponse = { payload: Record<string, unknown> };

interface MemberWorkspaceTabProps {
  memberType: "agent" | "human";
  agentId: string;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function sortEntries(entries: FileEntry[]) {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}

function FileRow({
  file,
  displayName,
  selected,
  onClick,
}: {
  file: FileEntry;
  displayName?: string;
  selected: boolean;
  onClick: () => void;
}) {
  const isMemory = file.name === "MEMORY.md";

  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left transition-colors ${
        selected ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50"
      }`}
    >
      <File className={`size-4 flex-shrink-0 ${isMemory ? "text-primary" : "opacity-60"}`} />
      <span className={`min-w-0 flex-1 truncate font-mono text-sm ${isMemory ? "font-medium" : ""}`}>
        {displayName || file.name}
      </span>
      <span className="flex-shrink-0 text-xs text-muted-foreground">{formatSize(file.size)}</span>
    </button>
  );
}

export function MemberWorkspaceTab({ memberType, agentId }: MemberWorkspaceTabProps) {
  const rpcChannelRef = useRef<RealtimeChannel | null>(null);
  const rpcCallbacksRef = useRef(new Map<string, (payload: Record<string, unknown>) => void>());
  const [loading, setLoading] = useState(true);
  const [workspacePath, setWorkspacePath] = useState("");
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [notesFiles, setNotesFiles] = useState<FileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyLabel, setCopyLabel] = useState("Copy path");
  const [useBridge, setUseBridge] = useState(false);

  const topLevelFiles = useMemo(() => sortEntries(files.filter((file) => file.type === "file")), [files]);
  const topLevelDirs = useMemo(
    () => sortEntries(files.filter((file) => file.type === "directory" && file.name !== "notes")),
    [files],
  );
  const sortedNotesFiles = useMemo(() => sortEntries(notesFiles), [notesFiles]);
  const hasNotesDirectory = sortedNotesFiles.length > 0 || files.some((file) => file.name === "notes");
  const hasFiles = topLevelFiles.length > 0 || topLevelDirs.length > 0 || hasNotesDirectory;

  useEffect(() => {
    if (memberType !== "agent") return;

    const supabase = createClient();
    const channel = supabase
      .channel("bridge-rpc")
      .on("broadcast", { event: "rpc:response" }, ({ payload }: BridgeRpcResponse) => {
        const requestId = payload.requestId;
        if (typeof requestId !== "string") return;

        const callback = rpcCallbacksRef.current.get(requestId);
        if (!callback) return;
        rpcCallbacksRef.current.delete(requestId);
        callback(payload);
      })
      .subscribe();

    rpcChannelRef.current = channel;

    return () => {
      channel.unsubscribe();
      rpcChannelRef.current = null;
      rpcCallbacksRef.current.clear();
    };
  }, [memberType]);

  const bridgeRpc: BridgeRpcFn = useCallback(async (action, extra = {}) => {
    const channel = rpcChannelRef.current;
    if (!channel) throw new Error("bridge_offline");

    const requestId = crypto.randomUUID();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        rpcCallbacksRef.current.delete(requestId);
        reject(new Error("bridge_offline"));
      }, 8000);

      rpcCallbacksRef.current.set(requestId, (payload) => {
        window.clearTimeout(timeout);
        if (payload.error) reject(new Error(String(payload.error)));
        else resolve(payload);
      });

      channel.send({
        type: "broadcast",
        event: "rpc:request",
        payload: { requestId, action, ...extra },
      });
    });
  }, []);

  const loadWorkspace = useCallback(async () => {
    if (memberType !== "agent") return;

    setLoading(true);
    setError(null);
    setSelectedFile(null);
    setFileContent(null);
    setUseBridge(false);

    try {
      const res = await fetch(`/api/agents/${agentId}/workspace`);
      const data = (await res.json().catch(() => ({}))) as WorkspaceResponse;

      if (res.ok) {
        setWorkspacePath(data.workspace_path || "");
        setFiles(data.files || []);
        setNotesFiles(data.notes_files || []);
        return;
      }

      if (data.error === "remote_workspace") {
        setUseBridge(true);
        const rpcData = await bridgeRpc("list", { agentId });
        setWorkspacePath((rpcData.workspace_path as string) || "");
        setFiles((rpcData.files as FileEntry[]) || []);
        setNotesFiles((rpcData.notes_files as FileEntry[]) || []);
        return;
      }

      throw new Error(data.message || data.error || "Failed to load workspace");
    } catch (err) {
      const message = err instanceof Error && err.message === "bridge_offline"
        ? "Bridge is offline. Start the bridge to browse this agent workspace."
        : err instanceof Error
          ? err.message
          : "Failed to load workspace";
      setError(message);
      setFiles([]);
      setNotesFiles([]);
    } finally {
      setLoading(false);
    }
  }, [agentId, bridgeRpc, memberType]);

  async function loadFile(filePath: string) {
    setSelectedFile(filePath);
    setFileContent(null);
    setLoadingFile(true);

    try {
      if (useBridge) {
        const data = await bridgeRpc("read", { agentId, filePath });
        setFileContent((data.content as string) || "");
        return;
      }

      const res = await fetch(`/api/agents/${agentId}/workspace?file=${encodeURIComponent(filePath)}`);
      const data = (await res.json().catch(() => ({}))) as FileResponse;

      if (!res.ok) {
        throw new Error(data.error || "Failed to read file");
      }

      setFileContent(data.content || "");
    } catch (err) {
      setFileContent(err instanceof Error ? `[${err.message}]` : "[Failed to read file]");
    } finally {
      setLoadingFile(false);
    }
  }

  async function copyPath() {
    if (!workspacePath) return;
    await navigator.clipboard.writeText(workspacePath);
    setCopyLabel("Copied");
    setTimeout(() => setCopyLabel("Copy path"), 1500);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadWorkspace(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadWorkspace]);

  if (memberType !== "agent") return null;

  if (loading) {
    return (
      <Card>
        <CardContent className="py-6 text-sm text-muted-foreground">Loading workspace...</CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between gap-4 py-6">
          <p className="text-sm text-destructive">{error}</p>
          <Button size="sm" variant="outline" onClick={loadWorkspace}>
            <RefreshCw className="size-4" />
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <CardTitle>Workspace</CardTitle>
            {workspacePath ? (
              <p className="mt-1 truncate font-mono text-xs text-muted-foreground">{workspacePath}</p>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">No workspace path available.</p>
            )}
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <Button size="sm" variant="outline" onClick={copyPath} disabled={!workspacePath}>
              <Copy className="size-4" />
              {copyLabel}
            </Button>
            <Button size="sm" variant="outline" onClick={loadWorkspace}>
              <RefreshCw className="size-4" />
              Refresh
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {!hasFiles ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderOpen className="size-5" />
              </EmptyMedia>
              <EmptyTitle>Workspace is empty</EmptyTitle>
              <EmptyDescription>The agent will create files here as it learns from conversations.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="grid min-h-[520px] lg:grid-cols-[minmax(260px,360px)_1fr]">
            <div className="border-b lg:border-b-0 lg:border-r">
              <ScrollArea className="h-[420px] lg:h-[520px]">
                <div className="space-y-1 p-3">
                  {topLevelFiles.map((file) => (
                    <FileRow
                      key={file.name}
                      file={file}
                      selected={selectedFile === file.name}
                      onClick={() => loadFile(file.name)}
                    />
                  ))}

                  {hasNotesDirectory ? (
                    <div className="pt-1">
                      <div className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-muted-foreground">
                        <Folder className="size-4 text-primary/70" />
                        <span>notes/</span>
                      </div>
                      {sortedNotesFiles.length > 0 ? (
                        <div className="ml-4 space-y-1">
                          {sortedNotesFiles.map((file) => (
                            <FileRow
                              key={file.name}
                              file={file}
                              displayName={file.name.replace("notes/", "")}
                              selected={selectedFile === file.name}
                              onClick={() => loadFile(file.name)}
                            />
                          ))}
                        </div>
                      ) : (
                        <p className="ml-7 py-1 text-xs italic text-muted-foreground">Empty</p>
                      )}
                    </div>
                  ) : null}

                  {topLevelDirs.map((dir) => (
                    <div key={dir.name} className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-muted-foreground">
                      <Folder className="size-4 opacity-60" />
                      <span className="truncate">{dir.name}/</span>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            </div>

            <div className="min-w-0">
              {selectedFile ? (
                <div className="flex h-full min-h-[420px] flex-col">
                  <div className="flex items-center justify-between gap-3 border-b bg-muted/50 px-4 py-3">
                    <span className="min-w-0 truncate font-mono text-sm font-medium text-muted-foreground">{selectedFile}</span>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label="Close preview"
                      onClick={() => {
                        setSelectedFile(null);
                        setFileContent(null);
                      }}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                  <ScrollArea className="h-[420px] lg:h-[520px]">
                    <div className="p-4">
                      {loadingFile ? (
                        <p className="text-sm text-muted-foreground">Loading file...</p>
                      ) : (
                        <pre className="whitespace-pre-wrap break-words font-mono text-sm leading-relaxed text-muted-foreground">
                          {fileContent}
                        </pre>
                      )}
                    </div>
                  </ScrollArea>
                </div>
              ) : (
                <Empty className="min-h-[420px] md:py-12">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <File className="size-5" />
                    </EmptyMedia>
                    <EmptyTitle>Select a file</EmptyTitle>
                    <EmptyDescription>Choose a file from the workspace browser to preview its contents.</EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent className="text-xs text-muted-foreground">
                    This is the agent&apos;s persistent workspace for memory and notes.
                  </EmptyContent>
                </Empty>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
