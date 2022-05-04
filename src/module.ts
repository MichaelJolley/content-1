import {
  addPlugin,
  defineNuxtModule,
  resolveModule,
  createResolver,
  addAutoImport,
  addComponentsDir,
  templateUtils,
  useLogger
} from '@nuxt/kit'
import defu from 'defu'
import { createStorage } from 'unstorage'
import { join } from 'pathe'
import type { Lang as ShikiLang, Theme as ShikiTheme } from 'shiki-es'
import { listen } from 'listhen'
import type { WatchEvent } from 'unstorage'
import { debounce } from 'perfect-debounce'
import { name, version } from '../package.json'
import {
  createWebSocket,
  getMountDriver,
  MOUNT_PREFIX,
  processMarkdownOptions,
  PROSE_TAGS,
  useContentMounts
} from './utils'

export type MountOptions = {
  name: string
  prefix?: string
  driver: 'fs' | 'http' | string
  [options: string]: any
}

export interface ModuleOptions {
  /**
   * Base route that will be used for content api
   *
   * @default '_content'
   */
  base: string
  /**
   * Disable content watcher and hot content reload.
   * Note: Watcher is a development feature and will not includes in the production.
   *
   * @default true
   */
  watch: boolean
  /**
   * Contents can located in multiple places, in multiple directories or even in remote git repositories.
   * Using sources option you can tell Content module where to look for contents.
   *
   * @default ['content']
   */
  sources: Array<string | MountOptions>
  /**
   * List of ignore pattern that will be used for excluding content from parsing and rendering.
   *
   * @default ['\\.', '-']
   */
  ignores: Array<string>
  /**
   * Content module uses `remark` and `rehype` under the hood to compile markdown files.
   * You can modify this options to control its behavior.
   */
  markdown: {
    /**
     * Whether MDC syntax should be supported or not.
     *
     * @default true
     */
    mdc?: boolean
    /**
     * Control behavior of Table of Contents generation
     */
    toc?: {
      /**
       * Maximum heading depth that includes in the table of contents.
       *
       * @default 2
       */
      depth?: number
      /**
       * Maximum depth of nested tags to search for heading.
       *
       * @default 2
       */
      searchDepth?: number
    },
    /**
     * Tags will be used to replace markdown components and render custom components instead of default ones.
     *
     * @default {}
     */
    tags?: Record<string, string>
    /**
     * Register custom remark plugin to provide new feature into your markdown contents.
     * Checkout: https://github.com/remarkjs/remark/blob/main/doc/plugins.md
     *
     * @default []
     */
    remarkPlugins?: Array<string | [string, any]>
    /**
     * Register custom remark plugin to provide new feature into your markdown contents.
     * Checkout: https://github.com/rehypejs/rehype/blob/main/doc/plugins.md
     *
     * @default []
     */
    rehypePlugins?: Array<string | [string, any]>
  }
  /**
   * Content module uses `shiki` to highlight code blocks.
   * You can configure Shiki options to control its behavior.
   */
  highlight: false | {
    /**
     * Default theme that will be used for highlighting code blocks.
     */
    theme: ShikiTheme,
    /**
     * Preloaded languages that will be available for highlighting code blocks.
     */
    preload: ShikiLang[]
  },
  /**
   * Options for yaml parser.
   *
   * @default {}
   */
  yaml: false | Record<string, any>
  /**
   * Options for yaml parser.
   *
   * @default {}
   */
  csv: false | Record<string, any>
  /**
   * Enable/Disable navigation.
   *
   * @defaul {}
   */
  navigation: false | {
    fields: Array<string>
  }
  /**
   * List of locale codes.
   * This codes will be used to detect contents locale.
   *
   * @default []
   */
  locales: Array<string>
  /**
   * Default locale for top level contents.
   *
   * @default undefined
   */
  defaultLocale: string
}

interface ContentContext extends ModuleOptions {
  base: Readonly<string>
  transformers: Array<string>
}

