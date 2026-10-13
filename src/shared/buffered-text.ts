export function createBufferedText(consume: (text: string) => void, interval = 40) {
  let chunks: string[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    chunks = []
  }
  const flush = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (!chunks.length) return
    const text = chunks.join('')
    chunks = []
    consume(text)
  }
  return {
    push(text: string) {
      if (!text) return
      chunks.push(text)
      if (timer === undefined) timer = setTimeout(flush, interval)
    },
    flush,
    clear
  }
}
