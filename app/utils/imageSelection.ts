export type ImageSelectionResult = {selection: string[]; anchor: string; limited: boolean}

/** Select a visible range without dropping selections from other folders or people. */
export function selectImageRange(
    current: readonly string[], visible: readonly string[], target: string,
    options: {anchor?: string; shift?: boolean; limit: number; single?: boolean},
): ImageSelectionResult {
    const selected = [...new Set(current)]
    const ordered = [...new Set(visible)]
    const limit = Number.isInteger(options.limit) && options.limit >= 0 ? options.limit : 0
    const targetIndex = ordered.indexOf(target)
    const anchorIndex = options.anchor ? ordered.indexOf(options.anchor) : -1
    if (targetIndex < 0) return {selection: selected, anchor: options.anchor ?? '', limited: false}
    if (options.shift && !options.single && anchorIndex >= 0) {
        const range = ordered.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1)
        const existing = new Set(selected)
        const additions = range.filter(url => !existing.has(url))
        const available = Math.max(0, limit - selected.length)
        return {selection: [...selected, ...additions.slice(0, available)], anchor: options.anchor!, limited: additions.length > available}
    }
    if (selected.includes(target)) return {selection: selected.filter(url => url !== target), anchor: target, limited: false}
    if (!limit || (!options.single && selected.length >= limit)) return {selection: selected, anchor: target, limited: true}
    return {selection: options.single ? [target] : [...selected, target], anchor: target, limited: false}
}
