import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { theme } from "./theme.js";

/** A piece of a line: plain, bold, italic or code. */
export interface Span {
  readonly text: string;
  readonly style?: "bold" | "italic" | "code";
}

/** Splits a line into spans by `**bold**`, `*italic*` / `_italic_` and `` `code` ``. */
export function spans(line: string): Span[] {
  const out: Span[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    const token = match[0];
    const at = match.index;
    if (at > last) out.push({ text: line.slice(last, at) });
    if (token.startsWith("`")) out.push({ text: token.slice(1, -1), style: "code" });
    else if (token.startsWith("**")) out.push({ text: token.slice(2, -2), style: "bold" });
    else out.push({ text: token.slice(1, -1), style: "italic" });
    last = at + token.length;
  }
  if (last < line.length) out.push({ text: line.slice(last) });
  return out;
}

function Inline({ line }: { readonly line: string }): ReactNode {
  return (
    <Text>
      {spans(line).map((span, index) => (
        <Text
          key={index}
          bold={span.style === "bold"}
          italic={span.style === "italic"}
          {...(span.style === "code" ? { color: theme.code } : {})}
        >
          {span.text}
        </Text>
      ))}
    </Text>
  );
}

/** A block of the text: what each line is. */
type Block =
  | { readonly kind: "heading"; readonly text: string }
  | {
      readonly kind: "item";
      readonly marker: string;
      readonly text: string;
      readonly depth: number;
    }
  | { readonly kind: "quote"; readonly text: string }
  | { readonly kind: "code"; readonly lang: string; readonly lines: string[] }
  | { readonly kind: "table"; readonly header: string[]; readonly rows: string[][] }
  | { readonly kind: "rule" }
  | { readonly kind: "blank" }
  | { readonly kind: "text"; readonly text: string };

/** Reads markdown into blocks, line by line (enough for a model's answers). */
export function blocks(text: string): Block[] {
  const out: Block[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = /^\s*```(\S*)/.exec(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? "")) code.push(lines[i++] ?? "");
      out.push({ kind: "code", lang: fence[1] ?? "", lines: code });
      continue;
    }
    if (isRow(line) && isRule(lines[i + 1] ?? "")) {
      const header = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isRow(lines[i] ?? "")) rows.push(cells(lines[i++] ?? ""));
      i--;
      out.push({ kind: "table", header, rows });
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      out.push({ kind: "heading", text: heading[1] ?? "" });
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const marker = /\d/.test(item[2] ?? "") ? (item[2] ?? "") : "•";
      out.push({
        kind: "item",
        marker,
        text: item[3] ?? "",
        depth: Math.floor((item[1] ?? "").length / 2),
      });
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      out.push({ kind: "quote", text: line.replace(/^\s*>\s?/, "") });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push({ kind: "rule" });
      continue;
    }
    out.push(line.trim() === "" ? { kind: "blank" } : { kind: "text", text: line });
  }
  // No runs of blank lines.
  return out.filter((block, index) => block.kind !== "blank" || out[index - 1]?.kind !== "blank");
}

function isRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line);
}

function isRule(line: string): boolean {
  return /^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*(:?-{3,}:?\s*)?\|?\s*$/.test(line);
}

/** The cells of a table row: `| a | b |` → ["a", "b"]. */
export function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

/**
 * Each column's width in characters, by what it holds, except the last,
 * which takes the rest of the line (undefined): short columns stay whole,
 * and the long text wraps in the last one.
 */
export function columnWidths(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): (number | undefined)[] {
  const cap = header.length > 3 ? 24 : 32;
  return header.map((title, column) => {
    if (column === header.length - 1) return undefined;
    const longest = Math.max(title.length, ...rows.map((row) => (row[column] ?? "").length), 3);
    return Math.min(cap, longest) + 2;
  });
}

function Table({
  header,
  rows,
}: {
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
}): ReactNode {
  const widths = columnWidths(header, rows);
  const row = (values: readonly string[], key: string | number, bold = false) => (
    <Box key={key} flexDirection="row">
      {widths.map((width, column) => (
        <Box
          key={column}
          paddingRight={1}
          {...(width === undefined ? { flexGrow: 1, flexBasis: 0 } : { width, flexShrink: 0 })}
        >
          {bold ? (
            <Text bold color={theme.brand}>
              {values[column] ?? ""}
            </Text>
          ) : (
            <Inline line={values[column] ?? ""} />
          )}
        </Box>
      ))}
    </Box>
  );
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Box
        borderStyle="single"
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        borderColor={theme.border}
      >
        {row(header, "header", true)}
      </Box>
      {rows.map((values, index) => row(values, index))}
    </Box>
  );
}

/** A model's answer, in the terminal. */
export function Markdown({ text }: { readonly text: string }): ReactNode {
  return (
    <Box flexDirection="column">
      {blocks(text.trim()).map((block, index) => {
        switch (block.kind) {
          case "heading":
            return (
              <Text key={index} bold color={theme.brand}>
                {block.text}
              </Text>
            );
          case "item":
            return (
              <Box key={index} paddingLeft={block.depth * 2}>
                <Text color={theme.accent}>{block.marker} </Text>
                <Inline line={block.text} />
              </Box>
            );
          case "quote":
            return (
              <Box key={index}>
                <Text color={theme.border}>│ </Text>
                <Text italic dimColor>
                  {block.text}
                </Text>
              </Box>
            );
          case "code":
            return (
              <Box
                key={index}
                flexDirection="column"
                borderStyle="single"
                borderTop={false}
                borderRight={false}
                borderBottom={false}
                borderColor={theme.border}
                paddingLeft={1}
              >
                {block.lang !== "" && <Text dimColor>{block.lang}</Text>}
                {block.lines.map((line, n) => (
                  <Text key={n} color={theme.code}>
                    {line === "" ? " " : line}
                  </Text>
                ))}
              </Box>
            );
          case "table":
            return <Table key={index} header={block.header} rows={block.rows} />;
          case "rule":
            return (
              <Text key={index} color={theme.border}>
                {"─".repeat(24)}
              </Text>
            );
          case "blank":
            return <Text key={index}> </Text>;
          case "text":
            return <Inline key={index} line={block.text} />;
        }
      })}
    </Box>
  );
}
