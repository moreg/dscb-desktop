import { randomUUID } from 'crypto'
import type { IpcMainInvokeEvent } from 'electron'
import { abortStream, beginStream, endStream } from '../data/stream-abort-registry'

/** All chapter workflows share cancellation, including closing the originating window. */
export async function chapterRequest<T>(event: IpcMainInvokeEvent, requestId: string | undefined,
  action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const id = requestId ?? randomUUID()
  const signal = beginStream(id)
  const cancel = (): void => { abortStream(id) }
  event.sender.once?.('destroyed', cancel)
  try {
    if (signal.aborted || event.sender.isDestroyed?.()) throw new Error('LLM_ABORTED')
    return await action(signal)
  } finally {
    event.sender.removeListener?.('destroyed', cancel)
    endStream(id)
  }
}
