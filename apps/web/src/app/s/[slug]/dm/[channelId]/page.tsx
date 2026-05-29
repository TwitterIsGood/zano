"use client";

import { useState, useCallback, useEffect } from "react";
import { useParams } from "next/navigation";
import { MessageArea } from "@/components/message-area";
import { AgentSettingsPanel } from "@/components/agent-settings-panel";
import { createClient } from "@/lib/supabase/client";

interface AgentInfo {
  id: string;
  display_name: string;
  status: string;
  description: string | null;
}

interface ChannelInfo {
  id: string;
  name: string;
  type: "dm";
  description: string | null;
}

export default function DmPage() {
  const params = useParams();
  const channelId = params.channelId as string;
  const [settingsAgent, setSettingsAgent] = useState<AgentInfo | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [channel, setChannel] = useState<ChannelInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();

    void (async () => {
      const { data } = await supabase
        .from('channels')
        .select('name,type,description')
        .eq('id', channelId)
        .eq('type', 'dm')
        .maybeSingle();

      if (cancelled || !data) return;
      setChannel({
        id: channelId,
        name: data.name,
        type: "dm",
        description: data.description ?? null,
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [channelId]);

  const handleToggleSettings = useCallback((agent: AgentInfo | null) => {
    setSettingsAgent(agent);
  }, []);

  const handleAgentDeleted = useCallback(() => {
    setSettingsAgent(null);
    // Navigate back would go here, but for now just clear
  }, []);

  const handleAgentUpdated = useCallback((updated: AgentInfo) => {
    setSettingsAgent(updated);
    setRefreshKey((k) => k + 1);
  }, []);

  const currentChannel = channel?.id === channelId ? channel : null;

  return (
    <>
      <MessageArea
        key={refreshKey}
        channel={currentChannel}
        onToggleSettings={handleToggleSettings}
        showSettings={!!settingsAgent}
      />
      {settingsAgent && (
        <AgentSettingsPanel
          agent={settingsAgent}
          onClose={() => setSettingsAgent(null)}
          onDeleted={handleAgentDeleted}
          onUpdated={handleAgentUpdated}
        />
      )}
    </>
  );
}
