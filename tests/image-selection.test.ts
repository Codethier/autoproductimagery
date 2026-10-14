import assert from 'node:assert/strict'
import test from 'node:test'
import {selectImageRange} from '../app/utils/imageSelection.ts'

const images = ['a', 'b', 'c', 'd', 'e']
test('Shift selects the inclusive visible range in either direction and preserves outside selections', () => {
    const selected = selectImageRange(['other-folder', 'b'], images, 'e', {anchor: 'b', shift: true, limit: 10})
    assert.deepEqual(selected, {selection: ['other-folder', 'b', 'c', 'd', 'e'], anchor: 'b', limited: false})
    assert.deepEqual(selectImageRange(['e'], images, 'b', {anchor: 'e', shift: true, limit: 10}), {selection: ['e', 'b', 'c', 'd'], anchor: 'e', limited: false})
    assert.deepEqual(selectImageRange(selected.selection, images, 'e', {anchor: 'b', shift: true, limit: 10}), selected)
})
test('Shift ranges honor the remaining model slots and never add duplicates or hidden entries', () => {
    assert.deepEqual(selectImageRange(['outside', 'a', 'a'], ['a', 'b', 'b', 'd'], 'd', {anchor: 'a', shift: true, limit: 3}), {selection: ['outside', 'a', 'b'], anchor: 'a', limited: true})
    assert.deepEqual(selectImageRange(['a'], images, 'e', {anchor: 'a', shift: true, limit: 1}), {selection: ['a'], anchor: 'a', limited: true})
    assert.deepEqual(selectImageRange([], images, 'not-visible', {anchor: 'a', shift: true, limit: 5}), {selection: [], anchor: 'a', limited: false})
})
test('stale anchors fall back to a normal toggle and single-image inputs never select a range', () => {
    assert.deepEqual(selectImageRange(['outside'], images, 'd', {anchor: 'previous-source', shift: true, limit: 5}), {selection: ['outside', 'd'], anchor: 'd', limited: false})
    assert.deepEqual(selectImageRange(['a'], images, 'd', {anchor: 'a', shift: true, limit: 1, single: true}), {selection: ['d'], anchor: 'd', limited: false})
    assert.deepEqual(selectImageRange(['d'], images, 'd', {limit: 1, single: true}), {selection: [], anchor: 'd', limited: false})
    for (const limit of [0, -1, NaN, Infinity, 1.5]) assert.deepEqual(selectImageRange([], images, 'a', {limit}).selection, [])
})
