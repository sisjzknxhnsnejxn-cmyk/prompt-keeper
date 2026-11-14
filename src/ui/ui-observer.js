/**
 * Prompt Keeper - 工具栏 DOM 注入、事件委托与 MutationObserver 保活
 */

import {
    ALL_BUTTON_EVENT_TYPES,
    BUTTON_DEBOUNCE_MS,
    LOG_PREFIX,
    OBSERVER_REINJECTION_LIMIT,
    OBSERVER_REINJECTION_WINDOW,
    PC_UI_WATCHDOG_INTERVAL_MS,
    PROMPT_KEEPER_BUTTON_SELECTOR,
    UI_ENSURE_DELAYS_MS,
    UI_REINJECT_SETTLE_MS,
} from '../config/constants.js';
import { clearUIEnsureTimers, runtimeState } from '../config/runtime-state.js';
import { isPluginEnabled } from '../core/settings.js';
import { saveStatesToMetadata } from '../services/slot-service.js';
import {
    animatePressedButton,
    clearTouchTracking,
    isTouchScrollGesture,
    markTouchHandledForSyntheticClick,
    pkGetButtonEventTypes,
    recordTouchStart,
    resolveEventElement,
    shouldSuppressSyntheticClick,
    updateTouchMove,
} from '../utils/dom-events.js';
import { handleDeleteClick, handleRestoreClick } from './slot-picker-modal.js';
import { injectSettingsPanel } from './settings-panel.js';
import { updateStatusDisplay } from './status-bar.js';
import { buildPromptKeeperBarHTML } from './templates.js';

export function findPreferredPresetRow() {
    if (typeof jQuery === 'undefined') return null;

    const $exactRow = jQuery('#openai_api-presets > div:nth-child(1) > div.flex-container.flexNoGap').first();
    if ($exactRow.length > 0) return $exactRow;

    const $bySelect = jQuery('#settings_preset_openai').closest('div.flex-container.flexNoGap').first();
    if ($bySelect.length > 0) return $bySelect;

    return null;
}

export function ensureBarInPreferredPosition($bar) {
    if (!$bar || !$bar.length || typeof jQuery === 'undefined') return false;

    const $presetRow = findPreferredPresetRow();
    if ($presetRow && $presetRow.length > 0) {
        const rowEl = $presetRow[0];
        const barEl = $bar[0];
        if (rowEl && barEl && rowEl.nextElementSibling !== barEl) {
            $presetRow.after($bar);
            return true;
        }
        return false;
    }

    const $regexPanel = jQuery('#st-native-regex-panel').first();
    if ($regexPanel.length > 0) {
        const regexEl = $regexPanel[0];
        const barEl = $bar[0];
        if (regexEl && barEl && barEl.nextElementSibling !== regexEl) {
            $regexPanel.before($bar);
            return true;
        }
    }

    return false;
}

export function findPromptManagerContainer() {
    if (typeof jQuery === 'undefined') return null;

    const $presetRow = findPreferredPresetRow();
    if ($presetRow && $presetRow.length > 0) return $presetRow;

    const $regexPanel = jQuery('#st-native-regex-panel').first();
    if ($regexPanel.length > 0) return $regexPanel;

    const primarySelectors = [
        '#quick-edit-container',
        '#completion_prompt_manager_list',
        '#completion_prompt_manager',
    ];
    for (const sel of primarySelectors) {
        const $el = jQuery(sel).first();
        if ($el.length > 0) return $el;
    }

    const fallbackSelectors = [
        '#openai_api-presets',
        '#top_p_block',
        '#range_block_openai',
        '#left-nav-panel .scrollableInner',
    ];
    for (const sel of fallbackSelectors) {
        const $el = jQuery(sel).first();
        if ($el.length > 0) return $el;
    }

    return null;
}

export function shouldRunButtonAction(buttonId) {
    if (!buttonId) return false;
    if (
        runtimeState.saveInProgress ||
        runtimeState.restoreInProgress ||
        runtimeState.deleteInProgress
    ) {
        return false;
    }
    const now = Date.now();
    const lastAt = Number(runtimeState.lastButtonActionById[buttonId] || 0);
    if (now - lastAt < BUTTON_DEBOUNCE_MS) return false;
    runtimeState.lastButtonActionById[buttonId] = now;
    return true;
}

