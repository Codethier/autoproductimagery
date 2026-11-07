type PositionedNode = {position: {x: number; y: number}}

/** Canvas reading order is presentation only; the DAG still governs execution. */
export function getPipelineDisplayNodes<T extends PositionedNode>(nodes: readonly T[]): T[] {
  return nodes.map((node, index) => ({node, index}))
    .sort((left, right) => left.node.position.x - right.node.position.x
      || left.node.position.y - right.node.position.y || left.index - right.index)
    .map(({node}) => node)
}
