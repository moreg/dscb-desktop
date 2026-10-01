import { useEffect, useRef, useState } from 'react'
import type {
  BookTestCandidate,
  BookTestState,
  CoverImageConfigSummary,
  CoverStylePreset
} from '../../shared/types'
import {
  FANQIE_BOOK_TEST_SUBMIT_MAX,
  FANQIE_BOOK_TEST_TITLE_MAX,
  bookTestCoverIsStale,
  countChars,
  fanqieTestTitleIssues
} from '../../shared/book-test'

const STYLE_OPTIONS: { value: CoverStylePreset; label: string }[] = [
  { value: 'auto', label: '按题材自动' },
  { value: 'fanqie_impact', label: '高饱和爽文海报' },
  { value: 'male_power_type', label: '男频强字效爽文' },
  { value: 'photorealistic', label: '真人写实' },
  { value: 'anime_illustration', label: '二次元动漫' },
  { value: 'ancient_romance', label: '古风人物言情' },
  { value: 'glamour_romance', label: '女频精致人像' },
  { value: 'urban_cinematic', label: '都市电影感' },
  { value: 'dark_suspense', label: '暗黑悬疑' },
  { value: 'cute_doodle', label: '沙雕简笔' },
  { value: 'ink_minimal', label: '国风水墨' },
  { value: 'epic_fantasy', label: '玄幻史诗' },
  { value: 'concept_symbol', label: '无人物概念符号' },
  { value: 'minimal_typographic', label: '纯字极简' },
  { value: 'anime_light', label: '二次元轻小说' },
  { value: 'retro_period', label: '年代复古' },
  { value: 'warm_period_life', label: '年代生活群像' },
  { value: 'rural_healing', label: '田园种田' },
  { value: 'folk_horror', label: '中式民俗灵异' },
  { value: 'war_spy_epic', label: '战争谍战' },
  { value: 'game_neon', label: '游戏科幻霓虹' },
  { value: 'western_adventure', label: '西幻冒险' }
]

const COUNT_OPTIONS = [3, 5, 8]

let pending: Promise<void> | null = null

function track(work: Promise<unknown>): void {
  const settled = work.then(
    () => undefined,
    () => undefined
  )
  pending = Promise.resolve(pending).then(() => settled)
}

function describeError(err: unknown): string {
  const raw = (err instanceof Error ? err.message : String(err)).replace(/^Error:\s*/, '')
  if (raw.includes('LLM_NOT_CONFIGURED')) {
    return '还没有可用的文本模型。到全局设置里配置 API Key，或接入 codex / grok / claude CLI。'
  }
  if (raw.includes('LLM_TIMEOUT')) return '起书名超时了。可以再试一次，或给「辅助提取」换一个更快的模型。'
  if (raw.includes('BOOK_TEST_PARSE_FAILED')) return '模型没有给出能用的新书名。再生成一次，或把方向写得更具体。'
  if (raw.includes('BOOK_TEST_NOT_FOUND')) return '这套方案已经不在列表里。'
  if (raw.includes('BOOK_TEST_NO_AUTHOR')) return '先填笔名。番茄封面必须同时有书名和笔名。'
  if (raw.includes('BOOK_TEST_POOL_FULL')) return '已经留了 40 套。先去掉不要的，再生成新的。'
  if (raw.includes('BOOK_TEST_CORRUPT')) return '书测记录文件坏了，没有覆盖它。可以把项目里的「书测/书测.json」先移走。'
  if (raw.includes('BOOK_TEST_TITLE_INVALID')) {
    const detail = raw.split('BOOK_TEST_TITLE_INVALID:')[1]?.trim()
    return detail || '这套书名还不符合番茄多书名实验的规则。'
  }
  if (raw.includes('IMAGE_NOT_CONFIGURED')) {
    return '请先在封面页配置图像生成 API Key，或改用 codex / grok CLI 通道。'
  }
  if (raw.includes('IMAGE_TIMEOUT')) {
    const detail = raw.replace(/^.*IMAGE_TIMEOUT[（(]?/, '').replace(/[）)]?$/, '').trim()
    return detail || '出封面超时了。绘图模型耗时较长，请稍后重试。'
  }
  if (raw.includes('IMAGE_NETWORK_ERROR') || raw.includes('fetch failed')) {
    return '出封面失败：网络请求失败，请检查封面配置中的 Base URL 与网络连通性。'
  }
  if (raw.includes('IMAGE_EMPTY_RESPONSE')) {
    return '出封面失败：API 未返回图片数据，请确认所选模型是否支持图像生成。'
  }
  if (raw.includes('IMAGE_CLI_NOT_FOUND')) {
    return '未检测到本机 codex / grok CLI。请先安装并完成登录，或到封面页改用 API 通道。'
  }
  if (raw.includes('IMAGE_CLI_TIMEOUT')) return '出封面超时了。可以重试，或到封面页改用 API 通道。'
  if (raw.includes('IMAGE_CLI_GENERATE_FAILED')) return '出封面失败：模型没有产出图片。请确认登录态后重试。'
  return raw.replace(/^Error:\s*/, '')
}

