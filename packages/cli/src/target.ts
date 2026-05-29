export interface ParsedTargetAddress {
  channelPart: string;
  threadShortId: string | null;
}

const rawUuidWithThreadPattern = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([^:]+)$/i;

export function parseTargetAddress(target: string): ParsedTargetAddress {
  if (target.startsWith("dm:")) {
    const rest = target.slice(3);
    const colonIdx = rest.indexOf(":", 1);
    if (colonIdx > 0) {
      return {
        channelPart: "dm:" + rest.substring(0, colonIdx),
        threadShortId: rest.substring(colonIdx + 1),
      };
    }
    return { channelPart: target, threadShortId: null };
  }

  if (target.startsWith("#")) {
    const colonIdx = target.indexOf(":");
    if (colonIdx > 0) {
      return {
        channelPart: target.substring(0, colonIdx),
        threadShortId: target.substring(colonIdx + 1),
      };
    }
    return { channelPart: target, threadShortId: null };
  }

  const rawUuidThread = target.match(rawUuidWithThreadPattern);
  if (rawUuidThread) {
    return { channelPart: rawUuidThread[1], threadShortId: rawUuidThread[2] };
  }

  return { channelPart: target, threadShortId: null };
}
