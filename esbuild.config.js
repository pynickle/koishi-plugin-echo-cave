import { build } from 'esbuild'
import yamlPlugin from "esbuild-plugin-yaml";

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
    ],
    plugins: [yamlPlugin.yamlPlugin({})],
})
