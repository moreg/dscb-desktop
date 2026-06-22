import { describe, it, expect } from 'vitest'
import {
  pushEntry,
  popEntry,
  popEntryAt,
  revertInDraft,
  applyToDraft,
  findEntryByViolationKey,
  pushRedo,
  popRedo,
  clearRedoStack,
  detectUndoRedoShortcut,
  REWRITE_HISTORY_CAP,
  type RewriteEntry
} from '../src/main/data/rewrite-history'

describe('pushEntry / popEntry (栈行为)', () => {
  it('pushes to empty stack', () => {
    const next = pushEntry([], 'old', 'new', 1000)
    expect(next).toHaveLength(1)
    expect(next[0]).toEqual({ oldSnippet: 'old', newText: 'new', at: 1000 })
  })

  it('appends in FIFO order', () => {
    let s: ReturnType<typeof pushEntry> = []
    s = pushEntry(s, 'old1', 'new1', 1000)
    s = pushEntry(s, 'old2', 'new2', 2000)
    s = pushEntry(s, 'old3', 'new3', 3000)
    expect(s.map((e) => e.oldSnippet)).toEqual(['old1', 'old2', 'old3'])
  })

  it('caps at REWRITE_HISTORY_CAP, dropping oldest (FIFO)', () => {
    let s: ReturnType<typeof pushEntry> = []
    for (let i = 0; i < REWRITE_HISTORY_CAP + 5; i++) {
      s = pushEntry(s, `old${i}`, `new${i}`, i)
    }
    expect(s).toHaveLength(REWRITE_HISTORY_CAP)
    // 最早 5 条（old0..old4）应被丢弃，保留最后 10 条
    expect(s[0].oldSnippet).toBe(`old${5}`)
    expect(s[s.length - 1].oldSnippet).toBe(`old${REWRITE_HISTORY_CAP + 4}`)
  })

  it('pops most recent entry (LIFO)', () => {
    const s = pushEntry(
      pushEntry([], 'a', 'A', 1),
      'b',
      'B',
      2
    )
    const r1 = popEntry(s)
    expect(r1.popped?.oldSnippet).toBe('b')
    expect(r1.next).toHaveLength(1)
    const r2 = popEntry(r1.next)
    expect(r2.popped?.oldSnippet).toBe('a')
    expect(r2.next).toHaveLength(0)
  })

  it('pop on empty stack returns null popped', () => {
    const r = popEntry([])
    expect(r.popped).toBe(null)
    expect(r.next).toEqual([])
  })

  it('popEntryAt pops from top (fromTop=0) like popEntry', () => {
    const s = pushEntry(
      pushEntry(
        pushEntry([], 'a', 'A', 1),
        'b',
        'B',
        2
      ),
      'c',
      'C',
      3
    )
    const r = popEntryAt(s, 0)
    expect(r.popped?.oldSnippet).toBe('c')
    expect(r.next).toHaveLength(2)
  })

  it('popEntryAt pops from middle (fromTop=1)', () => {
    const s = pushEntry(
      pushEntry(
        pushEntry([], 'a', 'A', 1),
        'b',
        'B',
        2
      ),
      'c',
      'C',
      3
    )
    // 栈是 [a, b, c]，fromTop=1 = 弹出 b
    const r = popEntryAt(s, 1)
    expect(r.popped?.oldSnippet).toBe('b')
    expect(r.next.map((e) => e.oldSnippet)).toEqual(['a', 'c'])
  })

  it('popEntryAt pops oldest (fromTop = length-1)', () => {
    const s = pushEntry(
      pushEntry(
        pushEntry([], 'a', 'A', 1),
        'b',
        'B',
        2
      ),
      'c',
      'C',
      3
    )
    const r = popEntryAt(s, 2)
    expect(r.popped?.oldSnippet).toBe('a')
    expect(r.next.map((e) => e.oldSnippet)).toEqual(['b', 'c'])
  })

  it('popEntryAt out-of-range returns null and preserves stack', () => {
    const s = pushEntry([], 'a', 'A', 1)
    const r1 = popEntryAt(s, 5)
    expect(r1.popped).toBe(null)
    expect(r1.next).toEqual(s)
    const r2 = popEntryAt(s, -1)
    expect(r2.popped).toBe(null)
    expect(r2.next).toEqual(s)
  })

  it('popEntryAt on empty stack returns null and empty array', () => {
    const r = popEntryAt([], 0)
    expect(r.popped).toBe(null)
    expect(r.next).toEqual([])
  })

  it('popEntryAt preserves relative order of remaining entries', () => {
    let s: ReturnType<typeof pushEntry> = []
    for (let i = 0; i < 5; i++) {
      s = pushEntry(s, `old${i}`, `new${i}`, i)
    }
    // 弹出 fromTop=2（old2）
    const r = popEntryAt(s, 2)
    expect(r.next.map((e) => e.oldSnippet)).toEqual(['old0', 'old1', 'old3', 'old4'])
  })

  it('does not mutate the original stack (immutability)', () => {
    const s: ReturnType<typeof pushEntry> = []
    const s2 = pushEntry(s, 'x', 'X', 1)
    expect(s).toHaveLength(0)
    expect(s2).toHaveLength(1)
    const s3 = popEntry(s2)
    expect(s2).toHaveLength(1) // 原栈不受影响
    expect(s3.next).toHaveLength(0)
  })
})

