import assert from 'node:assert/strict'
import test from 'node:test'
import {getPipelineDisplayNodes} from '../schemas/pipeline-display.ts'
import {createPipelineNode, getPipelineExecutionNodes, PipelineDefinitionSchema} from '../schemas/pipelines.ts'

test('canvas display order follows x, then y, preserving equal-position order without mutating nodes', () => {
  const nodes = Object.freeze([
    Object.freeze({id: 'right', position: Object.freeze({x: 900, y: 0})}),
    Object.freeze({id: 'lower', position: Object.freeze({x: 300, y: 400})}),
    Object.freeze({id: 'left', position: Object.freeze({x: -100, y: 800})}),
    Object.freeze({id: 'upper-first', position: Object.freeze({x: 300, y: 50})}),
    Object.freeze({id: 'upper-second', position: Object.freeze({x: 300, y: 50})}),
  ])
  assert.deepEqual(getPipelineDisplayNodes(nodes).map(node => node.id), ['left', 'upper-first', 'upper-second', 'lower', 'right'])
  assert.deepEqual(nodes.map(node => node.id), ['right', 'lower', 'left', 'upper-first', 'upper-second'])
  assert.equal(getPipelineDisplayNodes(nodes)[0], nodes[2])
  assert.deepEqual(getPipelineDisplayNodes([]), [])
})

test('canvas order can differ from execution order without bypassing a backward dependency', () => {
  const input = {...createPipelineNode('image-input', 'input'), position: {x: 800, y: 100}}
  const crop = {...createPipelineNode('crop', 'crop'), position: {x: 400, y: 100}}
  const output = {...createPipelineNode('output', 'output'), position: {x: 0, y: 100}}
  const graph = PipelineDefinitionSchema.parse({version: 1, nodes: [output, crop, input], edges: [
    {id: 'source', source: 'input', sourcePort: 'image', target: 'crop', targetPort: 'image'},
    {id: 'result', source: 'crop', sourcePort: 'image', target: 'output', targetPort: 'media'},
  ]})
  assert.deepEqual(getPipelineDisplayNodes(getPipelineExecutionNodes(graph)).map(node => node.id), ['output', 'crop', 'input'])
  assert.deepEqual(getPipelineExecutionNodes(graph).map(node => node.id), ['input', 'crop', 'output'])
  assert.deepEqual(graph.nodes.map(node => node.id), ['output', 'crop', 'input'])
})
