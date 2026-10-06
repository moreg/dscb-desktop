/** agy 模型显示名里的档位（例如 `Gemini 3.1 Pro (High)`）。 */
export type AntigravityModelTier = 'Low' | 'Medium' | 'High'

const TIER_RE = /^(.*) \((Low|Medium|High)\)$/

export function antigravityModelTier(model: string): AntigravityModelTier | null {
  return (model.match(TIER_RE)?.[2] as AntigravityModelTier | undefined) ?? null
}

/** 只返回与当前模型同一系列、且确实由 agy 提供的档位模型。 */
export function antigravityTierVariants(currentModel: string, availableModels: string[]): string[] {
  const family = currentModel.match(TIER_RE)?.[1]
  if (!family) return []
  return availableModels.filter((model) => model.match(TIER_RE)?.[1] === family)
}

/** 只切换到实时模型列表中、与当前模型同系列的目标档位。缺档时保持原模型。 */
export function antigravityModelForEffort(
  currentModel: string,
  effort: string | undefined,
  availableModels: string[]
): string {
  const tier = effort === 'low' ? 'Low' : effort === 'medium' ? 'Medium' : effort === 'high' ? 'High' : null
  if (!tier) return currentModel
  return antigravityTierVariants(currentModel, availableModels).find((model) => antigravityModelTier(model) === tier) ?? currentModel
}
