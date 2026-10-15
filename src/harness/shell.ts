/** One POSIX shell word, for commands passed through `sh -c`. */
export const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
