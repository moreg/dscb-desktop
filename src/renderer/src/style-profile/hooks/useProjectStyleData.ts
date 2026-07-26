import { useCallback, useEffect, useState } from 'react'
import type { ProjectData, StyleProfile } from '../../../../shared/types'

export interface ProjectStyleData {
  projectData: ProjectData | null
  styleProfiles: StyleProfile[]
  reload: () => void
}

/**
 * 读取"项目元数据 + 全局文风列表"，供选择默认文风的界面使用。
 *
 * 文风只是可选增强，读失败时降级为空列表即可，绝不能让拒绝逃逸到
 * main.tsx 的全局 unhandledrejection 去触发整屏崩溃页。
 */
export function useProjectStyleData(projectId: string): ProjectStyleData {
  const [projectData, setProjectData] = useState<ProjectData | null>(null)
  const [styleProfiles, setStyleProfiles] = useState<StyleProfile[]>([])

  const reload = useCallback(() => {
    void window.api
      .getProject(projectId)
      .then(setProjectData)
      .catch((err) => console.error('[useProjectStyleData] getProject failed:', err))
    void window.api
      .listStyleProfiles()
      .then(setStyleProfiles)
      .catch((err) => {
        console.error('[useProjectStyleData] listStyleProfiles failed:', err)
        setStyleProfiles([])
      })
  }, [projectId])

  useEffect(reload, [reload])

  return { projectData, styleProfiles, reload }
}
