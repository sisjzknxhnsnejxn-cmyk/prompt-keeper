/**
 * Prompt Keeper (预设条目状态保持器) — SillyTavern Extension Universal Entry
 *
 * 同时兼容：
 * 1. SillyTavern 原生 `<script type="module" src=".../index.js">`
 * 2. 部分环境/旧版加载器的经典 `<script src=".../index.js">`
 * 3. 在酒馆扩展管理界面点击“更新扩展”后免刷新热重载（自动破除 ES Module 缓存并重新挂载面板）
 *
 * 核心实现按单一职责拆分在 `src/` 各 ES Module 子模块中，由 `src/entry.js` 汇总导出。
 */

(function loadPromptKeeperExtension() {
    const PLUGIN_FOLDER = 'prompt-keeper';
    const PLUGIN_VERSION = '2.2.7';
    const LOADER_STATE_KEY = '__promptKeeperLoaderState';

    function resolveExtensionRootUrl() {
        try {
            if (typeof document !== 'undefined') {
                if (document.currentScript && document.currentScript.src) {
                    return new URL('./', document.currentScript.src).toString();
                }

                const scripts = Array.from(document.scripts || []);
                const matchedScript = scripts.find((script) => {
                    const src = script && script.src ? script.src : '';
                    return (
                        src.includes(`/${PLUGIN_FOLDER}/index.js`) ||
                        src.includes('/SillyTavern-Preset-Prompt-Switcher/index.js') ||
                        (src.includes(PLUGIN_FOLDER) && src.includes('index.js'))
                    );
                });
                if (matchedScript && matchedScript.src) {
                    return new URL('./', matchedScript.src).toString();
                }

                const stScript = scripts.find((script) => {
                    const src = script && script.src ? script.src : '';
                    return src.includes('/scripts/extensions.js') || src.includes('/scripts/extensions/');
                });
                if (stScript && stScript.src) {
                    const appRoot = new URL('../', stScript.src).toString();
                    return new URL(`scripts/extensions/third-party/${PLUGIN_FOLDER}/`, appRoot).toString();
                }
            }
        } catch (_) {}

        if (typeof window !== 'undefined' && window.location && window.location.origin) {
            return `${window.location.origin}/scripts/extensions/third-party/${PLUGIN_FOLDER}/`;
        }
        return './';
    }

    function ensureStylesheetLoaded(rootUrl, cacheBust) {
        if (typeof document === 'undefined' || !document.head) return;
        try {
            const hrefUrl = new URL('style.css', rootUrl);
            hrefUrl.searchParams.set('v', cacheBust || PLUGIN_VERSION);
            const existingLink = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).find(
                (link) => link.href && link.href.includes(`/${PLUGIN_FOLDER}/style.css`)
            );
            if (existingLink) {
                existingLink.href = hrefUrl.toString();
                return;
            }
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.type = 'text/css';
            link.href = hrefUrl.toString();
            link.dataset.promptKeeperStyle = 'true';
            document.head.appendChild(link);
        } catch (_) {}
    }

    async function bootPromptKeeperModule(forceReload = false) {
        const rootUrl = resolveExtensionRootUrl();
        const cacheBust = forceReload ? `${PLUGIN_VERSION}_${Date.now()}` : PLUGIN_VERSION;
        ensureStylesheetLoaded(rootUrl, cacheBust);

        const entryUrl = new URL('src/entry.js', rootUrl);
        entryUrl.searchParams.set('v', cacheBust);

        const mod = await import(entryUrl.toString());
        if (mod && typeof mod.bootstrapPromptKeeper === 'function') {
            return mod.bootstrapPromptKeeper();
        }
        return null;
    }

    if (typeof window !== 'undefined') {
        const prevState = window[LOADER_STATE_KEY];
        window.PromptKeeperReload = () => bootPromptKeeperModule(true);

        const isHotReload = Boolean(prevState && prevState.loaded);
        window[LOADER_STATE_KEY] = { loading: true, updatedAt: Date.now() };

        bootPromptKeeperModule(isHotReload)
            .then(() => {
                window[LOADER_STATE_KEY] = { loaded: true, updatedAt: Date.now() };
            })
            .catch((error) => {
                window[LOADER_STATE_KEY] = { loaded: false, error: String(error), updatedAt: Date.now() };
                console.error('[PromptKeeper] Failed to load ES module entry:', error);
            });
    }
})();

