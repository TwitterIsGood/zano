"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MentionTarget {
  name: string;
  displayName: string;
}

interface MessageBodyProps {
  content: string;
  senderType: "human" | "agent" | "system";
  mentions?: MentionTarget[];
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function knownMentionPatterns(mentions: MentionTarget[]) {
  return mentions
    .flatMap((mention) => [
      { raw: mention.name, displayName: mention.displayName },
      { raw: mention.displayName, displayName: mention.displayName },
    ])
    .filter((mention) => mention.raw.trim().length > 0)
    .sort((a, b) => b.raw.length - a.raw.length);
}

function replaceKnownMentions(text: string, mentions: MentionTarget[]) {
  let result = text;
  for (const mention of knownMentionPatterns(mentions)) {
    const pattern = new RegExp(`@${escapeRegExp(mention.raw)}(?=[\\s,.:!?，。！？]|$)`, "g");
    result = result.replace(pattern, `@${mention.displayName}`);
  }
  return result;
}

function displayMention(token: string, mentions: MentionTarget[]) {
  const handle = token.slice(1).toLowerCase();
  const mention = mentions.find(
    (target) => target.name.toLowerCase() === handle || target.displayName.toLowerCase() === handle,
  );
  return mention ? `@${mention.displayName}` : token;
}

function renderTextWithMentions(text: string, mentions: MentionTarget[]) {
  const normalized = replaceKnownMentions(text, mentions);
  return normalized.split(/(@[^\s,.:!?，。！？]+)/g).map((part, j) =>
    part.startsWith("@") ? (
      <span key={j} className="rounded bg-primary/10 px-0.5 text-primary font-medium">
        {displayMention(part, mentions)}
      </span>
    ) : (
      part
    ),
  );
}

export function MessageBody({ content, senderType, mentions = [] }: MessageBodyProps) {
  const displayContent = replaceKnownMentions(content, mentions);

  return (
    <div
      className="prose-message text-[15px] wrap-break-word subpixel-antialiased prose-headings:antialiased"
      style={{ lineHeight: "1.54" }}
    >
      {senderType === "agent" ? (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ),
          }}
        >
          {displayContent}
        </ReactMarkdown>
      ) : (
        <span className="whitespace-pre-wrap">{renderTextWithMentions(content, mentions)}</span>
      )}
    </div>
  );
}
