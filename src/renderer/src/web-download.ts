export function isWebClient(): boolean {
  return window.__DSCB_WEB__ === true
}

/** 服务器把导出文件放在数据目录里，浏览器再把它下载下来。 */
export function openServerExport(filePath: string | undefined): void {
  if (!isWebClient() || !filePath) return
  const name = filePath.split(/[/\\]/).pop()
  if (!name) return
  const link = document.createElement('a')
  link.href = `/api/exports/${encodeURIComponent(name)}`
  link.download = name.replace(/^[a-f0-9]{8}-/, '')
  document.body.appendChild(link)
  link.click()
  link.remove()
}
