import { createHash } from 'crypto'

/** 自动设定补丁的文件来源标记；只包住新写入内容，不包住作者已有段落。 */
const PATCH_BLOCK_RE = /^<!-- aw-settings-patch chapter=(\d+) id=([a-f0-9]{16}) checksum=([a-f0-9]{16}) -->\r?\n([\s\S]*?)\r?\n<!-- \/aw-settings-patch id=\2 -->/gm

export function settingPatchDigest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export function wrapSettingPatch(chapter: number, id: string, body: string): string {
  const content = body.trim()
  return `<!-- aw-settings-patch chapter=${chapter} id=${id} checksum=${settingPatchDigest(content)} -->\n${content}\n<!-- /aw-settings-patch id=${id} -->`
}

export function filterSettingPatchBlocks(text: string, beforeChapter?: number): string {
  return text.replace(PATCH_BLOCK_RE, (_match, chapter: string, _id: string, _checksum: string, body: string) =>
    beforeChapter == null || Number(chapter) < beforeChapter ? body : '')
}

/** 对照校验值防止撤销顺带删除作者在自动块里的后续修改。 */
export function removeSettingPatchBlock(text: string, chapter: number, id: string): string | null {
  for (const match of text.matchAll(PATCH_BLOCK_RE)) {
    if (Number(match[1]) !== chapter || match[2] !== id) continue
    if (settingPatchDigest(match[4]) !== match[3]) {
      throw new Error('该设定补丁已被编辑，无法安全自动撤销，请核对后手动修改')
    }
    return text.slice(0, match.index) + text.slice(match.index! + match[0].length)
  }
  return null
}
