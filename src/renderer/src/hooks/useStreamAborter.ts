import { useCallback, useEffect, useRef } from 'react'
import type { StreamHandleOf } from '../../../shared/types'

/**
 * 跟踪进行中的流式 LLM 请求，组件卸载时统一 abort。
 *
 * 渲染层普遍用代际号丢弃过期 token，但那只是"不显示"——主进程里的 LLM 请求
 * 仍会跑完整个生成（分析类超时上限很长），白白消耗 token。用本 hook 包住
 * StreamHandle 后，用户离开页面即真正掐断底层请求。
 *
 * 用法：const track = useStreamAborter()
 *       const result = await track(window.api.xxxStream(...))
 */
export function useStreamAborter(): <T>(handle: StreamHandleOf<T>) => Promise<T> {
  const active = useRef<Set<{ abort: () => Promise<unknown> }>>(new Set())

  useEffect(
    () => () => {
      for (const h of active.current) void h.abort().catch(() => undefined)
      active.current.clear()
    },
    []
  )

  return useCallback(async <T,>(handle: StreamHandleOf<T>): Promise<T> => {
    active.current.add(handle)
    try {
      return await handle
    } finally {
      active.current.delete(handle)
    }
  }, [])
}
