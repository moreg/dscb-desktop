import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { contentRevision } from '../src/main/data/chapter-revision'
import { inspectMemoryCandidateItems } from '../src/main/data/memory-evidence-validator'

const root=process.env.CONTINUATION_VERIFY_DIR
if(!root)throw new Error('CONTINUATION_VERIFY_DIR required')
const base=join(root,'full-flow'),dir=join(base,'projects','novel')
const result=JSON.parse(readFileSync(join(base,'flow-result.json'),'utf8'))
const candidate=JSON.parse(readFileSync(join(dir,'.cache','memory-candidates','chapter-66.json'),'utf8'))
const prose=readFileSync(join(base,'result.txt'),'utf8')
const states=readFileSync(join(dir,'追踪','角色状态.md'),'utf8')
const verdicts=inspectMemoryCandidateItems(prose,candidate.extraction)
const stateChanges=candidate.extraction.characterStateChanges
const report={
  sourceHashMatches:contentRevision(prose)===candidate.sourceHash,
  resultContentMatches:prose===result.content,
  candidateStatus:candidate.status,
  evidenceItems:verdicts.length,
  evidenceKinds:verdicts.reduce((counts:Record<string,number>,v)=>{counts[v.kind]=(counts[v.kind]??0)+1;return counts},{}),
  evidenceIssues:verdicts.filter(v=>v.issues.length),
  stateChanges:stateChanges.length,
  missingStateValues:stateChanges.filter((s:{newValue:string})=>!states.includes(s.newValue)),
  memoryErrors:result.memoryApply?.errors,
  settingsErrors:result.settingsApply?.errors,
  selfCheck:result.selfCheck?.counts,
  autoDeslopStatus:result.autoDeslop?.status,
  automaticDeepReviewRan:result.deepReview?.length>0,
  note:'Exact source/ledger/evidence verification; does not replace independent semantic review. Empty deepReview is not proof that a review ran.'
}
writeFileSync(join(base,'memory-verification.json'),JSON.stringify(report,null,2))
console.log(JSON.stringify(report,null,2))
