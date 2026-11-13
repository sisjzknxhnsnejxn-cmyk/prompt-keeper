/**
 * Prompt Keeper - 预设读取、切换与 PromptManager UI 同步服务
 */

import {
    LOG_PREFIX,
    PRESET_SWITCH_POLL_MS,
    PRESET_SWITCH_TIMEOUT_MS,
    PROMPT_STATE_READY_POLL_MS,
    PROMPT_STATE_READY_TIMEOUT_MS,
} from '../config/constants.js';
import { runtimeState } from '../config/runtime-state.js';
import { applyPromptStates } from '../core/prompt-applier.js';
import { findSavedPromptStateMismatches } from '../core/prompt-dirty-check.js';
import { readPromptStates } from '../core/prompt-reader.js';
import { isPresetNameMatch } from '../utils/format.js';
import {
    getChatCompletionPresetManager,
    getCtxSafe,
    getSillyTavernOpenAIModule,
} from '../utils/st-context.js';

export function getCurrentPresetName() {
    try {
        const pm = getChatCompletionPresetManager();
        if (pm && typeof pm.getSelectedPresetName === 'function') {
            const name = pm.getSelectedPresetName();
            if (name) return String(name);
        }
    } catch (_) {}

    if (typeof jQuery !== 'undefined') {
        const $sel = jQuery('#settings_preset_openai, #settings_preset').first();
        if ($sel.length > 0) {
            const text = $sel.find('option:selected').text().trim();
            if (text) return text;
        }
    }
    return null;
}

export async function waitForPresetApplied(
    presetName,
    chatIdAtStart = null,
    timeoutMs = PRESET_SWITCH_TIMEOUT_MS
) {
    const startedAt = Date.now();
    let consecutiveReadyReads = 0;

    while (Date.now() - startedAt < timeoutMs) {
        if (chatIdAtStart) {
            const ctx = getCtxSafe();
            if (!ctx || ctx.chatId !== chatIdAtStart) return false;
        }

        const currentPreset = getCurrentPresetName();
        const states = readPromptStates();
        const hasPrompts = Boolean(states && states.prompts && Object.keys(states.prompts).length > 0);

        if (isPresetNameMatch(currentPreset, presetName) && hasPrompts) {
            consecutiveReadyReads++;
            if (consecutiveReadyReads >= 2) {
                return true;
            }
        } else {
            consecutiveReadyReads = 0;
        }

        await new Promise((resolve) => setTimeout(resolve, PRESET_SWITCH_POLL_MS));
    }

    return isPresetNameMatch(getCurrentPresetName(), presetName);
}

export async function waitForPromptStatesReady(
    chatIdAtStart = null,
    timeoutMs = PROMPT_STATE_READY_TIMEOUT_MS
) {
    const startedAt = Date.now();
    let lastCount = -1;
    let stableReads = 0;

    while (Date.now() - startedAt < timeoutMs) {
        if (chatIdAtStart) {
            const ctx = getCtxSafe();
            if (!ctx || ctx.chatId !== chatIdAtStart) return false;
        }

        const states = readPromptStates();
        const count = states && states.prompts ? Object.keys(states.prompts).length : 0;

        if (count > 0) {
            if (count === lastCount) {
                stableReads++;
                if (stableReads >= 2) {
                    return true;
                }
            } else {
                lastCount = count;
                stableReads = 1;
            }
        } else {
            lastCount = -1;
            stableReads = 0;
        }

        await new Promise((resolve) => setTimeout(resolve, PROMPT_STATE_READY_POLL_MS));
    }

    const finalStates = readPromptStates();
    return Boolean(finalStates && finalStates.prompts && Object.keys(finalStates.prompts).length > 0);
}

