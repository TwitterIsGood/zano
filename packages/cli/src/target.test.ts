import { describe, expect, it } from "vitest";
import { parseTargetAddress } from "./target";

describe("target address parsing", () => {
  it("parses raw channel IDs with thread suffixes", () => {
    expect(parseTargetAddress("123e4567-e89b-12d3-a456-426614174000:abcd1234")).toEqual({
      channelPart: "123e4567-e89b-12d3-a456-426614174000",
      threadShortId: "abcd1234",
    });
  });

  it("parses DM targets without splitting the @handle", () => {
    expect(parseTargetAddress("dm:@BrowserQA:abcd1234")).toEqual({
      channelPart: "dm:@BrowserQA",
      threadShortId: "abcd1234",
    });
  });

  it("parses channel targets with thread suffixes", () => {
    expect(parseTargetAddress("#general:abcd1234")).toEqual({
      channelPart: "#general",
      threadShortId: "abcd1234",
    });
  });
});