export interface ModuleHooks {
  'content:context'(ctx: ContentContext): void
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name,
    version,
    configKey: 'content',
    compatibility: {
      nuxt: '^3.0.0',
      bridge: true
    }
  },
  defaults: {
    base: '_content',
    watch: true,
    sources: ['content'],
    ignores: ['\\.', '-'],
    locales: [],
    defaultLocale: undefined,
    highlight: false,
    markdown: {
      tags: Object.fromEntries(PROSE_TAGS.map(t => [t, `prose-${t}`]))
    },
    yaml: {},
    csv: {},
    navigation: {
      fields: []
    }
  },
  async setup (options, nuxt) {
    const { resolve } = createResolver(import.meta.url)
    const resolveRuntimeModule = (path: string) => resolveModule(path, { paths: resolve('./runtime') })

    const logger = useLogger('@nuxt/content')

    const contentContext: ContentContext = {
      transformers: [
        // Register internal content plugins
        resolveRuntimeModule('./server/transformers/markdown'),
        resolveRuntimeModule('./server/transformers/yaml'),
        resolveRuntimeModule('./server/transformers/json'),
        resolveRuntimeModule('./server/transformers/csv'),
        resolveRuntimeModule('./server/transformers/path-meta')
      ],
      ...options
    }

    // Add Vite configurations
    if (nuxt.options.vite !== false) {
      nuxt.options.vite = defu(
        nuxt.options.vite === true ? {} : nuxt.options.vite,
        {
          optimizeDeps: {
            include: ['html-tags']
          }
        }
      )
    }
    // Tell Nuxt to ignore content dir for app build
    options.sources.forEach((source) => {
      if (typeof source === 'string') {
        nuxt.options.ignore.push(join('content', '**'))
      }
      // TODO: handle object format and make sure to ignore urls
    })

    // Add Content plugin
    addPlugin(resolveRuntimeModule('./plugin'))

    nuxt.hook('nitro:config', (nitroConfig) => {
      // Add server handlers
      nitroConfig.handlers = nitroConfig.handlers || []
      nitroConfig.handlers.push({
        method: 'get',
        route: `/api/${options.base}/query/:query`,
        handler: resolveRuntimeModule('./server/api/query')
      })
      nitroConfig.handlers.push({
        method: 'get',
        route: `/api/${options.base}/cache`,
        handler: resolveRuntimeModule('./server/api/cache')
      })

      if (!nuxt.options.dev) {
        nitroConfig.prerender.routes.push('/api/_content/cache')
      }
      // Register source storages
      const sources = useContentMounts(nuxt, contentContext.sources || [])
      nitroConfig.devStorage = Object.assign(
        nitroConfig.devStorage || {},
        sources
      )
      nitroConfig.bundledStorage = nitroConfig.bundledStorage || []
      nitroConfig.bundledStorage.push('/cache/content')

      nitroConfig.externals = defu(typeof nitroConfig.externals === 'object' ? nitroConfig.externals : {}, {
        inline: [
          // Inline module runtime in Nitro bundle
          resolve('./runtime')
        ]
      })

      nitroConfig.autoImport = nitroConfig.autoImport || {}
      nitroConfig.autoImport.imports = nitroConfig.autoImport.imports || []
      nitroConfig.autoImport.imports.push(...[
        { name: 'parse', as: 'contentParse', from: resolveRuntimeModule('./server/transformers') },
        { name: 'transform', as: 'contentTransform', from: resolveRuntimeModule('./server/transformers') }
      ])

      nitroConfig.virtual = nitroConfig.virtual || {}
      nitroConfig.virtual['#content/virtual/transformers'] = [
        // TODO: remove kit usage
        templateUtils.importSources(contentContext.transformers),
        `const transformers = [${contentContext.transformers.map(templateUtils.importName).join(', ')}]`,
        'export const getParser = (ext) => transformers.find(p => ext.match(new RegExp(p.extentions.join("|"),  "i")) && p.parse)',
        'export const getTransformers = (ext) => transformers.filter(p => ext.match(new RegExp(p.extentions.join("|"),  "i")) && p.transform)',
        'export default () => {}'
      ].join('\n')
    })

    // Register composables
    addAutoImport([
      { name: 'queryContent', as: 'queryContent', from: resolveRuntimeModule('./composables/query') },
      { name: 'withContentBase', as: 'withContentBase', from: resolveRuntimeModule('./composables/utils') },
      { name: 'useUnwrap', as: 'useUnwrap', from: resolveRuntimeModule('./composables/utils') }
    ])

    // Register components
    addComponentsDir({
      path: resolve('./runtime/components'),
      pathPrefix: false,
      prefix: '',
      level: 999,
      global: true
    })

    // Register navigation
    if (options.navigation) {
      addAutoImport({ name: 'fetchContentNavigation', as: 'fetchContentNavigation', from: resolveRuntimeModule('./composables/navigation') })

      nuxt.hook('nitro:config', (nitroConfig) => {
        nitroConfig.handlers.push({
          method: 'get',
          route: `/api/${options.base}/navigation/:query`,
          handler: resolveRuntimeModule('./server/api/navigation')
        })
      })
    }

    // Register highlighter
    if (options.highlight) {
      contentContext.transformers.push(resolveRuntimeModule('./server/transformers/shiki'))

      nuxt.hook('nitro:config', (nitroConfig) => {
        nitroConfig.handlers.push({
          method: 'post',
          route: `/api/${options.base}/highlight`,
          handler: resolveRuntimeModule('./server/api/highlight')
        })
      })
    }

    // @ts-ignore
    await nuxt.callHook('content:context', contentContext)

    contentContext.defaultLocale = contentContext.defaultLocale || contentContext.locales[0]

    // Process markdown plugins, resovle paths
    contentContext.markdown = processMarkdownOptions(nuxt, contentContext.markdown)

    nuxt.options.runtimeConfig.public.content = {
      base: options.base,
      // Tags will use in markdown renderer for component replacement
      tags: contentContext.markdown.tags as any,
      highlight: options.highlight,
      wsUrl: ''
    }
    // Context will use in server
    nuxt.options.runtimeConfig.content = contentContext as any

    // Setup content dev module
    if (!nuxt.options.dev || !options.watch) {
      return
    }

    // Create storage instance
    const storage = createStorage()
    const mounts = useContentMounts(nuxt, contentContext.sources || [])
    for (const mount in mounts) {
      storage.mount(mount, getMountDriver(mounts[mount]))
    }

    const ws = createWebSocket()

    // Dispose storage on nuxt close
    nuxt.hook('close', async () => {
      await Promise.all([
        storage.dispose(),
        ws.close()
      ])
    })

    // Listen dev server
    const { server, url } = await listen(() => 'Nuxt Content', { port: 4000, showURL: false })
    server.on('upgrade', ws.serve)

    // Register ws url
    nuxt.options.runtimeConfig.public.content.wsUrl = url.replace('http', 'ws')

    // Broadcast a message to the server to refresh the page
    const broadcast = debounce((event: WatchEvent, key: string) => {
      key = key.substring(MOUNT_PREFIX.length)
      logger.info(`${key} ${event}d`)
      ws.broadcast({ event, key })
    }, 50)

    // Watch contents
    storage.watch(broadcast)
  }
})

interface ModulePublicRuntimeConfig {
  tags: Record<string, string>
  base: string;
  // Websocket server URL
  wsUrl?: string;
  // Shiki config
  highlight: ModuleOptions['highlight']
}

interface ModulePrivateRuntimeConfig {}

declare module '@nuxt/schema' {
  interface ConfigSchema {
    publicRuntimeConfig?: {
      content?: ModulePublicRuntimeConfig;
    };
    privateRuntimeConfig?: {
      content?: ModulePrivateRuntimeConfig & ContentContext;
    };
  }
}