export async function runPromptKeeperButtonAction(buttonElement, event) {
    if (!buttonElement || buttonElement.disabled) return;
    const buttonId = buttonElement.id;
    if (!buttonId) return;

    if (isTouchScrollGesture(runtimeState, event)) {
        return;
    }

    const eventType = event && event.type ? event.type : '';
    if (shouldSuppressSyntheticClick(buttonElement, eventType)) return;
    markTouchHandledForSyntheticClick(buttonElement, eventType);

    if (!shouldRunButtonAction(buttonId)) return;

    if (event) {
        if (typeof event.preventDefault === 'function') event.preventDefault();
        if (typeof event.stopPropagation === 'function') event.stopPropagation();
    }

    const $btn = jQuery(buttonElement);
    animatePressedButton($btn);

    if (buttonId === 'prompt-keeper-save') {
        await saveStatesToMetadata();
        return;
    }
    if (buttonId === 'prompt-keeper-restore') {
        await handleRestoreClick();
        return;
    }
    if (buttonId === 'prompt-keeper-delete') {
        await handleDeleteClick();
    }
}

function handleDocumentTouchStart(event) {
    recordTouchStart(runtimeState, event);
}

function handleDocumentTouchMove(event) {
    updateTouchMove(runtimeState, event);
}

function handleDocumentTouchCancel() {
    clearTouchTracking(runtimeState);
}

function handleDocumentPromptKeeperButtonEvent(event) {
    if (isTouchScrollGesture(runtimeState, event)) return;

    const target = resolveEventElement(event);
    if (!target || typeof target.closest !== 'function') return;

    const button = target.closest(PROMPT_KEEPER_BUTTON_SELECTOR);
    if (!button) return;

    void runPromptKeeperButtonAction(button, event);
}

/**
 * 绑定统一的 document 级按钮委托监听（避免捕获阶段与直绑监听器双重绑定冲突）
 */
export function bindPromptKeeperButtonDelegation() {
    if (typeof document === 'undefined' || !document.addEventListener) return;

    if (!runtimeState.documentTouchTrackingBound) {
        document.addEventListener('pointerdown', handleDocumentTouchStart, true);
        document.addEventListener('touchstart', handleDocumentTouchStart, true);
        document.addEventListener('pointermove', handleDocumentTouchMove, true);
        document.addEventListener('touchmove', handleDocumentTouchMove, true);
        document.addEventListener('pointercancel', handleDocumentTouchCancel, true);
        document.addEventListener('touchcancel', handleDocumentTouchCancel, true);
        runtimeState.documentTouchTrackingBound = true;
    }

    const eventTypes = pkGetButtonEventTypes();
    const eventSignature = eventTypes.join(',');
    if (
        runtimeState.promptKeeperButtonDelegationBound &&
        runtimeState.promptKeeperButtonDelegatedEvents === eventSignature
    ) {
        return;
    }

    for (const type of ALL_BUTTON_EVENT_TYPES) {
        document.removeEventListener(type, handleDocumentPromptKeeperButtonEvent, true);
        document.removeEventListener(type, handleDocumentPromptKeeperButtonEvent, false);
    }

    for (const type of eventTypes) {
        document.addEventListener(type, handleDocumentPromptKeeperButtonEvent, true);
        document.addEventListener(type, handleDocumentPromptKeeperButtonEvent, false);
    }
    runtimeState.promptKeeperButtonDelegationBound = true;
    runtimeState.promptKeeperButtonDelegatedEvents = eventSignature;
}

export function unbindPromptKeeperButtonDelegation() {
    if (typeof document === 'undefined' || !document.removeEventListener) return;
    for (const type of ALL_BUTTON_EVENT_TYPES) {
        document.removeEventListener(type, handleDocumentPromptKeeperButtonEvent, true);
        document.removeEventListener(type, handleDocumentPromptKeeperButtonEvent, false);
    }
    if (runtimeState.documentTouchTrackingBound) {
        document.removeEventListener('pointerdown', handleDocumentTouchStart, true);
        document.removeEventListener('touchstart', handleDocumentTouchStart, true);
        document.removeEventListener('pointermove', handleDocumentTouchMove, true);
        document.removeEventListener('touchmove', handleDocumentTouchMove, true);
        document.removeEventListener('pointercancel', handleDocumentTouchCancel, true);
        document.removeEventListener('touchcancel', handleDocumentTouchCancel, true);
        runtimeState.documentTouchTrackingBound = false;
    }
    runtimeState.promptKeeperButtonDelegationBound = false;
    runtimeState.promptKeeperButtonDelegatedEvents = '';
}

