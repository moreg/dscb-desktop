export function countWords(text: string): number {
  return text.replace(/\s/g, '').length
}