describe('applyToDraft / revertInDraft (draft 操作)', () => {
  const sample =
    '他嘴角带了点弧度，没说话。她站在门口，谁也没看。'

  it('applyToDraft replaces oldSnippet with newText', () => {
    const next = applyToDraft(sample, '他嘴角带了点弧度', '他笑了一下')
    expect(next).toBe('他笑了一下，没说话。她站在门口，谁也没看。')
  })

  it('applyToDraft returns draft unchanged when oldSnippet not found', () => {
    const next = applyToDraft(sample, '不存在的片段', '替换')
    expect(next).toBe(sample)
  })

  it('applyToDraft replaces only first occurrence', () => {
    const dup = 'X-A-X-B-X'
    const next = applyToDraft(dup, 'X', 'Y')
    expect(next).toBe('Y-A-X-B-X')
  })

  it('revertInDraft replaces newText with oldSnippet', () => {
    const afterApply = applyToDraft(sample, '他嘴角带了点弧度', '他笑了一下')
    const reverted = revertInDraft(afterApply, '他笑了一下', '他嘴角带了点弧度')
    expect(reverted).toBe(sample)
  })

  it('revertInDraft returns draft unchanged when newText not found', () => {
    const next = revertInDraft(sample, '不存在的改写文本', '还原')
    expect(next).toBe(sample)
  })

  it('apply then revert roundtrip preserves original', () => {
    const original = '原文中段。后面还有更多。'
    const after = applyToDraft(original, '中段', '改写后中段')
    const reverted = revertInDraft(after, '改写后中段', '中段')
    expect(reverted).toBe(original)
  })

  it('handles multi-line content with paragraphs', () => {
    const draft = '第一段。\n\n他似乎在想什么。\n\n第三段。'
    const after = applyToDraft(draft, '他似乎在想什么', '他沉默了一会儿')
    expect(after).toBe('第一段。\n\n他沉默了一会儿。\n\n第三段。')
  })
})

