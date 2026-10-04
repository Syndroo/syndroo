// Escape LinkedIn little-text grammar before JSON encoding.
export function plainCommentary(text: string): string {
  return text.replace(/[|{}@\[\]()<>#\\*_~]/g, "\\$&");
}
