import * as path from 'path'
import * as os from 'os'
import * as jsYaml from 'js-yaml'
import * as t from 'io-ts'
import {tryCatch} from 'fp-ts/lib/Either'
import * as util from 'util'
import * as eslint from 'eslint'
import * as presets from './presets'

type MatchAll = (text: string, pattern: string | RegExp) => Iterable<NonNullable<ReturnType<string['match']>>>
const matchAll: MatchAll = require('string.prototype.matchall')

export {Preset} from './presets'

export {presets}

export const processors: Record<string, eslint.Linter.LintOptions> = {
  '.md': {
    preprocess: text => [
      '/* eslint-disable prettier/prettier */ // eslint-plugin-codegen:remove' +
        os.EOL +
        text
          .split(/\r?\n/)
          .map(line => `// eslint-plugin-codegen:trim${line}`)
          .join(os.EOL),
    ],
    postprocess: messageLists => ([] as eslint.Linter.LintMessage[]).concat(...messageLists),
    // @ts-ignore
    supportsAutofix: true,
  },
}

const codegen: eslint.Rule.RuleModule = {
  // @ts-ignore
  meta: {fixable: true},
  create: (context: eslint.Rule.RuleContext) => {
    const validate = () => {
      let sourceCode = context
        .getSourceCode()
        .text.split(os.EOL)
        .filter(line => !line.includes('eslint-plugin-codegen:remove'))
        .map(line => `${line}`.replace('// eslint-plugin-codegen:trim', ''))
        .join(os.EOL)

      const markersByExtension: Record<string, {start: RegExp; end: RegExp}> = {
        '.md': {
          start: /<!-- codegen:start (.*?) ?-->/g,
          end: /<!-- codegen:end -->/g,
        },
        '.ts': {
          start: /\/\/ codegen:start ?(.*)/g,
          end: /\/\/ codegen:end/g,
        },
      }
      markersByExtension['.js'] = markersByExtension['.ts']

      const markers = markersByExtension[path.extname(context.getFilename())]
      const position = (index?: number) => {
        const stringUpToPosition = sourceCode.slice(0, index)
        const lines = stringUpToPosition.split(os.EOL)
        return {line: lines.length, column: lines[lines.length - 1].length}
      }

      const startMatches = [...matchAll(sourceCode, markers.start)]
      startMatches.forEach((startMatch, startMatchesIndex) => {
        if (typeof startMatch.index !== 'number') {
          return context.report({message: `Couldn't parse file`, loc: {line: 1, column: 0}})
        }
        const prevCharacter = sourceCode[startMatch.index - 1]
        if (prevCharacter && prevCharacter !== '\n') {
          return
        }
        const start = position(startMatch.index)
        const startMarkerLoc = {start, end: {...start, column: start.column + startMatch[0].length}}
        if (startMatch === startMatches.slice(0, startMatchesIndex).find(other => other[0] === startMatch[0])) {
          return context.report({message: `duplicate start marker`, loc: startMarkerLoc})
        }
        const searchForEndMarkerUpTo =
          startMatchesIndex === startMatches.length - 1 ? sourceCode.length : startMatches[startMatchesIndex + 1].index
        const endMatch = [...matchAll(sourceCode.slice(0, searchForEndMarkerUpTo), markers.end)].find(
          e => e.index! > startMatch.index!
        )
        if (!endMatch) {
          const afterStartMatch = startMatch.index + startMatch[0].length
          return context.report({
            message: `couldn't find end marker (expected regex ${markers.end})`,
            loc: startMarkerLoc,
            fix: fixer =>
              fixer.replaceTextRange(
                [afterStartMatch, afterStartMatch],
                os.EOL + markers.end.source.replace(/\\/g, '')
              ),
          })
        }
        const maybeOptions = tryCatch(() => jsYaml.safeLoad(startMatch[1]), err => err)
        if (maybeOptions._tag === 'Left') {
          return context.report({message: `Error parsing options. ${maybeOptions.left}`, loc: startMarkerLoc})
        }
        const opts = maybeOptions.right || {}
        if (typeof (presets as any)[opts.preset] !== 'function') {
          return context.report({
            message: `unknown preset ${opts.preset}. Available presets: ${Object.keys(presets).join(', ')}`,
            loc: startMarkerLoc,
          })
        }

        const range: eslint.AST.Range = [startMatch.index + startMatch[0].length + os.EOL.length, endMatch.index!]
        const existingContent = sourceCode.slice(...range)
        const normalise = (val: string) => val.trim().replace(/\r?\n/g, os.EOL)

        const result = tryCatch(
          () => {
            const meta = {filename: context.getFilename(), existingContent}
            return presets[opts.preset as keyof typeof presets]({meta, options: opts})
          },
          err => `${err}`
        )

        if (result._tag === 'Left') {
          return context.report({message: result.left, loc: startMarkerLoc})
        }
        const expected = result.right
        if (normalise(existingContent) !== normalise(expected)) {
          const loc = {start: position(range[0]), end: position(range[1])}
          return context.report({
            message: `content doesn't match ${util.inspect({existingContent, expected})}`,
            loc,
            fix: fixer => fixer.replaceTextRange(range, normalise(expected) + os.EOL),
          })
        }

        return
      })
    }
    validate()
    return {}
  },
}

export const rules = {codegen}