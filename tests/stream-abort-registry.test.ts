import { describe, it, expect, beforeEach } from 'vitest'
import {
  beginStream,
  endStream,
  abortStream,
  activeStreamCount,
  pendingAbortCount,
  clearAllStreams
} from '../src/main/data/stream-abort-registry'

describe('stream-abort-registry', () => {
  beforeEach(() => {
    clearAllStreams()
  })

  it('beginStream 登记 signal，endStream 移除且不 abort', () => {
    const signal = beginStream('r1')
    expect(signal.aborted).toBe(false)
    expect(activeStreamCount()).toBe(1)
    endStream('r1')
    expect(activeStreamCount()).toBe(0)
    expect(signal.aborted).toBe(false)
  })

  it('abortStream 中止并移除', () => {
    const signal = beginStream('r2')
    expect(abortStream('r2')).toBe(true)
    expect(signal.aborted).toBe(true)
    expect(activeStreamCount()).toBe(0)
  })

  it('同 requestId 再次 begin 会 abort 旧的', () => {
    const first = beginStream('same')
    const second = beginStream('same')
    expect(first.aborted).toBe(true)
    expect(second.aborted).toBe(false)
    expect(activeStreamCount()).toBe(1)
    endStream('same')
  })

  it('abort 在 begin 之前会登记 pending，begin 得到已 aborted 的 signal', () => {
    expect(abortStream('early')).toBe(true)
    expect(pendingAbortCount()).toBe(1)
    expect(activeStreamCount()).toBe(0)

    const signal = beginStream('early')
    expect(signal.aborted).toBe(true)
    expect(pendingAbortCount()).toBe(0)
    // begin 后仍短暂登记，便于 endStream 对称清理
    expect(activeStreamCount()).toBe(1)
    endStream('early')
    expect(activeStreamCount()).toBe(0)
    expect(pendingAbortCount()).toBe(0)
  })

  it('endStream 清除 pending abort', () => {
    abortStream('pending-only')
    expect(pendingAbortCount()).toBe(1)
    endStream('pending-only')
    expect(pendingAbortCount()).toBe(0)
    // 之后正常 begin 不应被旧 pending 误杀
    const signal = beginStream('pending-only')
    expect(signal.aborted).toBe(false)
    endStream('pending-only')
  })
})
