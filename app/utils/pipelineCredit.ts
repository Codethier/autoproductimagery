import type {PipelineNode, PipelineRunDTO} from '../../schemas/pipelines'

export function pipelineNodeUsesCredit(node: PipelineNode): boolean {
  return ['generate-image', 'expand', 'translate', 'describe-image', 'prompt-enhancer', 'llm'].includes(node.type)
    || (node.type === 'upscale' && node.config.mode === 'ai')
}

// A retry follows the saved run and its affected item steps. The graph currently
// being edited may differ, and a free failed step can have paid descendants.
export function pipelineRetryUsesCredit(run: PipelineRunDTO, stepIds: string[]): boolean {
  const requested = new Set(stepIds)
  return run.items.some(item => item.steps.filter(step => requested.has(step.id)).some(step => {
    const descendants = new Set([step.nodeId])
    let changed = true
    while (changed) {
      changed = false
      for (const edge of run.definition.edges) {
        if (descendants.has(edge.source) && !descendants.has(edge.target)) { descendants.add(edge.target); changed = true }
      }
    }
    return item.steps.some(affected => descendants.has(affected.nodeId)
      && run.definition.nodes.some(node => node.id === affected.nodeId && pipelineNodeUsesCredit(node)))
  }))
}
