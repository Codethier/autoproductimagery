import { registerHooks } from 'node:module'

// Match Nuxt's extensionless TypeScript imports when running source in Node.
const roots = ['server/', 'schemas/', 'app/'].map(path => new URL(`../${path}`, import.meta.url).href)
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)
        && roots.some(root => context.parentURL?.startsWith(root))) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})