describe('应用 + 撤销集成 (模拟批量改写 → 全撤销)', () => {
  it('reverting all entries returns to original', () => {
    let draft = '原文第一段。\n\n原文第二段。\n\n原文第三段。'
    const edits: Array<{ oldSnippet: string; newText: string }> = [
      { oldSnippet: '原文第一段', newText: '改写第一段' },
      { oldSnippet: '原文第二段', newText: '改写第二段' },
      { oldSnippet: '原文第三段', newText: '改写第三段' }
    ]
    // apply 全部
    for (const e of edits) {
      draft = applyToDraft(draft, e.oldSnippet, e.newText)
    }
    expect(draft).toBe('改写第一段。\n\n改写第二段。\n\n改写第三段。')
    // 倒序撤销全部
    for (let i = edits.length - 1; i >= 0; i--) {
      draft = revertInDraft(draft, edits[i].newText, edits[i].oldSnippet)
    }
    expect(draft).toBe('原文第一段。\n\n原文第二段。\n\n原文第三段。')
  })

  it('handles apply with newText that contains oldSnippet as substring (no false match)', () => {
    // 边界：oldSnippet="X"、newText="X Y"——后续撤销时不能错把别的"X"还原
    const original = 'X 和别的内容。'
    const after = applyToDraft(original, 'X', 'X Y')
    expect(after).toBe('X Y 和别的内容。')
    // 撤销：应只还原第一个"X Y"成"X"
    const reverted = revertInDraft(after, 'X Y', 'X')
    expect(reverted).toBe('X 和别的内容。')
  })
})

describe('pushEntry with violationKey + findEntryByViolationKey (P6-B)', () => {
  it('pushEntry accepts optional violationKey', () => {
    const next = pushEntry([], 'old', 'new', 1000, 'forbidden_word:似乎:42')
    expect(next[0].violationKey).toBe('forbidden_word:似乎:42')
  })

  it('pushEntry without violationKey leaves field undefined', () => {
    const next = pushEntry([], 'old', 'new', 1000)
    expect(next[0].violationKey).toBeUndefined()
  })

  it('pushEntry with explicit undefined is same as omitting', () => {
    const next = pushEntry([], 'old', 'new', 1000, undefined)
    expect(next[0].violationKey).toBeUndefined()
  })

  it('findEntryByViolationKey finds latest matching entry (P6-B semantics)', () => {
    let s: ReturnType<typeof pushEntry> = []
    s = pushEntry(s, 'old1', 'new1', 1000, 'V1')
    s = pushEntry(s, 'old2', 'new2', 2000, 'V2')
    s = pushEntry(s, 'old3', 'new3', 3000, 'V1') // V1 第二次 apply
    const idx = findEntryByViolationKey(s, 'V1')
    expect(idx).toBe(2) // 最新的 V1 entry
  })

  it('findEntryByViolationKey returns -1 for missing key', () => {
    const s = pushEntry([], 'old', 'new', 1000, 'V1')
    expect(findEntryByViolationKey(s, 'V_unknown')).toBe(-1)
  })

  it('findEntryByViolationKey returns -1 for empty stack', () => {
    expect(findEntryByViolationKey([], 'V1')).toBe(-1)
  })

  it('findEntryByViolationKey skips entries without violationKey', () => {
    let s: ReturnType<typeof pushEntry> = []
    s = pushEntry(s, 'old1', 'new1', 1000) // 无 violationKey
    s = pushEntry(s, 'old2', 'new2', 2000, 'V2')
    expect(findEntryByViolationKey(s, 'V1')).toBe(-1)
    expect(findEntryByViolationKey(s, 'V2')).toBe(1)
  })

  it('scenario: apply A → apply B → undo A leaves B intact (P6-B accurate undo)', () => {
    let s: ReturnType<typeof pushEntry> = []
    s = pushEntry(s, 'snippetA', 'rewrittenA', 1000, 'key-A')
    s = pushEntry(s, 'snippetB', 'rewrittenB', 2000, 'key-B')
    // 用户点 A 的"撤销这次"——按 key-A 找 → 找最近的（应是 0 索引的 A）
    const idx = findEntryByViolationKey(s, 'key-A')
    expect(idx).toBe(0)
    // 弹掉 A，保留 B（用直接 splice，与 ChapterEditor undoRewriteByKey 行为一致）
    const r = { next: [...s.slice(0, idx), ...s.slice(idx + 1)], popped: s[idx] }
    expect(r.popped?.oldSnippet).toBe('snippetA')
    expect(r.next).toHaveLength(1)
    expect(r.next[0].violationKey).toBe('key-B')
  })

  it('scenario: same key applied twice → undo only pops the latest, leaves earlier copy', () => {
    // 边界：用户 humanize → apply 同一违例两次（re-audit 后又出现），
    // 撤销这次应只撤最近一次，不影响前一次
    let s: ReturnType<typeof pushEntry> = []
    s = pushEntry(s, 'snippetV1', 'rewrittenV1', 1000, 'V')
    s = pushEntry(s, 'snippetV2', 'rewrittenV2', 2000, 'V') // 同一违例的二次 apply
    const idx = findEntryByViolationKey(s, 'V')
    expect(idx).toBe(1)
    const r = { next: [...s.slice(0, idx), ...s.slice(idx + 1)], popped: s[idx] }
    expect(r.next).toHaveLength(1)
    expect(r.next[0].oldSnippet).toBe('snippetV1')
  })
})

