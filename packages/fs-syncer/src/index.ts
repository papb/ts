import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {getPaths, get, dedent} from './util'
import {fsSyncerFileTreeMarker, CreateSyncerParams, MergeStrategy} from './types'
import {yamlishPrinter} from './yaml'

export * from './types'
export * as jest from './jest'

export const defaultMergeStrategy: MergeStrategy = params =>
  params.targetContent && dedent(params.targetContent).trim() + os.EOL

export const isFsSyncerFileTree = (obj: any): boolean => Boolean(obj?.[fsSyncerFileTreeMarker])

const tryCatch = <T, U = undefined>(fn: () => T, onError: (error: unknown) => U = () => (undefined as any) as U) => {
  try {
    return fn()
  } catch (e: unknown) {
    return onError(e)
  }
}

/**
 * @experimental
 * More flexible alternative to @see fsSyncer.
 */
export const createFSSyncer = <T extends object>({
  baseDir,
  targetState,
  exclude = ['node_modules'],
  mergeStrategy = defaultMergeStrategy,
}: CreateSyncerParams<T>) => {
  const write = () => {
    fs.mkdirSync(baseDir, {recursive: true})
    const paths = getPaths(targetState)
    paths.forEach(p => {
      const filepath = path.join(baseDir, ...p)
      fs.mkdirSync(path.dirname(filepath), {recursive: true})

      let targetContent: string | undefined = `${get(targetState, p)}`

      const existingContent = tryCatch(() => fs.readFileSync(filepath).toString())
      targetContent = mergeStrategy({filepath, existingContent, targetContent})

      if (typeof targetContent === 'string') {
        fs.writeFileSync(filepath, targetContent)
      } else {
        fs.unlinkSync(filepath)
      }
    })
  }
  const readdir = (dir: string): T => {
    const result = fs.readdirSync(dir).reduce<T>((state, name) => {
      const subpath = path.join(dir, name)
      const relativePath = path.relative(baseDir, subpath)
      if (exclude.some(r => relativePath.match(r))) {
        return state
      }
      return {
        ...state,
        [name]: fs.statSync(subpath).isFile() ? fs.readFileSync(subpath).toString() : readdir(subpath),
      }
    }, {} as T)
    Object.defineProperty(result, fsSyncerFileTreeMarker, {value: 'directory', enumerable: false})
    return result
  }

  const read = (): any => (fs.existsSync(baseDir) ? readdir(baseDir) : {})

  const yaml = ({tab, path = []}: {tab?: string; path?: string[]} = {}): string =>
    yamlishPrinter(get(read(), path), tab)

  /** writes all target files to file system, and deletes files not in the target state object */
  const sync = () => {
    write()
    const fsState = read()
    const fsPaths = getPaths(fsState)
    fsPaths
      .filter(p => typeof get(targetState, p) === 'undefined')
      .forEach(p => fs.unlinkSync(path.join(baseDir, ...p)))
    return syncer
  }

  const add = (relativePath: string, content: string) => {
    const route = relativePath.split(/[/\\]/)
    let parent: any = targetState
    for (const segment of route.slice(0, -1)) {
      parent[segment] = parent[segment] ?? {}
      parent = parent[segment]
      if (typeof parent === 'string') {
        throw new TypeError(`Can't overwrite file with folder`)
      }
    }
    parent[route.length - 1] = content
  }

  const syncer = {read, yaml, write, sync, targetState, baseDir}

  return syncer
}

/**
 * A helper to read and write text files to a specified directory.
 *
 * @param baseDir file paths relative to this
 * @param targetState a nested dictionary. A string property is a file, with the key
 * being the filename and the value the content. A nested object represents a directory.
 */
export const fsSyncer = <T extends object>(baseDir: string, targetState: T) => {
  return createFSSyncer({
    baseDir,
    targetState,
    // legacy behaviour: no dedenting, so can't use defaultMergeStrategy
    mergeStrategy: params => params.targetContent,
  })
}
