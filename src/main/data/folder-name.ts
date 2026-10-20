const FOLDER_CHAR: Record<string, string> = {
  '<': '＜',
  '>': '＞',
  ':': '：',
  '"': '＂',
  '/': '／',
  '\\': '＼',
  '|': '｜',
  '?': '？',
  '*': '＊'
}

/** 书名转成 Windows 能用的文件夹名。非法符号换成全角，返回值就是要保存的书名。 */
export function toFolderName(name: string): string {
  const replaced = name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, (ch) => FOLDER_CHAR[ch] ?? '')
  const cleaned = replaced.replace(/[. ]+$/g, '').trim()
  if (!cleaned || cleaned === '.' || cleaned === '..') return ''
  if (isReservedWindowsName(cleaned)) return ''
  return [...cleaned].slice(0, 255).join('')
}

function isReservedWindowsName(name: string): boolean {
  const stem = name.split('.')[0]?.toUpperCase() ?? ''
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)
}
