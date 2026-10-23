import { describe, it, expect, vi } from 'vitest'
import { restoreOmittedQuoteLines, restoreQuoteLineBreaks, repairFactQuotes } from '../src/main/data/deslop/fact-quote-repair'
import type { LlmService } from '../src/main/data/llm-service'

const original='韩素英问得直接。\n“您放掉报价，是为了这个线索？”\n申采恩接过查核副本。\n“我放的是一笔赔本保证”\n记录不能证明已经送达。'
describe('事实清单局部引句修正',()=>{
  it('restores more than eight layout-only mismatches without dropping facts or calling a model', async () => {
    const blocks = Array.from({ length: 20 }, (_, i) => `角色${i}说。\r\n\r\n“记录尚未核实${i}。”`)
    const text = blocks.join('\r\n')
    const facts = blocks.map((quote, i) => ({quote: quote.replace(/\r?\n/g, ''), keep: `归属与未决${i}`}))
    const generateStream = vi.fn()
    const result = await repairFactQuotes(text, facts, {llm: {generateStream} as unknown as LlmService})
    expect(result).toEqual(blocks.map((quote, i) => ({quote, keep: facts[i].keep})))
    expect(generateStream).not.toHaveBeenCalled()
  })
  it('layout matching rejects changed negation, punctuation, inline spaces, order and ambiguity', () => {
    expect(restoreQuoteLineBreaks('尚未核实。\n归属不明。', '已经核实。归属不明。')).toBeUndefined()
    expect(restoreQuoteLineBreaks('尚未核实。\n归属不明。', '归属不明。尚未核实。')).toBeUndefined()
    expect(restoreQuoteLineBreaks('尚未核实。\n归属不明。', '尚未核实，归属不明。')).toBeUndefined()
    expect(restoreQuoteLineBreaks('not now\nthen', 'notnowthen')).toBeUndefined()
    expect(restoreQuoteLineBreaks('甲尚未核实。\n归属不明。甲尚未核实。\n归属不明。', '甲尚未核实。归属不明。')).toBeUndefined()
  })
  it('漏掉中间动作时只从原稿补回连续原文',()=>{
    const quote='韩素英问得直接。\n“您放掉报价，是为了这个线索？”\n“我放的是一笔赔本保证”'
    expect(restoreOmittedQuoteLines(original,quote)).toBe(original.split('\n').slice(0,4).join('\n'))
  })
  it('不修正重复、倒序、改词、过远或单句引用',()=>{
    expect(restoreOmittedQuoteLines(original+'\n韩素英问得直接。','韩素英问得直接。\n申采恩接过查核副本。')).toBeUndefined()
    expect(restoreOmittedQuoteLines(original,'申采恩接过查核副本。\n韩素英问得直接。')).toBeUndefined()
    expect(restoreOmittedQuoteLines(original,'韩素英问得直接。\n记录可以证明已经送达。')).toBeUndefined()
    expect(restoreOmittedQuoteLines('第一句原文。\n'+'中间'.repeat(300)+'\n最后句原文。','第一句原文。\n最后句原文。')).toBeUndefined()
  })
  it('一次修正坏引句，正确条目、keep和次序保持原样',async()=>{
    const facts=[{quote:'韩素英问得直接。',keep:'韩素英提问'},{quote:'记录不能证明送达。',keep:'不能证明已经送达'}]
    const generateStream=vi.fn().mockResolvedValue(JSON.stringify({quotes:[{id:2,quote:'记录不能证明已经送达。',keep:'恶意更改'}]}))
    const repaired=await repairFactQuotes(original,facts,{llm:{generateStream} as unknown as LlmService})
    expect(repaired).toEqual([facts[0],{quote:'记录不能证明已经送达。',keep:facts[1].keep}])
    expect(facts[1].quote).toBe('记录不能证明送达。')
    expect(generateStream).toHaveBeenCalledTimes(1)
  })
  it.each([
    {quotes:[{id:1,quote:'韩素英问得直接。'}]},
    {quotes:[{id:2,quote:'原稿没有此句'}]},
    {quotes:[{id:2,quote:''}]},
    {quotes:[{id:2,quote:'韩素英问得直接。'},{id:2,quote:'记录不能证明已经送达。'}]}
  ])('错误id、无依据或重复结果均不能进入修订',async reply=>{
    const generateStream=vi.fn().mockResolvedValue(JSON.stringify(reply))
    expect(await repairFactQuotes(original,[{quote:'韩素英问得直接。',keep:'提问'},{quote:'不存在的引句',keep:'限制'}],{llm:{generateStream} as unknown as LlmService})).toBeUndefined()
    expect(generateStream).toHaveBeenCalledTimes(1)
  })
  it('全无依据不请求模型，修正中取消也不接受结果',async()=>{
    const controller=new AbortController()
    const generateStream=vi.fn(async()=>{controller.abort();return '{"quotes":[]}'})
    const llm={generateStream} as unknown as LlmService
    expect(await repairFactQuotes(original,[{quote:'原稿没有此句',keep:'凭空事实'}],{llm})).toBeUndefined()
    expect(generateStream).not.toHaveBeenCalled()
    await expect(repairFactQuotes(original,[{quote:'韩素英问得直接。',keep:'提问'},{quote:'不存在的引句',keep:'限制'}],{llm,signal:controller.signal})).rejects.toThrow('LLM_ABORTED')
  })
})