function bindDirectToolbarButtonEvents($bar) {
    if (!$bar || !$bar.length) return;
    const eventNames = pkGetButtonEventTypes()
        .map((type) => type + '.pkDirectBtn')
        .join(' ');

    $bar.find(PROMPT_KEEPER_BUTTON_SELECTOR)
        .off('.pkDirectBtn')
        .on(eventNames, function (event) {
            void runPromptKeeperButtonAction(this, event);
        });
}

export function injectUI() {
    if (!isPluginEnabled() || typeof jQuery === 'undefined') return false;
    if (runtimeState.uiInjectInProgress) return false;

    const $existingBar = jQuery('#prompt-keeper-bar');
    if ($existingBar.length > 0 && document.body && document.body.contains($existingBar[0])) {
        ensureBarInPreferredPosition($existingBar);
        bindPromptKeeperButtonDelegation();
        bindDirectToolbarButtonEvents($existingBar);
        updateStatusDisplay();
        return true;
    }

    const elapsed = Date.now() - runtimeState.lastUIInjectAt;
    if (elapsed < UI_REINJECT_SETTLE_MS) {
        const waitMs = Math.max(40, UI_REINJECT_SETTLE_MS - elapsed + 25);
        const timer = setTimeout(() => {
            runtimeState.uiEnsureTimers = runtimeState.uiEnsureTimers.filter((item) => item !== timer);
            if (typeof jQuery !== 'undefined' && jQuery('#prompt-keeper-bar').length === 0) {
                injectUI();
            }
        }, waitMs);
        runtimeState.uiEnsureTimers.push(timer);
        return false;
    }

    const $container = findPromptManagerContainer();
    if (!$container || $container.length === 0) return false;

    runtimeState.uiInjectInProgress = true;
    try {
        jQuery('#prompt-keeper-bar').remove();

        const $bar = jQuery(buildPromptKeeperBarHTML());
        const $presetRow = findPreferredPresetRow();

        if ($presetRow && $presetRow.length > 0) {
            // 优先挂载在预设下拉选择器行正下方、#st-native-regex-panel（预设正则）正上方
            $presetRow.after($bar);
        } else if ($container.is('#st-native-regex-panel')) {
            $container.before($bar);
        } else if (
            $container.is(
                '#quick-edit-container, #completion_prompt_manager_list'
            )
        ) {
            $container.before($bar);
        } else if ($container.is('#top_p_block, #range_block_openai')) {
            const $block = $container.closest('.range-block, .range_block');
            if ($block.length > 0) {
                $block.after($bar);
            } else {
                $container.after($bar);
            }
        } else {
            $container.prepend($bar);
        }

        runtimeState.lastUIInjectAt = Date.now();
        runtimeState.lastStatusDisplaySignature = '';
        bindPromptKeeperButtonDelegation();
        bindDirectToolbarButtonEvents($bar);
        updateStatusDisplay();

        console.log(LOG_PREFIX, 'UI bar injected into Prompt Manager.');
        return true;
    } finally {
        runtimeState.uiInjectInProgress = false;
    }
}

export function tryInjectUI(attempt = 0) {
    if (runtimeState.uiRetryTimer) {
        clearTimeout(runtimeState.uiRetryTimer);
        runtimeState.uiRetryTimer = null;
    }

    if (injectUI()) return;

    if (attempt < 20) {
        const delay = attempt < 5 ? 500 : 1000;
        runtimeState.uiRetryTimer = setTimeout(() => {
            runtimeState.uiRetryTimer = null;
            tryInjectUI(attempt + 1);
        }, delay);
    } else {
        console.warn(LOG_PREFIX, 'Prompt Manager container not found after 20 attempts; relying on MutationObserver.');
    }
}

