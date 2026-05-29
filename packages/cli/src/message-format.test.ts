import { describe, expect, it } from "vitest";
import { findDisallowedTaskReferenceShorthand, taskReferenceRewriteMessage } from "./message-format";

describe("message format lint", () => {
  it("rejects slash-separated task references", () => {
    expect(findDisallowedTaskReferenceShorthand("task #66/#67/#69 are done")).toBe("#66/#67");
    expect(findDisallowedTaskReferenceShorthand("已完成：#66 / #67")).toBe("#66 / #67");
  });

  it("rejects range task references", () => {
    expect(findDisallowedTaskReferenceShorthand("task #60-#65 done")).toBe("task #60-#65");
    expect(findDisallowedTaskReferenceShorthand("#60–65 已关闭")).toBe("#60–65");
  });

  it("allows individually punctuated task references", () => {
    expect(findDisallowedTaskReferenceShorthand("task #66, task #67, task #69 are done")).toBeNull();
    expect(findDisallowedTaskReferenceShorthand("task #66、task #67、task #69 已完成")).toBeNull();
  });

  it("explains how to rewrite the message", () => {
    expect(taskReferenceRewriteMessage("#66/#67")).toContain("task #66、task #67");
  });
});
