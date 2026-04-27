"use client";

import { useEditor, EditorContent, type Editor, textblockTypeInputRule } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Heading from "@tiptap/extension-heading";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import { Markdown } from "tiptap-markdown";
import { Extension } from "@tiptap/core";
import { forwardRef, useImperativeHandle, useEffect, useRef } from "react";

// tiptap-markdown stores getMarkdown on editor.storage.markdown
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getMarkdown(editor: Editor): string {
  return (editor.storage as Record<string, any>).markdown?.getMarkdown?.() ?? "";
}

export interface TiptapMessageInputHandle {
  focus: () => void;
  clear: () => void;
  getMarkdown: () => string;
  /** Replace @query text near cursor with replacement string */
  replaceMention: (query: string, replacement: string) => void;
}

interface TiptapMessageInputProps {
  placeholder?: string;
  disabled?: boolean;
  /** Called when user presses Cmd/Ctrl+Enter on non-empty content */
  onSend: (markdown: string) => void;
  /** Called on every content change */
  onTextUpdate?: (textBeforeCursor: string, fullText: string) => void;
  /** Intercept keys before Tiptap. Return true to consume (for @mention nav). */
  onKeyDown?: (event: KeyboardEvent) => boolean;
}

function createSendOnModEnterExtension(
  onSendRef: React.RefObject<(md: string) => void>
) {
  return Extension.create({
    name: "sendOnModEnter",
    addKeyboardShortcuts() {
      return {
        "Mod-Enter": ({ editor }) => {
          const md = getMarkdown(editor);
          if (!md.trim()) return true;
          onSendRef.current(md);
          editor.commands.clearContent(true);
          return true;
        },
      };
    },
  });
}

/**
 * Custom Heading extension with modified input rules to avoid conflicts
 * with hashtag/mention syntax. Requires a space after `#` to trigger.
 * Ref: https://github.com/ueberdosis/tiptap/issues/2570
 */
const CustomHeading = Heading.extend({
  addInputRules() {
    return this.options.levels.map((level: number) => {
      return textblockTypeInputRule({
        find: new RegExp(`^(#{1,${level}}) $`),
        type: this.type,
        getAttributes: { level },
      });
    });
  },
});

const TAB_CHAR = "\u0009";

const ListTabExtension = Extension.create({
  name: "listTab",
  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => {
        if (editor.isActive("listItem")) {
          const result = editor.chain().sinkListItem("listItem").run();
          if (result) return true;
        }
        editor
          .chain()
          .command(({ tr }) => {
            tr.insertText(TAB_CHAR);
            return true;
          })
          .run();
        return true;
      },
      "Shift-Tab": ({ editor }) => {
        const { selection, doc } = editor.state;
        const { $from } = selection;
        const pos = $from.pos;

        if (editor.isActive("listItem")) {
          editor.chain().liftListItem("listItem").run();
          editor.commands.focus(pos);
          return true;
        }

        if (doc.textBetween(pos - 1, pos) === TAB_CHAR) {
          editor
            .chain()
            .command(({ tr }) => {
              tr.delete(pos - 1, pos);
              return true;
            })
            .run();
          editor.commands.focus(pos);
          return true;
        }

        return true;
      },
    };
  },
});

const TiptapMessageInput = forwardRef<
  TiptapMessageInputHandle,
  TiptapMessageInputProps
>(function TiptapMessageInput(
  { placeholder, disabled, onSend, onTextUpdate, onKeyDown },
  ref
) {
  const onSendRef = useRef(onSend);
  onSendRef.current = onSend;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        dropcursor: false,
        gapcursor: false,
      }),
      CustomHeading.configure({
        levels: [1, 2, 3],
      }),
      Link.extend({ inclusive: false }).configure({
        defaultProtocol: "https",
        autolink: true,
      }),
      Placeholder.configure({
        placeholder: placeholder || "Write a message...",
      }),
      Markdown.configure({
        transformCopiedText: true,
        transformPastedText: true,
        html: true,
      }),
      createSendOnModEnterExtension(onSendRef),
      ListTabExtension,
    ],
    editorProps: {
      attributes: {
        class: "focus:outline-none prose-message",
      },
      handleKeyDown: (_view, event) => {
        // Parent intercepts first (for @mention arrow/tab/enter/escape)
        // If parent returns true, event is consumed and extensions won't fire
        if (onKeyDown) {
          const handled = onKeyDown(event);
          if (handled) return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: ed }) => {
      if (onTextUpdate) {
        const { from } = ed.state.selection;
        const $from = ed.state.doc.resolve(from);
        const textBeforeCursor = $from.parent.textBetween(
          0,
          $from.parentOffset
        );
        onTextUpdate(textBeforeCursor, ed.getText());
      }
    },
    onSelectionUpdate: ({ editor: ed }) => {
      // Also fire on cursor move (e.g. arrow keys within @mention text)
      if (onTextUpdate) {
        const { from } = ed.state.selection;
        const $from = ed.state.doc.resolve(from);
        const textBeforeCursor = $from.parent.textBetween(
          0,
          $from.parentOffset
        );
        onTextUpdate(textBeforeCursor, ed.getText());
      }
    },
    immediatelyRender: false,
  });

  useEffect(() => {
    if (editor) editor.setEditable(!disabled);
  }, [editor, disabled]);

  useImperativeHandle(ref, () => ({
    focus: () => editor?.commands.focus(),
    clear: () => editor?.commands.clearContent(true),
    getMarkdown: () => (editor ? getMarkdown(editor) : ""),
    replaceMention: (query: string, replacement: string) => {
      if (!editor) return;
      const { from } = editor.state.selection;
      const $from = editor.state.doc.resolve(from);
      const textBefore = $from.parent.textBetween(0, $from.parentOffset);
      const searchStr = `@${query}`;
      const idx = textBefore.lastIndexOf(searchStr);
      if (idx === -1) return;
      const start = $from.start() + idx;
      const end = start + searchStr.length;
      editor
        .chain()
        .deleteRange({ from: start, to: end })
        .insertContent(replacement)
        .run();
    },
  }));

  return (
    <div className="tiptap-input">
      <EditorContent editor={editor} />
    </div>
  );
});

export default TiptapMessageInput;
