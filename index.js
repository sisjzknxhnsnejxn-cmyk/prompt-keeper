/**
 * Prompt Keeper - SillyTavern Plugin loader
 *
 * @author sisjzknxhnsnejxn-cmyk
 * @version 2.0.1
 * @license MIT
 */

(function loadPromptKeeperScripts() {
    // SillyTavern 的部分设置页/正则页刷新会重新执行扩展入口。
    // 子脚本里存在 const 顶层声明，重复注入会导致 “Identifier has already been declared”，
    // 因此入口层先做幂等保护，避免插件被重复加载/重复绑定事件。
    if (window.__promptKeeperLoaded) {
        console.debug('[PromptKeeper] Loader skipped: already loaded.');
        return;
    }
    window.__promptKeeperLoaded = true;

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

    const currentScript = document.currentScript;
    const baseUrl = currentScript && currentScript.src
        ? new URL('src/', currentScript.src).toString()
        : './src/';

    const loadScript = (name) => new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = baseUrl + name;
        script.async = false;
        script.onload = resolve;
        script.onerror = () => reject(new Error('Failed to load Prompt Keeper script: ' + name));
        document.head.appendChild(script);
    });

    scriptNames.reduce((chain, name) => chain.then(() => loadScript(name)), Promise.resolve())
        .catch((error) => {
            window.__promptKeeperLoaded = false;
            console.error('[PromptKeeper]', error);
        });
})();
