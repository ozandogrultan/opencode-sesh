import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(import.meta.url)
const babel = require("@babel/core")

const input = resolve(root, "tui-plugins/sesh-panel/tui.tsx")
const output = resolve(root, "dist/tui.js")

const result = babel.transformSync(readFileSync(input, "utf8"), {
  filename: input,
  babelrc: false,
  configFile: false,
  presets: [
    [require.resolve("babel-preset-solid"), { moduleName: "@opentui/solid", generate: "universal" }],
    [require.resolve("@babel/preset-typescript"), { isTSX: true, allExtensions: true }],
  ],
})

mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, result.code)
console.log(`built ${output}`)
