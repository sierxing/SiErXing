import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

/* UI 构建：只产出 public/ui-dist/ 下的静态资源，服务端运行时仍零依赖。
   - Vue SFC 在这里编译；
   - 插件宿主与内置 UI 分开打包，后续按页面逐步迁移。 */
export default defineConfig({
  root,
  plugins: [vue()],
  /* public/ 是运行时的静态目录，不是 Vite 的静态拷贝源；否则会把整个 public 复刻进产物。 */
  publicDir: false,
  base: '/ui-dist/',
  build: {
    outDir: 'public/ui-dist',
    emptyOutDir: true,
    rollupOptions: {
      /* 入口是「导出 mount 函数的 ESM」，不是 HTML；必须保留导出，否则会被树摇成空文件。 */
      preserveEntrySignatures: 'exports-only',
      input: {
        uilab: path.resolve(root, 'ui/lab/main.js'),
        studystats: path.resolve(root, 'ui/pages/studystats/main.js'),
        quests: path.resolve(root, 'ui/pages/quests/main.js'),
        ragbench: path.resolve(root, 'ui/pages/ragbench/main.js'),
        library: path.resolve(root, 'ui/pages/library/main.js'),
        outlib: path.resolve(root, 'ui/pages/outlib/main.js'),
        aitasks: path.resolve(root, 'ui/pages/aitasks/main.js'),
        quiz: path.resolve(root, 'ui/pages/quiz/main.js'),
        interview: path.resolve(root, 'ui/pages/interview/main.js'),
        jdfile: path.resolve(root, 'ui/pages/jdfile/main.js'),
        tutbookmark: path.resolve(root, 'ui/panels/tutbookmark/main.js'),
        aiprompts: path.resolve(root, 'ui/panels/aiprompts/main.js'),
        restate: path.resolve(root, 'ui/pages/restate/main.js'),
        explain: path.resolve(root, 'ui/pages/explain/main.js'),
        hot100: path.resolve(root, 'ui/pages/hot100/main.js'),
        components: path.resolve(root, 'ui/pages/components/main.js'),
        notespanel: path.resolve(root, 'ui/panels/notes/main.js'),
        home: path.resolve(root, 'ui/pages/home/main.js'),
        pomopanel: path.resolve(root, 'ui/panels/pomodoro/main.js'),
        versions: path.resolve(root, 'ui/pages/versions/main.js'),
        diff: path.resolve(root, 'ui/pages/diff/main.js'),
        settingstheme: path.resolve(root, 'ui/pages/settings-theme/main.js'),
        settings: path.resolve(root, 'ui/pages/settings/main.js'),
        settingsai: path.resolve(root, 'ui/pages/settings-ai/main.js'),
        settingsdata: path.resolve(root, 'ui/pages/settings-data/main.js'),
        settingssync: path.resolve(root, 'ui/pages/settings-sync/main.js'),
        settingsrag: path.resolve(root, 'ui/pages/settings-rag/main.js'),
        settingsservice: path.resolve(root, 'ui/pages/settings-service/main.js'),
        settingsupdate: path.resolve(root, 'ui/pages/settings-update/main.js'),
        settingssystem: path.resolve(root, 'ui/pages/settings-system/main.js'),
        guide: path.resolve(root, 'ui/pages/guide/main.js'),
        tutorial: path.resolve(root, 'ui/pages/tutorial/main.js'),
        map: path.resolve(root, 'ui/pages/map/main.js'),
        goal: path.resolve(root, 'ui/pages/goal/main.js'),
        chat: path.resolve(root, 'ui/pages/chat/main.js'),
        /* 用户插件宿主桥：只有用户装了 Vue 页面插件时 app.js 才按需 import */
        uihost: path.resolve(root, 'ui/sdk/browser-host.js')
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: (info) => (info.name && info.name.endsWith('.css') ? '[name][extname]' : 'assets/[name][extname]')
      }
    }
  }
});