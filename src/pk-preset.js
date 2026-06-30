async function tryRefreshPromptManagerUI() {
    try {
        const ctx = getCtx();

        const pmInstance = ctx.PromptManager || ctx.promptManager || ctx.promptManagerInstance || null;
        if (pmInstance && typeof pmInstance.render === 'function') {
            pmInstance.render();
            console.debug(LOG_PREFIX, 'UI refreshed via PromptManager.render()');
            return;
        }
        if (pmInstance && typeof pmInstance.renderPromptManager === 'function') {
            pmInstance.renderPromptManager();
            console.debug(LOG_PREFIX, 'UI refreshed via PromptManager.renderPromptManager()');
            return;
        }

        // 不主动 emit OAI_PRESET_CHANGED_AFTER / PROMPT_MANAGER_SETTINGS_RENDERED。
        // 在 ST 1.16 + Edge 中，这类全局事件容易触发预设/正则扩展的刷新链，
        // 表现为刷新正则或预设 UI 时本插件又被重复刷新。这里仅使用本插件内部兜底同步。

        await new Promise(resolve => setTimeout(resolve, 100));
        const oaiSettings = ctx.chatCompletionSettings;
        if (oaiSettings && Array.isArray(oaiSettings.prompt_order)) {
            const enabledMap = {};
            for (const entry of oaiSettings.prompt_order) {
                if (Array.isArray(entry.order)) {
                    for (const item of entry.order) {
                        if (item.identifier) {
                            enabledMap[item.identifier] = item.enabled !== false;
                        }
                    }
                }
            }

            const $container = jQuery(
                '#completion_prompt_manager_list, #prompt_manager_list, .prompt_manager_list'
            ).first();
            if ($container.length > 0) {
                let synced = 0;
                $container.find('[data-pm-identifier], [data-prompt-id]').each(function () {
                    const $row = jQuery(this);
                    const identifier = $row.attr('data-pm-identifier') || $row.attr('data-prompt-id');
                    if (!identifier || enabledMap[identifier] === undefined) return;

                    const $checkbox = $row.find('input[type="checkbox"]').first();
                    if ($checkbox.length > 0 && $checkbox.prop('checked') !== enabledMap[identifier]) {
                        // 这里只同步显示层，不触发 change，避免 Prompt Manager 用旧 DOM 事件链反向覆盖刚恢复的底层状态。
                        $checkbox.prop('checked', enabledMap[identifier]);
                        synced++;
                    }
                });
                if (synced > 0) {
                    console.debug(LOG_PREFIX, `UI refresh: synced ${synced} checkbox(es) via DOM fallback`);
                    return;
                }
            }
        }

        const $pmContainer = jQuery(
            '#completion_prompt_manager, #prompt_manager_container, [id*="prompt_manager"]'
        ).first();
        if ($pmContainer.length > 0) {
            $pmContainer.find('select, input').first().trigger('change');
            console.debug(LOG_PREFIX, 'UI refresh triggered via DOM container change event');
        }
    } catch (e) {
        console.debug(LOG_PREFIX, 'tryRefreshPromptManagerUI: non-critical error', e);
    }
}

// ========== Preset ==========

/**
 * 获取当前活跃预设名称。优先通用 PresetManager API，回退 DOM。
 */
function getCurrentPresetName() {
    try {
        const ctx = getCtx();
        const pm = ctx.getPresetManager ? ctx.getPresetManager() : null;
        if (pm && typeof pm.getSelectedPresetName === 'function') {
            const name = pm.getSelectedPresetName();
            if (name) return name;
        }
        const $select = jQuery('#settings_preset_openai, #settings_preset').first();
        if ($select.length > 0) {
            const selectedText = $select.find('option:selected').text();
            if (selectedText) return selectedText.trim();
            if ($select.val()) return $select.val();
        }
    } catch (e) {
        console.warn(LOG_PREFIX, 'Failed to get current preset name:', e);
    }
    return null;
}

function isPresetNameMatch(currentPreset, targetPreset) {
    return Boolean(currentPreset && targetPreset && currentPreset.trim().toLowerCase() === targetPreset.trim().toLowerCase());
}

async function waitForPresetSwitch(presetName, timeoutMs = PRESET_SWITCH_TIMEOUT_MS) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (isPresetNameMatch(getCurrentPresetName(), presetName)) return true;
        await new Promise(resolve => setTimeout(resolve, PRESET_SWITCH_POLL_MS));
    }
    return isPresetNameMatch(getCurrentPresetName(), presetName);
}

