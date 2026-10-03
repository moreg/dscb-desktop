/** GitHub's feed returns HTML; latest.yml can also contain plain text or Markdown. */
export function formatAppUpdateNotes(notes: string | undefined): string {
  if (!notes?.trim()) return ''
  // A template is inert: remote images, scripts and other release content never run.
  // Only text is copied out and rendered by MarkdownView as React text nodes.
  const template = document.createElement('template')
  template.innerHTML = notes
  template.content.querySelectorAll('script, style, iframe, object, embed, template, svg, math').forEach(node => node.remove())

  function read(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
    if (node.nodeType !== Node.ELEMENT_NODE) return ''
    const element = node as Element
    const tag = element.tagName.toLowerCase()
    const content = Array.from(element.childNodes, read).join('')
    if (tag === 'br') return '\n'
    if (/^h[1-6]$/.test(tag)) return `\n\n### ${content.trim()}\n\n`
    if (tag === 'li') return `\n- ${content.trim()}\n`
    if (tag === 'strong' || tag === 'b') return `**${content}**`
    if (tag === 'img') return element.getAttribute('alt') ?? ''
    if (tag === 'td' || tag === 'th') return `${content}\t`
    if (['p', 'div', 'ul', 'ol', 'blockquote', 'pre', 'section', 'article', 'tr', 'hr'].includes(tag)) {
      return `\n${content}\n`
    }
    return content
  }

  return Array.from(template.content.childNodes, read).join('')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\n[\t ]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
