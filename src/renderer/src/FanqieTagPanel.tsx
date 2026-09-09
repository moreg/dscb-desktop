import { useEffect, useMemo, useState } from 'react'
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

export default function FanqieTagPanel({ projectId }: Props) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [genre, setGenre] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api
      .getProject(projectId)
      .then((project) => {
        if (cancelled) return
        setName(project.name ?? '')
        setDescription(project.description ?? '')
        setGenre(project.genre ?? '')
        setLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [projectId])

  const result = useMemo(
    () => recommendFanqieTags({ name, description, genre }),
    [name, description, genre]
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

  if (!loaded) return null

  return (
    <div className="fanqie-tag-panel">
      <div className="fanqie-tag-head">
        <div>
          <strong>番茄标签推荐</strong>
          <p className="fanqie-tag-desc">
            按作者区建书规则推荐：阅读标签（主分类 1 + 主题/角色/情节各 2）与内容标签（世界观 1 + 人设 4 + 情感 2 + 情节 4）。
          </p>
        </div>
        <button
          type="button"
          className="btn fanqie-tag-copy"
          onClick={() => void copyAll()}
          disabled={!result.mainCategory && result.readingTags.length === 0 && result.contentTags.length === 0}
        >
          {copied ? '已复制 ✓' : '复制全部'}
        </button>
      </div>

      {!result.mainCategory && result.readingTags.length === 0 && result.contentTags.length === 0 ? (
        <p className="fanqie-tag-empty">填写作品名称 / 简介 / 题材后，将在这里给出推荐标签。</p>
      ) : (
        <>
          <section className="fanqie-tag-section">
            <h3>阅读标签 <span className="fanqie-tag-rule">主分类 1 · 主题 2 · 角色 2 · 情节 2</span></h3>
            <div className="fanqie-tag-rows">
              {READING_LAYER_ORDER.map((layer) =>
                readingGrouped[layer].length > 0 ? (
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
                ) : null
              )}
            </div>
          </section>

          <section className="fanqie-tag-section">
            <h3>内容标签 <span className="fanqie-tag-rule">世界观 1 · 人设 4 · 情感 2 · 情节 4</span></h3>
            <div className="fanqie-tag-rows">
              {CONTENT_GROUP_ORDER.map((group) =>
                contentGrouped[group].length > 0 ? (
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
                ) : null
              )}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
