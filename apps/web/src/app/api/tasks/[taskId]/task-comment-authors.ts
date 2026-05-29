export interface TaskCommentRow {
  id: string;
  author_id: string;
  author_type: string;
  content: string;
  created_at: string;
}

export interface HumanCommentAuthor {
  id: string;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
}

export interface AgentCommentAuthor {
  id: string;
  name: string | null;
  display_name: string | null;
}

export interface TaskCommentAuthorMetadata {
  id: string;
  type: string;
  displayName: string;
  avatarId: string;
  avatarUrl: string | null;
}

export type TaskCommentWithAuthor<T extends TaskCommentRow = TaskCommentRow> = T & {
  author: TaskCommentAuthorMetadata;
};

export interface TaskCommentAuthorLookups {
  humans: Map<string, HumanCommentAuthor>;
  agents: Map<string, AgentCommentAuthor>;
}

function fallbackAuthorLabel(authorType: string, authorId: string) {
  const prefix = authorType === "agent" ? "Agent" : authorType === "human" ? "Human" : "Author";
  return `${prefix} ${authorId.slice(0, 8)}`;
}

function commentAuthorMetadata(comment: TaskCommentRow, lookups: TaskCommentAuthorLookups): TaskCommentAuthorMetadata {
  if (comment.author_type === "human") {
    const human = lookups.humans.get(comment.author_id);
    return {
      id: comment.author_id,
      type: comment.author_type,
      displayName: human?.display_name || human?.email || fallbackAuthorLabel(comment.author_type, comment.author_id),
      avatarId: comment.author_id,
      avatarUrl: human?.avatar_url ?? null,
    };
  }

  if (comment.author_type === "agent") {
    const agent = lookups.agents.get(comment.author_id);
    return {
      id: comment.author_id,
      type: comment.author_type,
      displayName: agent?.display_name || agent?.name || fallbackAuthorLabel(comment.author_type, comment.author_id),
      avatarId: comment.author_id,
      avatarUrl: null,
    };
  }

  return {
    id: comment.author_id,
    type: comment.author_type,
    displayName: fallbackAuthorLabel(comment.author_type, comment.author_id),
    avatarId: comment.author_id,
    avatarUrl: null,
  };
}

export function enrichTaskCommentsWithAuthors<T extends TaskCommentRow>(
  comments: T[],
  lookups: TaskCommentAuthorLookups,
): TaskCommentWithAuthor<T>[] {
  return comments.map((comment) => ({
    ...comment,
    author: commentAuthorMetadata(comment, lookups),
  }));
}
