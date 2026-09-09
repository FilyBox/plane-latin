/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useMemo } from "react";
import { cn } from "@plane/utils";

type Props = {
  /** Raw XML text. Rendered as text, never parsed into the document. */
  data: string;
  className?: string;
};

/** Breaks a one-line XML document onto its natural lines and indents by depth.
 *
 * A CFDI or a bank export usually arrives as a single line thousands of
 * characters long, which no one can read. This is a formatter, not a parser:
 * the content is only ever rendered as text, so a malformed or hostile document
 * can produce ugly indentation and nothing worse.
 */
const prettyPrint = (xml: string): string[] => {
  const tokens = xml
    .replace(/\r\n?/g, "\n")
    .replace(/>\s*</g, ">\n<")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  let depth = 0;
  return tokens.map((token) => {
    // A closing tag un-indents itself; the ones that both open and close
    // (<a/>, <?xml?>, <!-- -->) leave the depth where they found it.
    if (token.startsWith("</")) depth = Math.max(0, depth - 1);
    const line = "  ".repeat(depth) + token;
    if (
      token.startsWith("<") &&
      !token.startsWith("</") &&
      !token.startsWith("<?") &&
      !token.startsWith("<!") &&
      !token.endsWith("/>") &&
      // <tag>value</tag> on one line is already balanced
      !/<\/[^>]+>$/.test(token)
    )
      depth += 1;
    return line;
  });
};

export function XmlViewer({ data, className }: Props) {
  const lines = useMemo(() => prettyPrint(data), [data]);

  return (
    <div className={cn("h-full overflow-auto bg-layer-1", className)}>
      <table className="w-full border-separate border-spacing-0 font-mono text-11 leading-5">
        <tbody>
          {lines.map((line, index) => (
            <tr key={`${index}-${line.slice(0, 24)}`} className="hover:bg-layer-1-hover">
              <td className="sticky left-0 w-10 border-r border-subtle bg-layer-2 px-2 text-right align-top text-tertiary select-none">
                {index + 1}
              </td>
              <td className="px-3 whitespace-pre text-secondary">{line}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
