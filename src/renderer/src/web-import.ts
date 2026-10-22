import { MAX_PROJECT_PACKAGE_BYTES } from '../../shared/project-package'
import type { ProjectMeta } from '../../shared/types'

export async function uploadProjectPackage(file: File): Promise<{ canceled: false; project: ProjectMeta }> {
  if (!file.name.toLowerCase().endsWith('.zip')) throw new Error('请选择 ZIP 格式的小说包')
  if (file.size === 0) throw new Error('小说包为空，请重新选择文件')
  if (file.size > MAX_PROJECT_PACKAGE_BYTES) throw new Error('小说包过大，最大支持 512 MB')
  const response = await fetch('/api/import-package', {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: file
  })
  if (response.status === 401) throw new Error('登录已失效，请刷新页面重新输入口令')
  if (response.status === 413) throw new Error('小说包过大，或超过服务器允许的上传大小')
  const body = await response.json().catch(() => null) as {
    ok?: boolean
    result?: { canceled: false; project: ProjectMeta }
    error?: string
  } | null
  if (!response.ok || !body?.ok || !body.result?.project) {
    throw new Error(body?.error || '导入小说包失败，请稍后重试')
  }
  return body.result
}
