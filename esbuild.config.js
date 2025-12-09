import { build } from 'esbuild'

await build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    outfile: 'lib/index.js',
    format: 'esm',
    platform: 'node',
    external: [
        'koishi',
        '@pynickle/koishi-plugin-adapter-onebot',
        'axios',
        'uuid'
    ]
})
