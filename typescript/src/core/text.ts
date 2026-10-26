/* eslint-disable no-control-regex -- these patterns name the control characters they match */

/**
 * Checks on text the client sends or shows: keys, header values, paths and messages.
 *
 * A key holds visible ASCII only, 0x21 to 0x7E. A header value holds visible ASCII, spaces and
 * tabs only. A fault names the kind of character and its position counting from 1, so an
 * error can say where a key or header breaks without quoting it.
 */

/** Any character outside visible ASCII, which a key may not hold. */
const OUTSIDE_VISIBLE_ASCII = /[^\x21-\x7e]/;

/** Any character but visible ASCII, a space or a tab, which a header value may not hold. */
const OUTSIDE_HEADER = /[^\x20-\x7e\t]/;

/** A C0 or C1 control or DEL, a tab included, which a path or an id may not hold. */
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;

/** The characters that steer a terminal or hide in text: the C0 controls but tab and line
 *  feed, DEL, the C1 controls, the Unicode format characters (category Cf), such as the
 *  bidirectional marks, the zero-width space, the soft hyphen and the byte order mark, and the
 *  other default-ignorable code points (Default_Ignorable_Code_Point), which most terminals
 *  draw as nothing, such as the combining grapheme joiner, the variation selectors and the
 *  Hangul fillers. */
const UNPRINTABLE_CLASS =
  "[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f\\p{Cf}\\p{Default_Ignorable_Code_Point}]";
const UNPRINTABLE = new RegExp(UNPRINTABLE_CLASS, "gu");

/** A `.` or `..` path segment, percent-encoded or not, which a URL resolves to another path. */
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/** Text without the characters that steer a terminal or hide in text. */
export const printable = (text: string): string => text.replace(UNPRINTABLE, "");

/** A line break, or the Unicode line and paragraph separators. */
const LINE_BREAK = /[\n\u2028\u2029]/g;

/** `text` as one display line: `printable`, with each line break turned into a space, so text
 *  from the server can neither steer a terminal nor start a line that reads as the client's. */
export const inline = (text: string): string => printable(text).replace(LINE_BREAK, " ");

/** A pattern that matches `secret` with any run of the characters `printable` strips between
 *  its characters, so text whose every match is replaced holds no `secret` once `printable`
 *  has run on it either. Tab and line feed are visible whitespace that `printable` keeps, so a
 *  key split by them shows as two pieces and is not matched. Redaction catches the copies the
 *  text would display as the key. */
export const secretPattern = (secret: string): RegExp =>
  new RegExp(
    Array.from(secret, (character) => character.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&")).join(
      `${UNPRINTABLE_CLASS}*`,
    ),
    "gu",
  );

function fault(text: string, pattern: RegExp): string | null {
  const match = pattern.exec(text);
  if (match === null) return null;
  const character = match[0];
  const kind =
    character === "\r" || character === "\n"
      ? "a line break"
      : character === " " || character === "\t"
        ? "whitespace"
        : character > "\x7f"
          ? "a non-ASCII character"
          : "a control character";
  return `${kind} at character ${match.index + 1}`;
}

/** Where `key` leaves visible ASCII, such as `a line break at character 45`, or null. */
export const keyFault = (key: string): string | null => fault(key, OUTSIDE_VISIBLE_ASCII);

/** Where a header value leaves visible ASCII, spaces and tabs, such as `a line break at
 *  character 12`, or null. */
export const headerFault = (value: string): string | null => fault(value, OUTSIDE_HEADER);

/** Where `text` holds a C0 or C1 control or DEL, a tab included, or null. */
export const controlFault = (text: string): string | null => fault(text, CONTROL);

/** A slash or backslash, raw or percent-encoded in either case, which separates path segments. */
const SEGMENT_SEPARATOR = /[/\\]|%2f|%5c/i;

/** Whether a URL path holds a `.` or `..` segment, percent-encoded or not, between slashes or
 *  backslashes, raw or percent-encoded, which a server resolves to another path. */
export const hasDotSegment = (path: string): boolean =>
  path.split(SEGMENT_SEPARATOR).some((segment) => DOT_SEGMENT.test(segment));

/** `message` with one bracket naming `labels`, joined by ` · `, as in
 *  `No entry. [code_not_found · trace 4f2a]`: on its last line, or on a line of its own after a
 *  message of several lines. The bracket passes through `printable`, as the message has. No
 *  labels leave the message as it is. */
export function bracketed(message: string, labels: readonly string[]): string {
  if (labels.length === 0) return message;
  return `${message}${message.includes("\n") ? "\n" : " "}[${printable(labels.join(" · "))}]`;
}