export async function switchToPreset(presetName, chatIdAtStart = null) {
    if (!presetName) return true;

    const currentPreset = getCurrentPresetName();
    if (isPresetNameMatch(currentPreset, presetName)) {
        console.debug(LOG_PREFIX, `Preset "${presetName}" is already active, skipping switch.`);
        return true;
    }

    runtimeState.internalPresetSwitchInProgress = true;
    try {
        try {
            const pm = getChatCompletionPresetManager();
            if (pm) {
                if (typeof pm.selectPreset === 'function') {
                    let targetValue = presetName;
                    if (typeof pm.findPreset === 'function') {
                        const foundValue = pm.findPreset(presetName);
                        if (foundValue !== undefined && foundValue !== null && foundValue !== false) {
                            targetValue = foundValue;
                        }
                    }
                    await pm.selectPreset(targetValue);
                    const applied = await waitForPresetApplied(presetName, chatIdAtStart);
                    if (applied) {
                        console.debug(LOG_PREFIX, `Switched preset via PresetManager to "${presetName}"`);
                        return true;
                    }
                }

                const altMethods = [
                    typeof pm.selectPresetByName === 'function' ? pm.selectPresetByName : null,
                    typeof pm.changePreset === 'function' ? pm.changePreset : null,
                ].filter(Boolean);

                for (const method of altMethods) {
                    try {
                        await method.call(pm, presetName);
                        if (await waitForPresetApplied(presetName, chatIdAtStart)) {
                            console.debug(LOG_PREFIX, `Switched preset via PresetManager fallback to "${presetName}"`);
                            return true;
                        }
                    } catch (_) {}
                }
            }
        } catch (e) {
            console.warn(LOG_PREFIX, 'PresetManager.selectPreset failed:', e);
        }

        if (typeof jQuery !== 'undefined') {
            const $sel = jQuery('#settings_preset_openai, #settings_preset').first();
            if ($sel.length > 0) {
                let matchedVal = null;
                $sel.find('option').each(function () {
                    const $opt = jQuery(this);
                    if ($opt.text().trim() === presetName || $opt.val() === presetName) {
                        matchedVal = $opt.val();
                        return false;
                    }
                });

                if (matchedVal === null) {
                    $sel.find('option').each(function () {
                        if (isPresetNameMatch(jQuery(this).text(), presetName)) {
                            matchedVal = jQuery(this).val();
                            return false;
                        }
                    });
                }

                if (matchedVal !== null) {
                    $sel.val(matchedVal).trigger('change');
                    const applied = await waitForPresetApplied(presetName, chatIdAtStart);
                    console.debug(LOG_PREFIX, `Switched preset via DOM <select> to "${presetName}" (applied=${applied})`);
                    if (applied) return true;
                } else {
                    console.warn(LOG_PREFIX, `Preset "${presetName}" not found in <select> options.`);
                }
            }
        }

        try {
            const ctx = getCtxSafe();
            const escapedName = String(presetName).replace(/"/g, '\\"');
            if (ctx && typeof ctx.executeSlashCommandsWithOptions === 'function') {
                await ctx.executeSlashCommandsWithOptions(`/preset "${escapedName}"`);
                if (await waitForPresetApplied(presetName, chatIdAtStart)) return true;
            } else if (ctx && typeof ctx.executeSlashCommands === 'function') {
                await ctx.executeSlashCommands(`/preset "${escapedName}"`);
                if (await waitForPresetApplied(presetName, chatIdAtStart)) return true;
            }
        } catch (e) {
            console.warn(LOG_PREFIX, `Slash command preset switch failed for "${presetName}":`, e);
        }

        return false;
    } finally {
        runtimeState.internalPresetSwitchInProgress = false;
    }
}

export async function refreshPromptManagerUI() {
    try {
        const openaiModule = await getSillyTavernOpenAIModule();
        if (
            openaiModule &&
            openaiModule.promptManager &&
            typeof openaiModule.promptManager.render === 'function'
        ) {
            openaiModule.promptManager.render();
            console.debug(LOG_PREFIX, 'Refreshed UI via /scripts/openai.js promptManager.render()');
            return;
        }
    } catch (e) {
        console.warn(LOG_PREFIX, 'openaiModule.promptManager.render() failed:', e);
    }

    if (typeof window !== 'undefined' && window.promptManager && typeof window.promptManager.render === 'function') {
        try {
            window.promptManager.render();
            console.debug(LOG_PREFIX, 'Refreshed UI via window.promptManager.render()');
            return;
        } catch (e) {
            console.warn(LOG_PREFIX, 'promptManager.render() failed:', e);
        }
    }

    try {
        const ctx = getCtxSafe();
        const pm = ctx ? (ctx.promptManager || (ctx.chatCompletionSettings && ctx.chatCompletionSettings.promptManager)) : null;
        if (pm && typeof pm.render === 'function') {
            pm.render();
            console.debug(LOG_PREFIX, 'Refreshed UI via context promptManager.render()');
            return;
        }
    } catch (_) {}

    if (typeof jQuery !== 'undefined') {
        try {
            jQuery(document).trigger('promptManagerUpdated');
        } catch (_) {}
    }

    console.debug(LOG_PREFIX, 'UI refresh attempted via fallback');
}

export async function refreshPromptManagerUIUntilStable(savedState, chatIdAtStart = null) {
    await refreshPromptManagerUI();
    await new Promise((resolve) => setTimeout(resolve, 60));

    let mismatches = findSavedPromptStateMismatches(savedState);
    if (mismatches.length > 0) {
        console.debug(
            LOG_PREFIX,
            `Detected ${mismatches.length} prompt mismatch(es) after UI render; re-applying saved states.`,
            mismatches
        );
        const reapplyResult = applyPromptStates(savedState, chatIdAtStart);
        if (reapplyResult.aborted) return false;
        await refreshPromptManagerUI();
        await new Promise((resolve) => setTimeout(resolve, 40));
        mismatches = findSavedPromptStateMismatches(savedState);
    }

    return mismatches.length === 0;
}
