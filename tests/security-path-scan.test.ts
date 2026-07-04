import { describe, it, expect } from 'vitest'
import { isSafeReportName } from '../src/main/data/scan/scan-service'

describe('isSafeReportName 扫榜报告名安全校验', () => {
  it('允许正常文件名', () => {
    expect(isSafeReportName('qidian_2024-01-01.json')).toBe(true)
    expect(isSafeReportName('jjwxc_热门榜.json')).toBe(true)
    expect(isSafeReportName('report.md')).toBe(true)
  })

  it('拒绝 .. 目录穿越', () => {
    expect(isSafeReportName('../evil.json')).toBe(false)
    expect(isSafeReportName('..\\evil.json')).toBe(false)
    expect(isSafeReportName('report/../../../etc/passwd')).toBe(false)
  })

  it('拒绝路径分隔符', () => {
    expect(isSafeReportName('sub/dir/report.json')).toBe(false)
    expect(isSafeReportName('sub\\dir\\report.json')).toBe(false)
  })

  it('拒绝盘符路径', () => {
    expect(isSafeReportName('C:evil.json')).toBe(false)
    expect(isSafeReportName('D:\\secret.json')).toBe(false)
  })

  it('拒绝空名和超长名', () => {
    expect(isSafeReportName('')).toBe(false)
    expect(isSafeReportName('a'.repeat(201))).toBe(false)
  })
})
