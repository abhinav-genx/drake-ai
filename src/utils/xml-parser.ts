/**
 * Returns the content inside the FIRST occurrence of the given XML tag.
 *
 * @param xml - The source string to search within.
 * @param tag - The tag name (without angle brackets), e.g. "answer".
 * @returns The trimmed inner content of the first matching tag, or `null` if not found.
 *
 * @example
 * getFirstTagContent("<a>hello</a><a>world</a>", "a"); // "hello"
 */
export function getFirstTagContent(xml: string, tag: string): string | null {
  const regex = new RegExp(`<${escapeTag(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeTag(tag)}>`, "i");
  const match = regex.exec(xml);
  return match ? match[1].trim() : null;
}

/**
 * Returns the content inside ALL occurrences of the given XML tag.
 *
 * @param xml - The source string to search within.
 * @param tag - The tag name (without angle brackets), e.g. "item".
 * @returns An array of trimmed inner contents for every matching tag. Empty if none found.
 *
 * @example
 * getAllTagContents("<a>1</a><a>2</a>", "a"); // ["1", "2"]
 */
export function getAllTagContents(xml: string, tag: string): string[] {
  const regex = new RegExp(`<${escapeTag(tag)}(?:\\s[^>]*)?>([\\s\\S]*?)</${escapeTag(tag)}>`, "gi");
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    results.push(match[1].trim());
  }
  return results;
}

/** Escapes regex-special characters in a tag name so it can be used safely in a pattern. */
function escapeTag(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
