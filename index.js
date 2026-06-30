/**
 * Prompt Keeper - SillyTavern Plugin loader
 *
 * @author sisjzknxhnsnejxn-cmyk
 * @version 2.0.3
 * @license MIT
 */

(function loadPromptKeeperScripts() {
    // SillyTavern 的部分设置页/正则页刷新会重新执行扩展入口。
    // 子脚本里存在 const 顶层声明，重复注入会导致 “Identifier has already been declared”，
    // 因此入口层做 loading/loaded 状态保护，避免重复加载，也避免失败后永久跳过。
    const LOADER_STATE_KEY = '__promptKeeperLoaderState';
    const LEGACY_LOADED_KEY = '__promptKeeperLoaded';
    const PLUGIN_FOLDER = 'prompt-keeper';
    const SCRIPT_LOAD_TIMEOUT_MS = 15000;

    const previousState = window[LOADER_STATE_KEY];
    if (previousState && previousState.status === 'loaded') {
        console.debug('[PromptKeeper] Loader skipped: already loaded.');
        return;
    }

    if (previousState && previousState.status === 'loading') {
        console.debug('[PromptKeeper] Loader skipped: already loading.');
        return;
    }

    window[LOADER_STATE_KEY] = {
        status: 'loading',
        startedAt: Date.now(),
    };
    // 保留旧标记，兼容之前版本的重复加载保护。
    window[LEGACY_LOADED_KEY] = false;

    const scriptNames = [
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

    const baseUrl = getExtensionBaseUrl();
    const cacheBust = `v=2.0.3&t=${Date.now()}`;

    const loadScript = (name) => new Promise((resolve, reject) => {
        const script = document.createElement('script');
        const scriptUrl = new URL(name, baseUrl);
        scriptUrl.searchParams.set('pk', cacheBust);
        script.src = scriptUrl.toString();
        script.async = false;
        script.dataset.promptKeeperPart = name;

        const timeoutId = setTimeout(() => {
            reject(new Error('Timed out loading Prompt Keeper script: ' + name));
        }, SCRIPT_LOAD_TIMEOUT_MS);

        script.onload = () => {
            clearTimeout(timeoutId);
            resolve();
        };
        script.onerror = () => {
            clearTimeout(timeoutId);
            reject(new Error('Failed to load Prompt Keeper script: ' + name + ' from ' + script.src));
        };
        document.head.appendChild(script);
    });

    scriptNames.reduce((chain, name) => chain.then(() => loadScript(name)), Promise.resolve())
        .then(() => {
            window[LOADER_STATE_KEY] = {
                status: 'loaded',
                loadedAt: Date.now(),
                baseUrl,
            };
            window[LEGACY_LOADED_KEY] = true;
            console.debug('[PromptKeeper] All scripts loaded from:', baseUrl);
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
