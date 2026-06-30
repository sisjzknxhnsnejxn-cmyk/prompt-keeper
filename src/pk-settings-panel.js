// ========== Settings Panel ==========

function loadSettingsPanel() {
    if (jQuery('#prompt-keeper-settings').length > 0) return;
    jQuery('#extensions_settings2').append(SETTINGS_HTML);

    const settings = loadPluginSettings();
    jQuery('#pk-enabled-toggle').prop('checked', settings.enabled !== false);
    jQuery('#pk-auto-restore-toggle').prop('checked', settings.autoRestore !== false);
    jQuery('#pk-custom-save-name-toggle').prop('checked', settings.customSaveName === true);

    jQuery('#pk-enabled-toggle').on('change', function () {
        const s = loadPluginSettings();
        s.enabled = jQuery(this).prop('checked');
        savePluginSettings();
        if (s.enabled) {
            toastr.success('已启用', 'Prompt Keeper');
        } else {
            console.info(LOG_PREFIX, '已禁用');
            if (autoRestoreTimer) {
                clearTimeout(autoRestoreTimer);
                autoRestoreTimer = null;
            }
        }
    });

    jQuery('#pk-auto-restore-toggle').on('change', function () {
        const s = loadPluginSettings();
        s.autoRestore = jQuery(this).prop('checked');
        savePluginSettings();
        if (s.autoRestore) {
            toastr.success('自动恢复已开', 'Prompt Keeper');
        } else {
            console.info(LOG_PREFIX, '自动恢复已关');
            if (autoRestoreTimer) {
                clearTimeout(autoRestoreTimer);
                autoRestoreTimer = null;
            }
        }
    });

    jQuery('#pk-custom-save-name-toggle').on('change', function () {
        const s = loadPluginSettings();
        s.customSaveName = jQuery(this).prop('checked');
        savePluginSettings();
        toastr.info(
            s.customSaveName ? '保存时会询问槽位名称' : '保存时将使用当前预设名',
            'Prompt Keeper'
        );
    });

    console.log(LOG_PREFIX, 'Settings panel loaded.');
}



