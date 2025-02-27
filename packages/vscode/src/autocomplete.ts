import type { UnocssAutocomplete } from '@unocss/autocomplete'
import { createAutocomplete } from '@unocss/autocomplete'
import type { CompletionItemProvider, Disposable, ExtensionContext } from 'vscode'
import { CompletionItem, CompletionItemKind, CompletionList, MarkdownString, Range, languages, window, workspace } from 'vscode'
import type { UnoGenerator, UnocssPluginContext } from '@unocss/core'
import { getCSS, getColorString, getPrettiedCSS, getPrettiedMarkdown, isSubdir } from './utils'
import { log } from './log'
import type { ContextLoader } from './contextLoader'
import { isCssId } from './integration'

const defaultLanguageIds = [
  'erb',
  'haml',
  'hbs',
  'html',
  'css',
  'postcss',
  'javascript',
  'javascriptreact',
  'markdown',
  'ejs',
  'php',
  'svelte',
  'typescript',
  'typescriptreact',
  'vue-html',
  'vue',
  'sass',
  'scss',
  'less',
  'stylus',
  'astro',
  'rust',
]
const delimiters = ['-', ':']

class UnoCompletionItem extends CompletionItem {
  uno: UnoGenerator
  value: string

  constructor(label: string, kind: CompletionItemKind, value: string, uno: UnoGenerator) {
    super(label, kind)
    this.uno = uno
    this.value = value
  }
}

export async function registerAutoComplete(
  cwd: string,
  contextLoader: ContextLoader,
  ext: ExtensionContext,
) {
  const allLanguages = await languages.getLanguages()
  const autoCompletes = new Map<UnocssPluginContext, UnocssAutocomplete>()
  contextLoader.events.on('contextReload', (ctx) => {
    autoCompletes.delete(ctx)
  })
  contextLoader.events.on('contextUnload', (ctx) => {
    autoCompletes.delete(ctx)
  })

  function getAutocomplete(ctx: UnocssPluginContext) {
    const cached = autoCompletes.get(ctx)
    if (cached)
      return cached

    const autocomplete = createAutocomplete(ctx.uno)

    autoCompletes.set(ctx, autocomplete)
    return autocomplete
  }

  async function getMarkdown(uno: UnoGenerator, util: string) {
    return new MarkdownString(await getPrettiedMarkdown(uno, util))
  }

  function validateLanguages(targets: string[]) {
    const unValidLanguages: string[] = []
    const validLanguages = targets.filter((language) => {
      if (!allLanguages.includes(language)) {
        unValidLanguages.push(language)
        return false
      }
      return true
    })
    if (unValidLanguages.length)
      window.showWarningMessage(`These language configurations are illegal: ${unValidLanguages.join(',')}`)

    return validLanguages
  }

  const provider: CompletionItemProvider<UnoCompletionItem> = {
    async provideCompletionItems(doc, position) {
      const id = doc.uri.fsPath
      if (!isSubdir(cwd, id))
        return null

      const code = doc.getText()
      if (!code)
        return null

      let ctx = await contextLoader.resolveContext(code, id)
      if (!ctx)
        ctx = await contextLoader.resolveClosestContext(code, id)

      if (!ctx.filter(code, id) && !isCssId(id))
        return null

      try {
        const autoComplete = getAutocomplete(ctx)

        const result = await autoComplete.suggestInFile(code, doc.offsetAt(position))

        log.appendLine(`🤖 ${id} | ${result.suggestions.slice(0, 10).map(v => `[${v[0]}, ${v[1]}]`).join(', ')}`)

        if (!result.suggestions.length)
          return

        const completionItems: UnoCompletionItem[] = []
        for (const [value, label] of result.suggestions) {
          const css = await getCSS(ctx!.uno, value)
          const colorString = getColorString(css)
          const itemKind = colorString ? CompletionItemKind.Color : CompletionItemKind.EnumMember
          const item = new UnoCompletionItem(label, itemKind, value, ctx!.uno)
          const resolved = result.resolveReplacement(value)

          item.insertText = resolved.replacement
          item.range = new Range(doc.positionAt(resolved.start), doc.positionAt(resolved.end))

          if (colorString) {
            item.documentation = colorString
            item.sortText = /-\d$/.test(label) ? '1' : '2' // reorder color completions
          }
          completionItems.push(item)
        }

        return new CompletionList(completionItems, true)
      }
      catch (e: any) {
        log.appendLine('⚠️ Error on getting autocompletion items')
        log.appendLine(String(e.stack ?? e))
        return null
      }
    },

    async resolveCompletionItem(item) {
      if (item.kind === CompletionItemKind.Color)
        item.detail = await (await getPrettiedCSS(item.uno, item.value)).prettified
      else
        item.documentation = await getMarkdown(item.uno, item.value)
      return item
    },
  }

  let completeUnregister: Disposable

  const registerProvider = () => {
    completeUnregister?.dispose?.()

    const languagesIds: string[] = workspace.getConfiguration().get('unocss.languageIds') || []

    const validLanguages = validateLanguages(languagesIds)

    completeUnregister = languages.registerCompletionItemProvider(
      defaultLanguageIds.concat(validLanguages),
      provider,
      ...delimiters,
    )
    return completeUnregister
  }

  ext.subscriptions.push(workspace.onDidChangeConfiguration(async (event) => {
    if (event.affectsConfiguration('unocss.languageIds')) {
      ext.subscriptions.push(
        registerProvider(),
      )
    }
  }))

  ext.subscriptions.push(
    registerProvider(),
  )
}
