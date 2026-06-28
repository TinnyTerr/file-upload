import { test, expect, describe } from "bun:test";
import { asMarkdown, asHtml } from "../src/lib/copy";

describe("asMarkdown", () => {
  test("builds a markdown link", () => {
    expect(asMarkdown("file.txt", "https://h/x")).toBe("[file.txt](https://h/x)");
  });
});

describe("asHtml", () => {
  test("escapes name and url", () => {
    const out = asHtml('a&b<c>"d"', 'https://h/?q=1&x="2"');
    expect(out).toContain("a&amp;b&lt;c&gt;&quot;d&quot;");
    expect(out).toContain("&amp;x=&quot;2&quot;");
    expect(out).not.toContain("<c>");
  });
});