describe('pushRedo / popRedo / clearRedoStack (P7-A)', () => {
  it('pushRedo appends to redo stack', () => {
    const next = pushRedo([], { oldSnippet: 'A', newText: 'rewritten A', at: 1000 })
    expect(next).toHaveLength(1)
    expect(next[0].oldSnippet).toBe('A')
  })

  it('pushRedo caps at REWRITE_HISTORY_CAP, dropping oldest (FIFO)', () => {
    let redo: ReturnType<typeof pushRedo> = []
    for (let i = 0; i < REWRITE_HISTORY_CAP + 5; i++) {
      redo = pushRedo(redo, { oldSnippet: `old${i}`, newText: `new${i}`, at: i })
    }
    expect(redo).toHaveLength(REWRITE_HISTORY_CAP)
    expect(redo[0].oldSnippet).toBe(`old${5}`)
    expect(redo[redo.length - 1].oldSnippet).toBe(`old${REWRITE_HISTORY_CAP + 4}`)
  })

  it('popRedo pops most recent (LIFO)', () => {
    const redo = pushRedo(
      pushRedo([], { oldSnippet: 'A', newText: 'a', at: 1 }),
      { oldSnippet: 'B', newText: 'b', at: 2 }
    )
    const r1 = popRedo(redo)
    expect(r1.popped?.oldSnippet).toBe('B')
    expect(r1.next).toHaveLength(1)
    const r2 = popRedo(r1.next)
    expect(r2.popped?.oldSnippet).toBe('A')
    expect(r2.next).toHaveLength(0)
  })

  it('popRedo on empty stack returns null', () => {
    const r = popRedo([])
    expect(r.popped).toBe(null)
    expect(r.next).toEqual([])
  })

  it('clearRedoStack returns empty array', () => {
    expect(clearRedoStack()).toEqual([])
  })

  it('preserves violationKey through pushRedo (for per-violation redo in future)', () => {
    const e: RewriteEntry = {
      oldSnippet: 'old',
      newText: 'new',
      at: 1000,
      violationKey: 'forbidden_word:似乎:42'
    }
    const next = pushRedo([], e)
    expect(next[0].violationKey).toBe('forbidden_word:似乎:42')
  })
})

