export function findDisallowedTaskReferenceShorthand(content: string): string | null {
  const slash = content.match(/(^|[^\p{L}\p{N}_])(#\d+\s*\/\s*#\d+\b)/u);
  if (slash) return slash[2].trim();

  const range = content.match(/(^|[^\p{L}\p{N}_])((?:task\s+)?#\d+\s*[-–—]\s*#?\d+\b)/iu);
  return range ? range[2].trim() : null;
}

export function taskReferenceRewriteMessage(shorthand: string): string {
  return `Rewrite task references individually; do not use slash or range shorthand like "${shorthand}". Use "task #66, task #67" or "task #66、task #67" instead.`;
}