export function scheduleEnsurePromptKeeperUI(reason = 'event') {
    try {
        injectSettingsPanel();
    } catch (_) {}

    if (!isPluginEnabled()) return;

    clearUIEnsureTimers();

    for (const delay of UI_ENSURE_DELAYS_MS) {
        const timer = setTimeout(() => {
            runtimeState.uiEnsureTimers = runtimeState.uiEnsureTimers.filter((item) => item !== timer);
            try {
                injectSettingsPanel();
            } catch (_) {}
            if (!isPluginEnabled()) return;
            const injected = injectUI();
            if (injected) {
                updateStatusDisplay();
            }
        }, delay);
        runtimeState.uiEnsureTimers.push(timer);
    }

    console.debug(LOG_PREFIX, `Scheduled UI ensure checks (${reason}).`);
}


export function ensurePCUIWatchdog() {
    if (runtimeState.pcUIWatchdogTimer) return;

    runtimeState.pcUIWatchdogTimer = setInterval(() => {
        if (runtimeState.observerPaused) return;
        if (typeof document !== 'undefined' && document.hidden) return;

        try {
            injectSettingsPanel();
        } catch (_) {}

        if (!isPluginEnabled()) return;

        const $container = findPromptManagerContainer();
        if (!$container || $container.length === 0) return;

        if (typeof jQuery !== 'undefined') {
            const $bar = jQuery('#prompt-keeper-bar');
            if ($bar.length === 0) {
                injectUI();
            } else {
                ensureBarInPreferredPosition($bar);
            }
        }
    }, PC_UI_WATCHDOG_INTERVAL_MS);
}

export function startUIObserver() {
    if (runtimeState.uiObserver || typeof MutationObserver === 'undefined') return;

    const targetNode =
        document.getElementById('left-nav-panel') ||
        document.getElementById('completion_prompt_manager') ||
        document.getElementById('rm_api_block') ||
        document.body;

    if (!runtimeState.dragListenersBound && typeof jQuery !== 'undefined') {
        runtimeState.dragListenersBound = true;
        jQuery(document)
            .on('sortstart.promptkeeper dragstart.promptkeeper', () => {
                runtimeState.observerPaused = true;
            })
            .on('sortstop.promptkeeper dragend.promptkeeper', () => {
                setTimeout(() => {
                    runtimeState.observerPaused = false;
                }, 100);
            });
    }

    runtimeState.uiObserver = new MutationObserver(() => {
        if (runtimeState.observerPaused) return;
        if (runtimeState.observerThrottleTimer || runtimeState.observerRafId) return;

        runtimeState.observerThrottleTimer = setTimeout(() => {
            runtimeState.observerThrottleTimer = null;
            if (!isPluginEnabled()) return;
            if (runtimeState.observerPaused) return;
            if (Date.now() - runtimeState.lastUIInjectAt < UI_REINJECT_SETTLE_MS) return;

            runtimeState.observerRafId = requestAnimationFrame(() => {
                runtimeState.observerRafId = null;
                if (typeof jQuery === 'undefined') return;
                const $existingBar = jQuery('#prompt-keeper-bar');
                if ($existingBar.length === 0) {
                    const $container = findPromptManagerContainer();
                    if ($container) {
                        runtimeState.observerReinjectionCount++;
                        if (!runtimeState.observerReinjectionResetTimer) {
                            runtimeState.observerReinjectionResetTimer = setTimeout(() => {
                                runtimeState.observerReinjectionCount = 0;
                                runtimeState.observerReinjectionResetTimer = null;
                            }, OBSERVER_REINJECTION_WINDOW);
                        }
                        if (runtimeState.observerReinjectionCount > OBSERVER_REINJECTION_LIMIT) {
                            console.warn(
                                LOG_PREFIX,
                                `Observer re-injected UI ${runtimeState.observerReinjectionCount} times within ${OBSERVER_REINJECTION_WINDOW / 1000}s — possible conflict with another extension. Backing off.`
                            );
                            return;
                        }
                        injectUI();
                    }
                } else {
                    ensureBarInPreferredPosition($existingBar);
                }
            });
        }, 350);
    });

    runtimeState.uiObserver.observe(targetNode, { childList: true, subtree: true });
}
