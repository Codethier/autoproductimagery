import type {PipelineNode, PipelineRunDTO} from '../../schemas/pipelines'
import {hasConfirmedGenerationPrice} from '../../schemas/generation-billing'

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

// Rerun repeats only the saved job's participating nodes. The editor can have
// changed since the run was created, so it must not decide credit admission.
export function pipelineRerunUsesCredit(run: PipelineRunDTO, itemId: string): boolean {
  const nodes = new Set(run.items.find(item => item.id === itemId)?.steps.map(step => step.nodeId) ?? [])
  return run.definition.nodes.some(node => nodes.has(node.id) && pipelineNodeUsesCredit(node))
}

export function pipelineJobRerunBlockedReason(run: PipelineRunDTO, itemId: string): string {
  const item = run.items.find(value => value.id === itemId)
  if (!item || item.status !== 'succeeded' || !item.steps.length || item.steps.some(step => step.status !== 'succeeded'))
    return 'Only completed jobs can be rerun. Use Retry failed steps for failed or interrupted work.'
  if (run.cancelRequested && run.items.some(value => ['queued', 'running', 'awaiting-price'].includes(value.status)
    || value.steps.some(step => ['queued', 'running', 'awaiting-price'].includes(step.status))))
    return 'Wait for the remaining cancelled work to finish before rerunning a job.'
  if (item.steps.some(step => step.value?.images.some(image => image.generationId !== undefined && !hasConfirmedGenerationPrice(image))))
    return 'Wait for this job’s exact prices to be confirmed before rerunning it.'
  if (item.steps.some(step => (step.attempt ?? 1) >= 5))
    return 'This job has reached its five-attempt limit. Start a new run for more variants.'
  return ''
}
