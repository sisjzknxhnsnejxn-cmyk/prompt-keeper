/**
 * Prompt Keeper - SillyTavern Plugin loader
 *
 * @author sisjzknxhnsnejxn-cmyk
 * @version 2.1.1
 * @license MIT
 */

(function loadPromptKeeperScripts() {
    // SillyTavern 的部分设置页/正则页刷新会重新执行扩展入口。
    // 为支持更新扩展后不刷新页面即可使用新版代码，入口层通过 fetch + Function
    // 将拆分脚本放入同一个隔离作用域执行，避免重复注入 <script> 后触发
    // “Identifier has already been declared”。
    const LOADER_STATE_KEY = '__promptKeeperLoaderState';
    const LEGACY_LOADED_KEY = '__promptKeeperLoaded';
    const PLUGIN_FOLDER = 'prompt-keeper';
    const SCRIPT_LOAD_TIMEOUT_MS = 15000;
    const RELOAD_GUARD_KEY = '__promptKeeperReloadPromise';
    const REFRESH_GUARD_KEY = 'promptKeeperUpdateRefreshAttempted';

    const previousState = window[LOADER_STATE_KEY];
    let baseUrl = null;

    window.PromptKeeperReload = async function PromptKeeperReload() {
        console.info('[PromptKeeper] 正在热重载插件文件；无需刷新页面或重启 SillyTavern 后端。');
        if (!window[RELOAD_GUARD_KEY]) {
            window[RELOAD_GUARD_KEY] = loadPromptKeeperRuntime({ force: true })
                .finally(() => {
                    window[RELOAD_GUARD_KEY] = null;
                });
        }
        return window[RELOAD_GUARD_KEY];
    };

    const scriptNames = [
        'pk-performance.js',
        'pk-constants.js',
        'pk-settings.js',
        'pk-state.js',
        'pk-prompt-state.js',
        'pk-preset.js',
        'pk-metadata.js',
        'pk-ui.js',
        'pk-settings-panel.js',
        'pk-main.js',
    ];

    const styleNames = [
        '../style.css',
    ];

    const getCurrentScriptUrl = () => {
        if (document.currentScript && document.currentScript.src) {
            return document.currentScript.src;
        }

        const scripts = Array.from(document.scripts || []);
        const ownScript = scripts.find((script) => {
            const src = script && script.src ? script.src : '';
            return src.includes(`/${PLUGIN_FOLDER}/index.js`) || src.endsWith('/index.js') && src.includes(PLUGIN_FOLDER);
        });

        return ownScript && ownScript.src ? ownScript.src : '';
    };

    const getExtensionBaseUrl = () => {
        const currentScriptUrl = getCurrentScriptUrl();
        if (currentScriptUrl) {
            return new URL('src/', currentScriptUrl).toString();
        }

        const extensionSettingsScript = Array.from(document.scripts || []).find((script) => {
            const src = script && script.src ? script.src : '';
            return src.includes('/scripts/extensions/') || src.includes('/scripts/extensions.js');
        });

        if (extensionSettingsScript && extensionSettingsScript.src) {
            const appRoot = new URL('../', extensionSettingsScript.src).toString();
            return new URL(`scripts/extensions/third-party/${PLUGIN_FOLDER}/src/`, appRoot).toString();
        }

        return new URL(`/scripts/extensions/third-party/${PLUGIN_FOLDER}/src/`, window.location.origin).toString();
    };

    const fetchScript = async (name, cacheBust) => {
        const scriptUrl = new URL(name, baseUrl);
        scriptUrl.searchParams.set('pk', cacheBust);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), SCRIPT_LOAD_TIMEOUT_MS);

        try {
            const response = await fetch(scriptUrl.toString(), {
                cache: 'no-store',
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status} ${response.statusText}`);
            }
            return `\n//# sourceURL=${scriptUrl.toString()}\n${await response.text()}\n`;
        } catch (error) {
            if (error && error.name === 'AbortError') {
                throw new Error('Timed out loading Prompt Keeper script: ' + name);
            }
            throw new Error('Failed to load Prompt Keeper script: ' + name + ' from ' + scriptUrl.toString() + ' (' + (error && error.message ? error.message : error) + ')');
        } finally {
            clearTimeout(timeoutId);
        }
    };

    const removeLegacyScriptTags = () => {
        document.querySelectorAll('script[data-prompt-keeper-part]').forEach((script) => script.remove());
    };

    const ensureRuntimeStyles = (cacheBust) => {
        for (const name of styleNames) {
            const styleId = `prompt-keeper-style-${name.replace(/[^a-z0-9_-]/gi, '-')}`;
            const styleUrl = new URL(name, baseUrl);
            styleUrl.searchParams.set('pk', cacheBust);
            let link = document.getElementById(styleId);
            if (!link) {
                link = document.createElement('link');
                link.id = styleId;
                link.rel = 'stylesheet';
                link.dataset.promptKeeperStyle = name;
                document.head.appendChild(link);
            }
            link.href = styleUrl.toString();
        }
    };

    const destroyCurrentRuntime = () => {
        const runtime = window.PromptKeeper;
        if (runtime && typeof runtime.destroy === 'function') {
            try {
                runtime.destroy('reload');
            } catch (error) {
                console.warn('[PromptKeeper] Runtime destroy failed during reload:', error);
            }
        }
        removeLegacyScriptTags();
    };

    const refreshPageOnceAfterFailedUpdate = (error) => {
        try {
            if (sessionStorage.getItem(REFRESH_GUARD_KEY) === '1') {
                console.error('[PromptKeeper] 热重载和自动刷新后的加载均失败，已停止刷新以避免循环。', error);
                return;
            }
            sessionStorage.setItem(REFRESH_GUARD_KEY, '1');
        } catch (_) {
            // sessionStorage 不可用时不自动刷新，避免无法设置防循环标记。
            console.error('[PromptKeeper] 热重载失败，且无法设置自动刷新防循环标记。', error);
            return;
        }

        console.warn('[PromptKeeper] 热重载失败，将自动刷新页面一次作为兜底。', error);
        setTimeout(() => window.location.reload(), 250);
    };

    async function loadPromptKeeperRuntime(options = {}) {
        const force = options.force === true;
        const state = window[LOADER_STATE_KEY];

        if (!force && state && state.status === 'loaded') {
            console.debug('[PromptKeeper] Runtime load skipped: already loaded. Run window.PromptKeeperReload() to hot-reload updated files.');
            return window.PromptKeeper;
        }
        if (!force && state && state.status === 'loading') {
            console.debug('[PromptKeeper] Runtime load skipped: another load is in progress.');
            return window.PromptKeeper;
        }

        baseUrl = getExtensionBaseUrl();
        const cacheBust = `v=2.1.1&t=${Date.now()}`;

        window[LOADER_STATE_KEY] = {
            status: 'loading',
            startedAt: Date.now(),
            baseUrl,
            hotReload: force,
        };
        window[LEGACY_LOADED_KEY] = false;

        const parts = [];
        for (const name of scriptNames) {
            parts.push(await fetchScript(name, cacheBust));
        }

        const runtimeId = `pk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const footer = `
;window.PromptKeeper = Object.assign(window.PromptKeeper || {}, {
    id: ${JSON.stringify(runtimeId)},
    version: '2.1.1',
    loadedAt: Date.now(),
    baseUrl: ${JSON.stringify(baseUrl)},
    reload: window.PromptKeeperReload,
    destroy: typeof destroyPromptKeeper === 'function' ? destroyPromptKeeper : function () {},
    init: typeof _pkInit === 'function' ? _pkInit : null,
    activateAfterLateLoad: typeof activatePromptKeeperAfterLateLoad === 'function' ? activatePromptKeeperAfterLateLoad : null,
    updateStatusDisplay: typeof updateStatusDisplay === 'function' ? updateStatusDisplay : null,
    hasSavedState: typeof hasSavedState === 'function' ? hasSavedState : null,
});
[
    'loadSettingsPanel', 'tryInjectUI', 'startUIObserver', 'updateStatusDisplay',
    'hasSavedState', 'getSavedAt', 'onChatChanged', 'onChatLoaded',
    'onPresetChanged', 'onMainApiChanged', 'saveStatesToMetadata',
    'restoreStatesFromMetadata', 'deleteStateFromMetadata', 'showSlotPicker'
].forEach(function (name) {
    try {
        if (typeof eval(name) === 'function') window[name] = eval(name);
    } catch (_) {}
});
`;

        // 先编译所有新版脚本；语法错误时保留仍可工作的旧运行时。
        const runtimeFactory = Function(`"use strict";\n${parts.join('\n')}\n${footer}`);

        if (force) {
            destroyCurrentRuntime();
        }

        runtimeFactory();
        ensureRuntimeStyles(cacheBust);

        // 更新扩展时 SillyTavern 的 APP_READY 已经触发过，必须主动补做初始化。
        if (force && window.PromptKeeper && typeof window.PromptKeeper.activateAfterLateLoad === 'function') {
            window.PromptKeeper.activateAfterLateLoad();
        }

        window[LOADER_STATE_KEY] = {
            status: 'loaded',
            loadedAt: Date.now(),
            baseUrl,
            hotReload: force,
        };
        window[LEGACY_LOADED_KEY] = true;
        try {
            sessionStorage.removeItem(REFRESH_GUARD_KEY);
        } catch (_) {}
        console.debug('[PromptKeeper] All scripts loaded from:', baseUrl);
        return window.PromptKeeper;
    }

    if (previousState && previousState.status === 'loaded') {
        console.info('[PromptKeeper] Loader re-executed; hot-reloading updated plugin files automatically.');
        window.PromptKeeperReload().catch((error) => {
            window[LOADER_STATE_KEY] = {
                status: 'failed',
                failedAt: Date.now(),
                baseUrl,
                error: error && error.message ? error.message : String(error),
            };
            window[LEGACY_LOADED_KEY] = false;
            console.error('[PromptKeeper]', error);
            refreshPageOnceAfterFailedUpdate(error);
        });
        return;
    }

    if (previousState && previousState.status === 'loading') {
        console.debug('[PromptKeeper] Loader skipped: already loading.');
        return;
    }

    loadPromptKeeperRuntime()
        .then(() => {
            // 状态已在 loadPromptKeeperRuntime 内更新。
        })
        .catch((error) => {
            window[LOADER_STATE_KEY] = {
                status: 'failed',
                failedAt: Date.now(),
                baseUrl,
                error: error && error.message ? error.message : String(error),
            };
            window[LEGACY_LOADED_KEY] = false;
            console.error('[PromptKeeper]', error);
        });
})();
