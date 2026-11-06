/**
 * 分镜「硬阻断」校验：渲染层与主进程共用的确定性纯函数。
 *
 * 本模块刻意：
 *  - 不 import zod；
 *  - 不 import 任何 Node 内置模块；
 *  - 只以 `import type` 引用 script-studio.ts 的类型（编译期擦除，不产生运行时依赖）；
 *  - 不从 script-studio.ts 引入任何运行时值。
 *
 * 因此渲染层可以安全地按值导入 `storyboardHardIssues`，不会把 zod / 校验逻辑
 * 打进前端 bundle。镜像常量的取值与顺序由 tests/script-studio-pure.test.ts 断言保证。
 */
import type { GateIssue, ShotField, StoryboardUnit } from './script-studio'

/** 与 script-studio.ts 中 MIN_UNIT_SEC / MAX_UNIT_SEC 保持一致的本地镜像。 */
export const GATE_MIN_UNIT_SEC = 4
export const GATE_MAX_UNIT_SEC = 15

/** 与 script-studio.ts 中 SHOT_FIELDS 顺序完全一致的本地镜像（11 字段）。 */
export const GATE_SHOT_FIELDS: readonly ShotField[] = [
  'focalLength',
  'aperture',
  'depthOfFieldAndFocusLock',
  'cameraPosition',
  'composition',
  'cameraMovement',
  'subjectActionExpression',
  'dialogueAndTone',
  'lighting',
  'constraints',
  'nextTransition'
]

/** 0.5 秒倍数判定；非有限数一律视为非法。 */
function isHalfStep(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value * 2 - Math.round(value * 2)) < 1e-9
}

/**
 * 计算分镜中不允许保存的硬错误。
 *
 * 检查范围与主进程 `validateStoryboard` 的硬阻断子集一致：
 *  1. 每个单元时长必须介于 4—15 秒且为 0.5 秒倍数；
 *  2. 每个单元至少有一个镜头；
 *  3. 每个镜头的 11 个字段全部非空。
 *
 * 不检查仅产生警告的项目（抽象心理词、风格暂定、无参考图等），
 * 也不依赖 zod / Node / 文件系统，可安全运行于渲染进程。
 */
export function storyboardHardIssues(units: StoryboardUnit[]): GateIssue[] {
  const issues: GateIssue[] = []
  if (!Array.isArray(units) || units.length === 0) {
    issues.push({ code: 'UNITS_EMPTY', severity: 'error', message: '分镜没有单元，请重新生成' })
    return issues
  }
  units.forEach((unit, unitIndex) => {
    const uid = unit.id || `unit-${unitIndex + 1}`
    const duration = unit.durationSec
    if (!Number.isFinite(duration) || duration < GATE_MIN_UNIT_SEC ||
      duration > GATE_MAX_UNIT_SEC || !isHalfStep(duration)) {
      issues.push({
        code: 'UNIT_DURATION',
        severity: 'error',
        unitId: uid,
        message: `单元 ${uid} 时长必须介于 ${GATE_MIN_UNIT_SEC}—${GATE_MAX_UNIT_SEC} 秒且为 0.5 秒倍数，当前为 ${duration}`
      })
    }
    const shots = Array.isArray(unit.shots) ? unit.shots : []
    if (!shots.length) {
      issues.push({
        code: 'SHOT_MISSING',
        severity: 'error',
        unitId: uid,
        message: `单元 ${uid} 没有镜头`
      })
    }
    shots.forEach((shot, shotIndex) => {
      for (const field of GATE_SHOT_FIELDS) {
        const raw = shot[field]
        const value = typeof raw === 'string' ? raw.trim() : ''
        if (!value) {
          issues.push({
            code: 'SHOT_FIELD_EMPTY',
            severity: 'error',
            unitId: uid,
            field,
            message: `单元 ${uid} 镜头 ${shotIndex + 1} 的 ${field} 为空`
          })
        }
      }
    })
  })
  return issues
}