describe('apply/undo/redo roundtrip (P7-A 集成场景)', () => {
  it('apply A → apply B → undo → undo → redo → redo: 完整状态机', () => {
    // 1. 初始 draft
    let draft = '原文中段1。\n\n原文中段2。'
    const hist: RewriteEntry[] = []
    const redo: RewriteEntry[] = []

    // 2. apply A
    let s = pushEntry(hist, '原文中段1', '改写1', 1000)
    draft = applyToDraft(draft, '原文中段1', '改写1')
    expect(draft).toBe('改写1。\n\n原文中段2。')
    expect(redo).toHaveLength(0) // 新 apply 清空 redo

    // 3. apply B
    s = pushEntry(s, '原文中段2', '改写2', 2000)
    draft = applyToDraft(draft, '原文中段2', '改写2')
    expect(draft).toBe('改写1。\n\n改写2。')

    // 4. undo（撤销 B）
    const r1 = popEntry(s)
    s = r1.next
    const rB = r1.popped!
    draft = revertInDraft(draft, rB.newText, rB.oldSnippet)
    let r: RewriteEntry[] = pushRedo(redo, rB)
    expect(draft).toBe('改写1。\n\n原文中段2。')
    expect(s).toHaveLength(1) // history 只剩 A

    // 5. undo（撤销 A）
    const r2 = popEntry(s)
    s = r2.next
    const rA = r2.popped!
    draft = revertInDraft(draft, rA.newText, rA.oldSnippet)
    r = pushRedo(r, rA)
    expect(draft).toBe('原文中段1。\n\n原文中段2。')
    expect(s).toHaveLength(0) // history 空
    expect(r).toHaveLength(2) // redo 里有 B + A

    // 6. redo（重做 A）
    const r3 = popRedo(r)
    let rStack = r3.next
    const redoA = r3.popped!
    draft = applyToDraft(draft, redoA.oldSnippet, redoA.newText)
    s = pushEntry(s, redoA.oldSnippet, redoA.newText, redoA.at, redoA.violationKey)
    expect(draft).toBe('改写1。\n\n原文中段2。')
    expect(rStack).toHaveLength(1) // redo 只剩 B

    // 7. redo（重做 B）
    const r4 = popRedo(rStack)
    rStack = r4.next
    const redoB = r4.popped!
    draft = applyToDraft(draft, redoB.oldSnippet, redoB.newText)
    s = pushEntry(s, redoB.oldSnippet, redoB.newText, redoB.at, redoB.violationKey)
    expect(draft).toBe('改写1。\n\n改写2。')
    expect(rStack).toHaveLength(0) // redo 空
    expect(s).toHaveLength(2) // history 恢复 A + B
  })

  it('undo 后 apply 新条目 → redoStack 必须被清空', () => {
    let hist: RewriteEntry[] = []
    hist = pushEntry(hist, 'A', 'a', 1000)
    let redo: RewriteEntry[] = []
    redo = pushRedo(redo, hist[0])
    expect(redo).toHaveLength(1)

    // 新 apply：必须清空 redo
    hist = pushEntry(hist, 'B', 'b', 2000)
    redo = clearRedoStack()
    expect(redo).toHaveLength(0) // 新 apply 后无法 redo 旧路径
  })

  it('redo 失败时条目应回到 redoStack（用户可重试）', () => {
    const redo: RewriteEntry[] = [{ oldSnippet: 'missing', newText: 'x', at: 1000 }]
    const draft = '完全不同内容的正文。'
    // 模拟完整 redo 流程：先 pop 出栈
    const popped = popRedo(redo)
    expect(popped.popped?.oldSnippet).toBe('missing')
    expect(popped.next).toHaveLength(0)
    // 模拟 applyToDraft 失败（找不到 oldSnippet）
    const next = applyToDraft(draft, popped.popped!.oldSnippet, popped.popped!.newText)
    expect(next).toBe(draft) // 没替换
    // 调用方应把条目塞回 redoStack
    const restored = pushRedo(popped.next, popped.popped!)
    expect(restored).toHaveLength(1) // 还是 1 条
    expect(restored[0].oldSnippet).toBe('missing')
  })
})

