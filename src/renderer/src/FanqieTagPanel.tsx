import { useEffect, useMemo, useRef, useState } from 'react'
import {
  FANQIE_READING_TAGS,
  FANQIE_CONTENT_TAGS,
  FANQIE_READING_LIMITS,
  FANQIE_CONTENT_LIMITS,
  recommendFanqieTags
} from '../../shared/fanqie-tags'
import type { FanqieTagHit } from '../../shared/fanqie-tags'

interface Props {
  projectId: string
  /** 作品信息页上当前的书名，含未保存的修改 */
  name: string
  /** 作品信息页上当前的简介，含未保存的修改 */
  description: string
}

interface TagSource {
  name: string
  description: string
  genre: string
}

/** 复制一块「标签名 / 标签名 / …」文本（番茄建书页粘贴用） */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

const READING_LAYER_ORDER = ['主分类', '主题', '角色', '情节'] as const
const CONTENT_GROUP_ORDER = ['世界观', '人设', '情感', '情节'] as const

const READING_LAYER_LABEL: Record<string, string> = {
  主分类: '主分类',
  主题: '主题',
  角色: '角色',
  情节: '情节'
}

const CONTENT_GROUP_LABEL: Record<string, string> = {
  世界观: '世界观',
  人设: '人设',
  情感: '情感',
  情节: '情节'
}