interface Props {
  projectId: string
  onOpenCovers: () => void
}

type Busy =
  | { kind: 'titles' }
  | { kind: 'replace'; id: string }
  | { kind: 'cover'; id: string; index: number; total: number }
  | null

export default function BookTestPage({ projectId, onOpenCovers }: Props): React.ReactElement {
  const [bookName, setBookName] = useState('')
  const [state, setState] = useState<BookTestState | null>(null)
  const [config, setConfig] = useState<CoverImageConfigSummary | null>(null)
  const [authorName, setAuthorName] = useState('')
  const [direction, setDirection] = useState('')
  const [stylePreset, setStylePreset] = useState<CoverStylePreset>('auto')
  const [count, setCount] = useState(5)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    let cancel = false
    const wait = pending
    setLoading(true)
    setError('')
    ;(async () => {
      if (wait) setStatus('上一批还在生成，好了就刷新')
      if (wait) await wait
      try {
        const [project, bookTest, imageConfig] = await Promise.all([
          window.api.getProject(projectId),
          window.api.getBookTest(projectId),
          window.api.getCoverImageConfig()
        ])
        if (cancel) return
        setBookName(project.name)
        setState(bookTest)
        setAuthorName(bookTest.authorName)
        setDirection(bookTest.direction)
        setStylePreset(bookTest.stylePreset)
        setConfig(imageConfig)
        setStatus('')
      } catch (err) {
        if (!cancel) setError(describeError(err))
      } finally {
        if (!cancel) setLoading(false)
      }
    })()
    return () => {
      cancel = true
    }
  }, [projectId])

  async function saveSettings(patch?: { authorName?: string; stylePreset?: CoverStylePreset; direction?: string }): Promise<void> {
    const next = await window.api.patchBookTest({
      projectId,
      authorName: patch?.authorName ?? authorName,
      stylePreset: patch?.stylePreset ?? stylePreset,
      direction: patch?.direction ?? direction
    })
    if (alive.current) setState(next)
  }

  async function generateTitles(): Promise<void> {
    setError('')
    setStatus('')
    setBusy({ kind: 'titles' })
    const work = window.api.generateBookTestTitles({
      projectId,
      count,
      direction,
      authorName,
      stylePreset
    })
    track(work)
    try {
      const before = state?.candidates.length ?? 0
      const next = await work
      if (!alive.current) return
      setState(next)
      setAuthorName(next.authorName)
      setDirection(next.direction)
      setStylePreset(next.stylePreset)
      setStatus(`新生成了 ${next.candidates.length - before} 套书名。勾上你想留下的，再出封面。`)
    } catch (err) {
      if (alive.current) setError(describeError(err))
    } finally {
      if (alive.current) setBusy(null)
    }
  }

  async function generateKeptCovers(): Promise<void> {
    if (!authorName.trim()) {
      setError('先填笔名。番茄封面必须同时有书名和笔名。')
      return
    }
    setError('')
    setStatus('')
    let latest: BookTestState
    try {
      latest = await window.api.getBookTest(projectId)
    } catch (err) {
      setError(describeError(err))
      return
    }
    if (!alive.current) return
    setState(latest)
    const kept = latest.candidates.filter((candidate) => candidate.kept)
    const invalid = kept.filter((candidate) => {
      const others = latest.candidates.filter((item) => item.id !== candidate.id).map((item) => item.title)
      return fanqieTestTitleIssues(candidate.title, { originalTitle: bookName, otherTitles: others }).issues.length > 0
    })
    const targets = kept.filter((candidate) => {
      if (invalid.some((item) => item.id === candidate.id)) return false
      return !candidate.coverFileName || bookTestCoverIsStale(candidate)
    })
    if (kept.length === 0) {
      setStatus('先勾选要留下的方案。')
      return
    }
    if (targets.length === 0) {
      if (invalid.length > 0) setError(`有 ${invalid.length} 套书名还不符合规则，改完才能出封面。`)
      else setStatus('留下的方案都有和书名对应的封面了。')
      return
    }
    const work = (async () => {
      let produced: BookTestState | null = null
      for (let index = 0; index < targets.length; index++) {
        const target = targets[index]
        if (!target) continue
        if (alive.current) setBusy({ kind: 'cover', id: target.id, index: index + 1, total: targets.length })
        produced = await window.api.generateBookTestCover(projectId, target.id, authorName.trim())
        if (alive.current) setState(produced)
      }
      return produced
    })()
    track(work)
    try {
      await work
      if (alive.current) {
        setStatus(
          invalid.length > 0
            ? `已出 ${targets.length} 套封面。另有 ${invalid.length} 套书名还不符合规则，没有出图。`
            : `已为 ${targets.length} 套留下的方案出了封面。`
        )
      }
    } catch (err) {
      if (alive.current) setError(describeError(err))
    } finally {
      if (alive.current) setBusy(null)
    }
  }

  async function copyKept(): Promise<void> {
    try {
      const latest = await window.api.getBookTest(projectId)
      if (!alive.current) return
      setState(latest)
      const lines = latest.candidates.filter((candidate) => candidate.kept && candidate.title).map((candidate) => candidate.title)
      if (lines.length === 0) {
        setStatus('还没有勾选要留下的书名。')
        return
      }
      await navigator.clipboard.writeText(lines.join('\n'))
      setStatus(`已复制 ${lines.length} 条书名。`)
      setError('')
    } catch (err) {
      if (alive.current) setError(describeError(err))
    }
  }

  if (loading && !state) {
    return (
      <div>
        <div className="page-head">
          <h1>书测</h1>
        </div>
        <div className="placeholder" style={{ marginTop: 16 }}>
          <p>{status || '正在读取书测记录'}</p>
        </div>
      </div>
    )
  }

  const candidates = state?.candidates ?? []
  const keptCount = candidates.filter((candidate) => candidate.kept).length
  const imageReady = !config || config.channel !== 'api' || config.hasKey
  const working = busy !== null

  return (
    <div>
      <div className="page-head">
        <div className="page-head-row">
          <div>
            <h1>书测</h1>
            <p className="desc">
              给《{bookName || '未命名'}》准备多套新书名和新封面，你自己勾选要留下的。这里不会改作品信息里的现用书名。
            </p>
          </div>
        </div>
      </div>

      <div className="book-test-rules">
        <strong>番茄多书名实验</strong>
        ：除原书名外，一次最多提交 {FANQIE_BOOK_TEST_SUBMIT_MAX} 套。书名含标点最多 {FANQIE_BOOK_TEST_TITLE_MAX}{' '}
        个字，只用汉字、英文、数字和中文标点 ，！？【】：。封面要写上这套新书名和笔名。每套打不同的卖点，封面跟着卖点走。
        书名是否和别人重复，要到番茄后台的书名查重里看。封面文件在这本书的封面文件夹里，封面页也能打开。
      </div>

      {error ? (
        <p className="book-test-issues" style={{ marginBottom: 12 }}>
          {error}
        </p>
      ) : null}
      {status ? <p className="meta" style={{ marginTop: 0 }}>{status}</p> : null}
      {keptCount > FANQIE_BOOK_TEST_SUBMIT_MAX ? (
        <p className="book-test-note">
          已留下 {keptCount} 套。番茄一次实验最多交 {FANQIE_BOOK_TEST_SUBMIT_MAX} 套，提交前再减掉多出来的。
        </p>
      ) : null}
      {!imageReady ? (
        <div className="placeholder" style={{ margin: '0 0 12px' }}>
          <p style={{ margin: '0 0 8px' }}>出封面需要先配置图像通道。起书名不受影响。</p>
          <button className="btn btn-primary" onClick={onOpenCovers}>
            去封面页配置
          </button>
        </div>
      ) : null}

      <div className="dialog" style={{ maxWidth: 'none', width: '100%', margin: '0 0 12px', boxShadow: 'none' }}>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div className="field" style={{ flex: '1 1 140px' }}>
            <label htmlFor="book-test-author">笔名</label>
            <input
              id="book-test-author"
              className="input"
              value={authorName}
              maxLength={60}
              placeholder="写在封面上"
              onChange={(e) => setAuthorName(e.target.value)}
              onBlur={() => {
                void saveSettings({ authorName }).catch((err) => setError(describeError(err)))
              }}
            />
          </div>
          <div className="field" style={{ flex: '1 1 180px' }}>
            <label htmlFor="book-test-style">封面风格</label>
            <select
              id="book-test-style"
              className="input"
              value={stylePreset}
              onChange={(e) => {
                const value = e.target.value as CoverStylePreset
                setStylePreset(value)
                void saveSettings({ stylePreset: value }).catch((err) => setError(describeError(err)))
              }}
            >
              {STYLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: '0 1 120px' }}>
            <label htmlFor="book-test-count">这次生成</label>
            <select
              id="book-test-count"
              className="input"
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
            >
              {COUNT_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option} 套
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="book-test-direction">这轮想测的方向</label>
          <input
            id="book-test-direction"
            className="input"
            value={direction}
            maxLength={200}
            placeholder="例如：测重生和打脸，不要再测种田"
            onChange={(e) => setDirection(e.target.value)}
            onBlur={() => {
              void saveSettings({ direction }).catch((err) => setError(describeError(err)))
            }}
          />
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" disabled={working} onClick={() => void generateTitles()}>
            {busy?.kind === 'titles' ? '正在起书名…' : '生成书名'}
          </button>
          <button className="btn" disabled={working || !authorName.trim() || !imageReady} onClick={() => void generateKeptCovers()}>
            {busy?.kind === 'cover' ? `正在出封面 ${busy.index}/${busy.total}` : `给留下的出封面${keptCount ? `（${keptCount}）` : ''}`}
          </button>
          <button className="btn btn-ghost" disabled={working} onClick={() => void copyKept()}>
            复制留下的书名
          </button>
        </div>
      </div>

      {candidates.length === 0 ? (
        <div className="placeholder">
          <p>还没有测试方案。生成几套书名，勾上合适的，再出封面。</p>
        </div>
      ) : (
        <div className="book-test-list">
          {candidates.map((candidate) => (
            <CandidateCard
              key={candidate.id}
              projectId={projectId}
              candidate={candidate}
              bookName={bookName}
              otherTitles={candidates.filter((item) => item.id !== candidate.id).map((item) => item.title)}
              authorName={authorName}
              locked={working}
              imageReady={imageReady}
              replacing={busy?.kind === 'replace' && busy.id === candidate.id}
              covering={busy?.kind === 'cover' && busy.id === candidate.id}
              onState={setState}
              onError={setError}
              onMakeCover={async () => {
                setBusy({ kind: 'cover', id: candidate.id, index: 1, total: 1 })
                const work = window.api.generateBookTestCover(projectId, candidate.id, authorName.trim())
                track(work)
                try {
                  const next = await work
                  if (alive.current) {
                    setState(next)
                    setStatus('这套封面好了。')
                    setError('')
                  }
                } catch (err) {
                  if (alive.current) setError(describeError(err))
                } finally {
                  if (alive.current) setBusy(null)
                }
              }}
              onReplace={async () => {
                setBusy({ kind: 'replace', id: candidate.id })
                const work = window.api.replaceBookTestTitle(projectId, candidate.id)
                track(work)
                try {
                  const next = await work
                  if (alive.current) {
                    setState(next)
                    setStatus('这套书名换过了。封面如果还是旧书名，需要重出。')
                    setError('')
                  }
                } catch (err) {
                  if (alive.current) setError(describeError(err))
                } finally {
                  if (alive.current) setBusy(null)
                }
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function CandidateCard({
  projectId,
  candidate,
  bookName,
  otherTitles,
  authorName,
  locked,
  imageReady,
  replacing,
  covering,
  onState,
  onError,
  onMakeCover,
  onReplace
}: {
  projectId: string
  candidate: BookTestCandidate
  bookName: string
  otherTitles: string[]
  authorName: string
  locked: boolean
  imageReady: boolean
  replacing: boolean
  covering: boolean
  onState: (state: BookTestState) => void
  onError: (message: string) => void
  onMakeCover: () => Promise<void>
  onReplace: () => Promise<void>
}): React.ReactElement {
  const [title, setTitle] = useState(candidate.title)
  const [hook, setHook] = useState(candidate.hook)
  const [coverHint, setCoverHint] = useState(candidate.coverHint)
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => setTitle(candidate.title), [candidate.title])
  useEffect(() => setHook(candidate.hook), [candidate.hook])
  useEffect(() => setCoverHint(candidate.coverHint), [candidate.coverHint])

  useEffect(() => {
    if (!candidate.coverFileName) {
      setSrc(null)
      return
    }
    let cancel = false
    window.api
      .readCover(projectId, candidate.coverFileName)
      .then((url) => {
        if (!cancel) setSrc(url)
      })
      .catch(() => {
        if (!cancel) setSrc(null)
      })
    return () => {
      cancel = true
    }
  }, [projectId, candidate.coverFileName])

  const inspected = fanqieTestTitleIssues(title, { originalTitle: bookName, otherTitles })
  const stale = bookTestCoverIsStale({ ...candidate, title })
  const dirty = title !== candidate.title || hook !== candidate.hook || coverHint !== candidate.coverHint

  async function persist(kept = candidate.kept): Promise<void> {
    const next = await window.api.updateBookTestCandidate({
      projectId,
      id: candidate.id,
      title,
      hook,
      coverHint,
      kept
    })
    onState(next)
  }

  async function commitIfDirty(): Promise<void> {
    if (!dirty) return
    await persist()
  }

  const coverLabel = !candidate.coverFileName ? '出封面' : stale ? '按新书名重出' : '换一张'
  const coverBlocked = inspected.issues.length > 0 || !authorName.trim()

  return (
    <article className={`card book-test-card${candidate.kept ? ' is-kept' : ''}`}>
      <div className="book-test-cover">
        {src ? (
          <img src={src} alt={`${candidate.title || '测试书名'}的封面`} />
        ) : (
          <div className="book-test-cover-empty">{candidate.coverFileName ? '封面文件找不到了' : '还没有封面'}</div>
        )}
        <button
          className="btn btn-primary"
          disabled={locked || coverBlocked || !imageReady}
          title={!imageReady ? '先到封面页配置出图' : coverBlocked ? inspected.issues[0] || '先填笔名' : '按这套书名和笔名出图'}
          onClick={() => {
            void (async () => {
              try {
                await commitIfDirty()
                await onMakeCover()
              } catch (err) {
                onError(describeError(err))
              }
            })()
          }}
        >
          {covering ? '正在出封面…' : coverLabel}
        </button>
        {candidate.coverFileName ? (
          <button
            className="btn btn-ghost"
            disabled={locked}
            onClick={() => {
              void window.api.showCoverInFolder(projectId, candidate.coverFileName as string).catch((err) => {
                onError(describeError(err))
              })
            }}
          >
            打开所在位置
          </button>
        ) : null}
      </div>
      <div>
        <label className="book-test-keep">
          <input
            type="checkbox"
            checked={candidate.kept}
            disabled={locked}
            onChange={(e) => {
              void persist(e.target.checked).catch((err) => onError(describeError(err)))
            }}
          />
          留下这套
        </label>
        <div className="field" style={{ marginTop: 8 }}>
          <label htmlFor={`book-test-title-${candidate.id}`}>书名</label>
          <div className="book-test-title-row">
            <input
              id={`book-test-title-${candidate.id}`}
              className="input"
              value={title}
              maxLength={40}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => {
                void commitIfDirty().catch((err) => onError(describeError(err)))
              }}
            />
            <span className={`book-test-count${countChars(inspected.title) > FANQIE_BOOK_TEST_TITLE_MAX ? ' is-bad' : ''}`}>
              {countChars(inspected.title)}/{FANQIE_BOOK_TEST_TITLE_MAX}
            </span>
          </div>
          {inspected.issues.length > 0 ? <p className="book-test-issues">{inspected.issues.join('；')}</p> : null}
          {stale ? <p className="book-test-stale">封面上还是旧书名「{candidate.coverTitle}」，提交前要重出。</p> : null}
        </div>
        <div className="field">
          <label htmlFor={`book-test-hook-${candidate.id}`}>这套在测什么</label>
          <input
            id={`book-test-hook-${candidate.id}`}
            className="input"
            value={hook}
            maxLength={80}
            onChange={(e) => setHook(e.target.value)}
            onBlur={() => {
              void commitIfDirty().catch((err) => onError(describeError(err)))
            }}
          />
        </div>
        <div className="field">
          <label htmlFor={`book-test-hint-${candidate.id}`}>封面画什么</label>
          <input
            id={`book-test-hint-${candidate.id}`}
            className="input"
            value={coverHint}
            maxLength={200}
            onChange={(e) => setCoverHint(e.target.value)}
            onBlur={() => {
              void commitIfDirty().catch((err) => onError(describeError(err)))
            }}
          />
        </div>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" disabled={locked} onClick={() => void onReplace().catch((err) => onError(describeError(err)))}>
            {replacing ? '正在换书名…' : '换个书名'}
          </button>
          <button
            className="btn btn-danger"
            disabled={locked}
            title="只从书测列表拿掉，封面文件还在"
            onClick={() => {
              void window.api
                .deleteBookTestCandidate(projectId, candidate.id)
                .then(onState)
                .catch((err) => onError(describeError(err)))
            }}
          >
            去掉
          </button>
        </div>
      </div>
    </article>
  )
}
