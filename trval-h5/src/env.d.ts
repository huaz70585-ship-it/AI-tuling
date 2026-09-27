/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * 接口根路径。默认 `/api`（走 Vite dev 代理到后端 3001）。
   * 需要直连后端（如局域网真机调试）时才配，写在 `trval-h5/.env.local`。
   *
   * 注意：这是**【编译期】注入**的，改完必须重启 dev server，HMR 不生效。
   */
  readonly VITE_API_BASE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