export default function FanqieTagPanel({ projectId, name, description }: Props) {
  const [source, setSource] = useState<TagSource | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [regenerated, setRegenerated] = useState(false)
  const requestSeq = useRef(0)
  const regeneratedTimer = useRef<number | null>(null)

  const applySource = async (nextName: string, nextDescription: string): Promise<boolean> => {
    const seq = ++requestSeq.current
    setBusy(true)
    try {
      const project = await window.api.getProject(projectId)
      if (seq !== requestSeq.current) return false
      setSource({
        name: nextName,
        description: nextDescription,
        genre: project.genre ?? ''
      })
      return true
    } catch {
      if (seq !== requestSeq.current) return false
      setSource({ name: nextName, description: nextDescription, genre: '' })
      return true
    } finally {
      if (seq === requestSeq.current) setBusy(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    setSource(null)
    setBusy(true)
    window.api
      .getProject(projectId)
      .then((project) => {
        if (cancelled) return
        setSource({
          name,
          description,
          genre: project.genre ?? ''
        })
      })
      .catch(() => {
        if (cancelled) return
        setSource({ name, description, genre: '' })
      })
      .finally(() => {
        if (!cancelled) setBusy(false)
      })
    return () => {
      cancelled = true
    }
    // 换项目时用当时的书名和简介生成一次。之后改字，要点「重新生成」。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  useEffect(() => {
    return () => {
      if (regeneratedTimer.current !== null) window.clearTimeout(regeneratedTimer.current)
    }
  }, [])

  const regenerate = () => {
    setRegenerated(false)
    void applySource(name, description).then((applied) => {
      if (!applied) return
      setRegenerated(true)
      if (regeneratedTimer.current !== null) window.clearTimeout(regeneratedTimer.current)
      regeneratedTimer.current = window.setTimeout(() => {
        regeneratedTimer.current = null
        setRegenerated(false)
      }, 1600)
    })
  }

  const result = useMemo(
    () => recommendFanqieTags(source ?? { name: '', description: '', genre: '' }),
    [source]
  )

  /** 按层分组展示阅读标签 */
  const readingGrouped = useMemo(() => {
    const map: Record<string, FanqieTagHit[]> = {}
    for (const layer of READING_LAYER_ORDER) map[layer] = []
    if (result.mainCategory) map['主分类'].push(result.mainCategory)
    for (const hit of result.readingTags) {
      const layer = FANQIE_READING_TAGS.find((t) => t.categoryId === hit.id)?.layer
      if (layer && map[layer]) map[layer].push(hit)
    }
    return map
  }, [result])

  /** 按组分组展示内容标签 */
  const contentGrouped = useMemo(() => {
    const map: Record<string, FanqieTagHit[]> = {}
    for (const group of CONTENT_GROUP_ORDER) map[group] = []
    for (const hit of result.contentTags) {
      const group = FANQIE_CONTENT_TAGS.find((t) => t.labelId === hit.id)?.group
      if (group && map[group]) map[group].push(hit)
    }
    return map
  }, [result])

  const copyAll = async () => {
    const readingNames = [...result.readingTags, ...(result.mainCategory ? [result.mainCategory] : [])]
      .filter((t) => t.name)
      .map((t) => t.name)
    const contentNames = result.contentTags.map((t) => t.name)
    const ok = await copyText(`${readingNames.join('、')} | ${contentNames.join('、')}`)
    setCopied(ok)
    setTimeout(() => setCopied(false), 1600)
  }

  if (!source) return null

  const empty = !result.mainCategory && result.readingTags.length === 0 && result.contentTags.length === 0

  return (
    <div className="fanqie-tag-panel">
      <div className="fanqie-tag-head">
        <div>
          <strong>番茄标签推荐</strong>
          <p className="fanqie-tag-desc">
            每个分类至少推荐 1 个。阅读标签上限为主分类 1、主题/角色/情节各 2，内容标签上限为世界观 1、人设 4、情感 2、情节 4。改完书名或简介后，点「重新生成」。
          </p>
        </div>
        <div className="fanqie-tag-actions">
          <button
            type="button"
            className="btn fanqie-tag-regen"
            onClick={regenerate}
            disabled={busy}
          >
            {busy ? '生成中…' : regenerated ? '已重新生成' : '重新生成'}
          </button>
          <button
            type="button"
            className="btn fanqie-tag-copy"
            onClick={() => void copyAll()}
            disabled={empty}
          >
            {copied ? '已复制 ✓' : '复制全部'}
          </button>
        </div>
      </div>

      {empty ? (
        <p className="fanqie-tag-empty">填写作品名称 / 简介 / 题材后，将在这里给出推荐标签。</p>
      ) : (
        <>
          <section className="fanqie-tag-section">
            <h3>阅读标签 <span className="fanqie-tag-rule">每类至少 1 · 主分类 1 · 主题 2 · 角色 2 · 情节 2</span></h3>
            <div className="fanqie-tag-rows">
              {READING_LAYER_ORDER.map((layer) => (
                <div className="fanqie-tag-row" key={layer}>
                  <span className="fanqie-tag-layer">{READING_LAYER_LABEL[layer]}</span>
                  <span className="fanqie-tag-items">
                    {readingGrouped[layer].map((hit) => (
                      <span className="fanqie-tag-chip" key={hit.id} title={hit.via.join('、')}>
                        {hit.name}
                      </span>
                    ))}
                  </span>
                  <span className="fanqie-tag-limit">
                    {readingGrouped[layer].length}/{FANQIE_READING_LIMITS[layer as keyof typeof FANQIE_READING_LIMITS]}
                  </span>
                </div>
              ))}
            </div>
          </section>

          <section className="fanqie-tag-section">
            <h3>内容标签 <span className="fanqie-tag-rule">每类至少 1 · 世界观 1 · 人设 4 · 情感 2 · 情节 4</span></h3>
            <div className="fanqie-tag-rows">
              {CONTENT_GROUP_ORDER.map((group) => (
                <div className="fanqie-tag-row" key={group}>
                  <span className="fanqie-tag-layer">{CONTENT_GROUP_LABEL[group]}</span>
                  <span className="fanqie-tag-items">
                    {contentGrouped[group].map((hit) => (
                      <span className="fanqie-tag-chip" key={hit.id} title={hit.via.join('、')}>
                        {hit.name}
                      </span>
                    ))}
                  </span>
                  <span className="fanqie-tag-limit">
                    {contentGrouped[group].length}/{FANQIE_CONTENT_LIMITS[group as keyof typeof FANQIE_CONTENT_LIMITS]}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
