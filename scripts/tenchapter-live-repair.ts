import { promises as fs } from 'fs'
import { join } from 'path'
import { MemoryWriter } from '../src/main/data/memory-writer'
import { hashProse } from '../src/main/data/memory/prose-memory-index'
import { ProseRepo } from '../src/main/data/skill-format/prose-repo'
import { ItemRepo } from '../src/main/data/memory/item-repo'
import { LocationRepo } from '../src/main/data/memory/location-repo'
import { findJsonObject } from '../src/shared/json-extract'
import { datedEntityNotes } from '../src/main/data/memory/observation-provenance'

async function main() {
  const root = process.env.TENCHAPTER_LIVE_DIR!
  if (!root) throw new Error('TENCHAPTER_LIVE_DIR required')
  const p = JSON.parse(await fs.readFile(join(root, 'project.json'), 'utf8'))
  const backup = join(root, 'before-provenance-repair')
  try { await fs.access(backup) } catch { await fs.cp(p.path, backup, { recursive: true }) }
  const repo = new ProseRepo(p.path)
  const before = await Promise.all(Array.from({ length: 10 }, (_, i) => repo.read(i + 1).then(hashProse)))
  await new MemoryWriter(p.path).dateLegacyObservations()
  // This run retains original real responses across a hard kill. Recover provenance
  // for old entity names no longer present in the replacement extraction; only
  // unchanged notes from requests containing the exact still-approved prose qualify.
  for (const file of (await fs.readdir(join(root, 'calls'))).filter(f => f.endsWith('-request.json'))) {
    const request = JSON.parse(await fs.readFile(join(root, 'calls', file), 'utf8'))
    if (request.kind !== 'memory' || !request.chapter) continue
    const body = await repo.read(request.chapter)
    const candidate = JSON.parse(await fs.readFile(join(p.path, '.cache', 'memory-candidates', `chapter-${request.chapter}.json`), 'utf8'))
    if (candidate.sourceHash !== hashProse(body) || !JSON.stringify(request).includes(JSON.stringify(body).slice(1, -1))) continue
    let response = ''
    try {
      for (const line of (await fs.readFile(join(root, 'calls', file.replace('-request.json', '-response.txt')), 'utf8')).split('\n')) {
        if (!line.startsWith('data: ') || line.slice(6).trim() === '[DONE]') continue
        response += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || ''
      }
    } catch { continue }
    const parsed = findJsonObject(response)
    for (const [entityRepo, observations] of [[new ItemRepo(p.path), parsed?.newItems], [new LocationRepo(p.path), parsed?.newLocations]] as const) {
      if (!Array.isArray(observations)) continue
      for (const observation of observations) {
        const entity = (await entityRepo.list()).find(e => e.name === observation.name && e.notes === observation.notes)
        if (entity?.notes) await entityRepo.update(entity.id, { notes: datedEntityNotes(entity.notes, request.chapter) })
      }
    }
  }
  const after = await Promise.all(Array.from({ length: 10 }, (_, i) => repo.read(i + 1).then(hashProse)))
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Unexpected prose change')
  await fs.writeFile(join(root, 'provenance-repair.json'), JSON.stringify({ time: new Date().toISOString(), unchangedProseHashes: after }, null, 2))
  console.log('Dated verified entity observations; all ten prose hashes unchanged')
}
main().catch(e => { console.error(e); process.exitCode = 1 })