describe('detectUndoRedoShortcut (P8-B 跨平台快捷键解析)', () => {
  it('Ctrl+Z (no shift) on body → undo', () => {
    expect(
      detectUndoRedoShortcut({
        ctrl: true, meta: false, shift: false, alt: false,
        key: 'z', targetTag: 'DIV'
      })
    ).toBe('undo')
  })

  it('Ctrl+Shift+Z → redo (standard cross-platform)', () => {
    expect(
      detectUndoRedoShortcut({
        ctrl: true, meta: false, shift: true, alt: false,
        key: 'Z', targetTag: 'BODY'
      })
    ).toBe('redo')
  })

  it('Cmd+Z (macOS) → undo', () => {
    expect(
      detectUndoRedoShortcut({
        ctrl: false, meta: true, shift: false, alt: false,
        key: 'z', targetTag: 'DIV'
      })
    ).toBe('undo')
  })

  it('Cmd+Shift+Z (macOS) → redo', () => {
    expect(
      detectUndoRedoShortcut({
        ctrl: false, meta: true, shift: true, alt: false,
        key: 'z', targetTag: 'DIV'
      })
    ).toBe('redo')
  })

  it('Ctrl+Y (Windows convention) → redo', () => {
    expect(
      detectUndoRedoShortcut({
        ctrl: true, meta: false, shift: false, alt: false,
        key: 'y', targetTag: 'DIV'
      })
    ).toBe('redo')
  })

  it('Ctrl+Shift+Y → null (not a standard shortcut)', () => {
    expect(
      detectUndoRedoShortcut({
        ctrl: true, meta: false, shift: true, alt: false,
        key: 'y', targetTag: 'DIV'
      })
    ).toBe(null)
  })

  it('plain z (no mod) → null', () => {
    expect(
      detectUndoRedoShortcut({
        ctrl: false, meta: false, shift: false, alt: false,
        key: 'z', targetTag: 'DIV'
      })
    ).toBe(null)
  })

  it('Ctrl+Alt+Z → null (alt 不参与)', () => {
    expect(
      detectUndoRedoShortcut({
        ctrl: true, meta: false, shift: false, alt: true,
        key: 'z', targetTag: 'DIV'
      })
    ).toBe(null)
  })

  it('key 大写也识别（key="Z" 而非 "z"）', () => {
    expect(
      detectUndoRedoShortcut({
        ctrl: true, meta: false, shift: false, alt: false,
        key: 'Z', targetTag: 'DIV'
      })
    ).toBe('undo')
  })

  // textarea/input 内的核心行为：让原生 undo 处理
  it('in textarea → null (保留原生 text undo)', () => {
    expect(
      detectUndoRedoShortcut({
        ctrl: true, meta: false, shift: false, alt: false,
        key: 'z', targetTag: 'TEXTAREA'
      })
    ).toBe(null)
  })

  it('in input → null', () => {
    expect(
      detectUndoRedoShortcut({
        ctrl: true, meta: false, shift: false, alt: false,
        key: 'z', targetTag: 'INPUT'
      })
    ).toBe(null)
  })

  it('in select → null', () => {
    expect(
      detectUndoRedoShortcut({
        ctrl: true, meta: false, shift: false, alt: false,
        key: 'z', targetTag: 'SELECT'
      })
    ).toBe(null)
  })

  it('in BUTTON (e.g. 撤销 button focused) → undo/redo 仍生效', () => {
    // 防止 button focus 后快捷键失效
    expect(
      detectUndoRedoShortcut({
        ctrl: true, meta: false, shift: false, alt: false,
        key: 'z', targetTag: 'BUTTON'
      })
    ).toBe('undo')
  })

  it('case-insensitive tag name (lowercase target tag also works)', () => {
    expect(
      detectUndoRedoShortcut({
        ctrl: true, meta: false, shift: false, alt: false,
        key: 'z', targetTag: 'textarea'
      })
    ).toBe(null)
  })

  it('empty targetTag falls through to undo (no input/textarea match)', () => {
    expect(
      detectUndoRedoShortcut({
        ctrl: true, meta: false, shift: false, alt: false,
        key: 'z', targetTag: ''
      })
    ).toBe('undo')
  })

  it('undefined targetTag also falls through', () => {
    expect(
      detectUndoRedoShortcut({
        ctrl: true, meta: false, shift: false, alt: false,
        key: 'z'
      } as Parameters<typeof detectUndoRedoShortcut>[0])
    ).toBe('undo')
  })
})