async function waitForPromptStateReady(savedState, chatIdAtStart, timeoutMs = PROMPT_STATE_READY_TIMEOUT_MS) {
    const savedPrompts = savedState && savedState.prompts ? savedState.prompts : {};
    const savedIdentifiers = new Set(Object.keys(savedPrompts));
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        if (chatIdAtStart && getCtx().chatId !== chatIdAtStart) return false;

        const currentStates = readPromptStates();
        if (currentStates && currentStates.prompts) {
            const currentIdentifiers = Object.keys(currentStates.prompts);
            if (currentIdentifiers.some(identifier => savedIdentifiers.has(identifier))) {
                return true;
            }
        }

        await new Promise(resolve => setTimeout(resolve, PROMPT_STATE_READY_POLL_MS));
    }

    return true;
}

/**
 * 切换到指定预设。依次尝试 PresetManager API → DOM selector → Slash command。
 */
async function switchToPreset(presetName) {
    if (!presetName) return false;

    const currentPreset = getCurrentPresetName();
    if (currentPreset === presetName) {
        console.debug(LOG_PREFIX, `Already on preset "${presetName}", no switch needed.`);
        return true;
    }

    // Strategy 1: PresetManager 原生方法
    try {
        const ctx = getCtx();
        const pm = ctx.getPresetManager ? ctx.getPresetManager() : null;
        if (pm) {
            const methodCandidates = [
                typeof pm.selectPresetByName === 'function' ? pm.selectPresetByName : null,
                typeof pm.selectPreset === 'function' ? pm.selectPreset : null,
                typeof pm.changePreset === 'function' ? pm.changePreset : null,
            ].filter(Boolean);

            for (const method of methodCandidates) {
                try {
                    await method.call(pm, presetName);
                    await waitForPresetSwitch(presetName);
                    const current = getCurrentPresetName();
                    if (isPresetNameMatch(current, presetName)) {
                        console.log(LOG_PREFIX, `Switched preset to "${presetName}" via PresetManager native method.`);
                        return true;
                    }
                    console.debug(LOG_PREFIX, `PresetManager method ${method.name || '(anonymous)'} called but preset name mismatch (got "${current}"), trying next.`);
                } catch (methodErr) {
                    console.debug(LOG_PREFIX, `PresetManager method ${method.name || '(anonymous)'} threw:`, methodErr);
                }
            }
        }
    } catch (e) {
        console.debug(LOG_PREFIX, 'PresetManager native method approach failed:', e);
    }

    // Strategy 2: DOM selector（精确 + 大小写不敏感回退）
    try {
        const $select = jQuery('#settings_preset_openai, #settings_preset').first();
        if ($select.length > 0) {
            let matched = false;
            const targetLower = presetName.trim().toLowerCase();

            $select.find('option').each(function () {
                const $opt = jQuery(this);
                if ($opt.text().trim() === presetName || $opt.val() === presetName) {
                    $select.val($opt.val()).trigger('change');
                    matched = true;
                    return false;
                }
            });

            if (!matched) {
                $select.find('option').each(function () {
                    const $opt = jQuery(this);
                    if ($opt.text().trim().toLowerCase() === targetLower) {
                        $select.val($opt.val()).trigger('change');
                        matched = true;
                        return false;
                    }
                });
            }

            if (matched) {
                await waitForPresetSwitch(presetName);
                console.log(LOG_PREFIX, `Switched preset to "${presetName}" via DOM selector.`);
                return true;
            } else {
                console.warn(LOG_PREFIX, `Preset "${presetName}" not found in selector options. It may have been renamed or deleted.`);
            }
        }
    } catch (e) {
        console.warn(LOG_PREFIX, 'DOM selector approach failed:', e);
    }

    // Strategy 3: Slash command（最末兜底，切换后校验）
    try {
        const ctx = getCtx();
        const escapedName = presetName.replace(/"/g, '\\"');
        if (ctx.executeSlashCommandsWithOptions) {
            await ctx.executeSlashCommandsWithOptions(`/preset "${escapedName}"`);
            if (await waitForPresetSwitch(presetName)) return true;
        }
        if (ctx.executeSlashCommands) {
            await ctx.executeSlashCommands(`/preset "${escapedName}"`);
            if (await waitForPresetSwitch(presetName)) return true;
        }
    } catch (e) {
        console.warn(LOG_PREFIX, `Slash command approach failed for preset "${presetName}":`, e);
    }

    console.error(LOG_PREFIX, `All strategies failed to switch to preset "${presetName}". It may have been renamed or is unavailable on this device.`);
    return false;
}

// ========== Core: Save / Restore / Delete ==========



