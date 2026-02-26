import { App, Notice, PluginSettingTab, Setting, TFile, SuggestModal } from 'obsidian';
import Khoj from 'src/main';
import { canConnectToBackend, fetchChatModels, fetchUserServerSettings, getBackendStatusMessage, updateContentIndex, updateServerChatModel } from './utils';
import { t } from 'src/i18n';

export interface UserInfo {
    username?: string;
    photo?: string;
    is_active?: boolean;
    has_documents?: boolean;
    email?: string;
}

interface SyncFileTypes {
    markdown: boolean;
    images: boolean;
    pdf: boolean;
}

export interface ModelOption {
    id: string;
    name: string;
}

export interface ServerUserConfig {
    selected_chat_model_config?: number; // This is the ID from the server
    // Add other fields from UserConfig if needed by the plugin elsewhere
}

export interface KhojSetting {
    resultsCount: number;
    khojUrl: string;
    khojApiKey: string;
    connectedToBackend: boolean;
    autoConfigure: boolean;
    lastSync: Map<TFile, number>;
    syncFileType: SyncFileTypes;
    userInfo: UserInfo | null;
    syncFolders: string[];
    excludeFolders: string[];
    syncInterval: number;
    autoVoiceResponse: boolean;
    fileAccessMode: 'none' | 'read' | 'write';
    selectedChatModelId: string | null; // Mirrors server's selected_chat_model_config
    availableChatModels: ModelOption[];
}

export const DEFAULT_SETTINGS: KhojSetting = {
    resultsCount: 15,
    khojUrl: 'https://app.khoj.dev',
    khojApiKey: '',
    connectedToBackend: false,
    autoConfigure: true,
    lastSync: new Map(),
    syncFileType: {
        markdown: true,
        images: true,
        pdf: true,
    },
    userInfo: null,
    syncFolders: [],
    excludeFolders: [],
    syncInterval: 60,
    autoVoiceResponse: true,
    fileAccessMode: 'read',
    selectedChatModelId: null, // Will be populated from server
    availableChatModels: [],
}

export class KhojSettingTab extends PluginSettingTab {
    plugin: Khoj;
    private chatModelSetting: Setting | null = null;
    private storageProgressEl: HTMLProgressElement | null = null;
    private storageProgressText: HTMLSpanElement | null = null;

    constructor(app: App, plugin: Khoj) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        this.chatModelSetting = null; // Reset when display is called

        // Add notice whether able to connect to khoj backend or not
        let backendStatusMessage = getBackendStatusMessage(
            this.plugin.settings.connectedToBackend,
            this.plugin.settings.userInfo?.email,
            this.plugin.settings.khojUrl,
            this.plugin.settings.khojApiKey
        );

        const connectHeaderEl = containerEl.createEl('h3', { title: backendStatusMessage });
        const connectHeaderContentEl = connectHeaderEl.createSpan({ cls: 'khoj-connect-settings-header' });
        const connectTitleEl = connectHeaderContentEl.createSpan({ text: t('settings.section.connect') });
        const backendStatusEl = connectTitleEl.createSpan({ text: this.connectStatusIcon(), cls: 'khoj-connect-settings-header-status' });
        if (this.plugin.settings.userInfo && this.plugin.settings.connectedToBackend) {
            if (this.plugin.settings.userInfo.photo) {
                const profilePicEl = connectHeaderContentEl.createEl('img', {
                    attr: { src: this.plugin.settings.userInfo.photo },
                    cls: 'khoj-profile'
                });
                profilePicEl.addEventListener('click', () => { new Notice(backendStatusMessage); });
            } else if (this.plugin.settings.userInfo.email) {
                const initial = this.plugin.settings.userInfo.email[0].toUpperCase();
                const profilePicEl = connectHeaderContentEl.createDiv({
                    text: initial,
                    cls: 'khoj-profile khoj-profile-initial'
                });
                profilePicEl.addEventListener('click', () => { new Notice(backendStatusMessage); });
            }
        }
        if (this.plugin.settings.userInfo && this.plugin.settings.userInfo.email) {
            connectHeaderEl.title = this.plugin.settings.userInfo?.email === 'default@example.com'
                ? "Signed in"
                : `Signed in as ${this.plugin.settings.userInfo.email}`;
        }

        // Add khoj settings configurable from the plugin settings tab
        const apiKeySetting = new Setting(containerEl)
            .setName(t('settings.apiKey.name'))
            .addText(text => text
                .setValue(`${this.plugin.settings.khojApiKey}`)
                .onChange(async (value) => {
                    this.plugin.settings.khojApiKey = value.trim();
                    ({
                        connectedToBackend: this.plugin.settings.connectedToBackend,
                        userInfo: this.plugin.settings.userInfo,
                        statusMessage: backendStatusMessage,
                    } = await canConnectToBackend(this.plugin.settings.khojUrl, this.plugin.settings.khojApiKey));

                    if (!this.plugin.settings.connectedToBackend) {
                        this.plugin.settings.availableChatModels = [];
                        this.plugin.settings.selectedChatModelId = null;
                    }
                    await this.plugin.saveSettings();
                    backendStatusEl.setText(this.connectStatusIcon())
                    connectHeaderEl.title = backendStatusMessage;
                    await this.refreshModelsAndServerPreference();
                }));

        // Add API key setting description with link to get API key
        apiKeySetting.descEl.createEl('span', {
            text: t('settings.apiKey.description'),
        });
        apiKeySetting.descEl.createEl('a', {
            text: t('settings.apiKey.getLink'),
            href: `${this.plugin.settings.khojUrl}/settings#clients`,
            attr: { target: '_blank' }
        });

        new Setting(containerEl)
            .setName(t('settings.url.name'))
            .setDesc(t('settings.url.description'))
            .addText(text => text
                .setValue(`${this.plugin.settings.khojUrl}`)
                .onChange(async (value) => {
                    this.plugin.settings.khojUrl = value.trim().replace(/\/$/, '');
                    ({
                        connectedToBackend: this.plugin.settings.connectedToBackend,
                        userInfo: this.plugin.settings.userInfo,
                        statusMessage: backendStatusMessage,
                    } = await canConnectToBackend(this.plugin.settings.khojUrl, this.plugin.settings.khojApiKey));

                    if (!this.plugin.settings.connectedToBackend) {
                        this.plugin.settings.availableChatModels = [];
                        this.plugin.settings.selectedChatModelId = null;
                    }
                    await this.plugin.saveSettings();
                    backendStatusEl.setText(this.connectStatusIcon())
                    connectHeaderEl.title = backendStatusMessage;
                    await this.refreshModelsAndServerPreference();
                }));

        // Interact section
        containerEl.createEl('h3', { text: t('settings.section.interact') });

        // Chat Model Dropdown
        this.renderChatModelDropdown();

        // Initial fetch of models and server preference if connected
        if (this.plugin.settings.connectedToBackend) {
            // Defer slightly to ensure UI is ready and avoid race conditions
            setTimeout(async () => {
                await this.refreshModelsAndServerPreference();
            }, 1000);
        }

        // Add new setting for auto voice response after voice input
        new Setting(containerEl)
            .setName(t('settings.autoVoiceResponse.name'))
            .setDesc(t('settings.autoVoiceResponse.description'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoVoiceResponse)
                .onChange(async (value) => {
                    this.plugin.settings.autoVoiceResponse = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName(t('settings.resultsCount.name'))
            .setDesc(t('settings.resultsCount.description'))
            .addSlider(slider => slider
                .setLimits(1, 30, 1)
                .setValue(this.plugin.settings.resultsCount)
                .setDynamicTooltip()
                .onChange(async (value) => {
                    this.plugin.settings.resultsCount = value;
                    await this.plugin.saveSettings();
                }));

        // Add new "Sync" heading
        containerEl.createEl('h3', { text: t('settings.section.sync') });

        new Setting(containerEl)
            .setName(t('settings.autoSync.name'))
            .setDesc(t('settings.autoSync.description'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.autoConfigure)
                .onChange(async (value) => {
                    this.plugin.settings.autoConfigure = value;
                    await this.plugin.saveSettings();
                }));

        // Add setting to sync markdown notes
        new Setting(containerEl)
            .setName(t('settings.syncNotes.name'))
            .setDesc(t('settings.syncNotes.description'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncFileType.markdown)
                .onChange(async (value) => {
                    this.plugin.settings.syncFileType.markdown = value;
                    await this.plugin.saveSettings();
                    this.refreshStorageDisplay();
                }));

        // Add setting to sync images
        new Setting(containerEl)
            .setName(t('settings.syncImages.name'))
            .setDesc(t('settings.syncImages.description'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncFileType.images)
                .onChange(async (value) => {
                    this.plugin.settings.syncFileType.images = value;
                    await this.plugin.saveSettings();
                    this.refreshStorageDisplay();
                }));

        // Add setting to sync PDFs
        new Setting(containerEl)
            .setName(t('settings.syncPdfs.name'))
            .setDesc(t('settings.syncPdfs.description'))
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.syncFileType.pdf)
                .onChange(async (value) => {
                    this.plugin.settings.syncFileType.pdf = value;
                    await this.plugin.saveSettings();
                    this.refreshStorageDisplay();
                }));

        // Add setting for sync interval
        const syncIntervalValues = [1, 5, 10, 20, 30, 45, 60, 120, 1440];
        new Setting(containerEl)
            .setName(t('settings.syncInterval.name'))
            .setDesc(t('settings.syncInterval.description'))
            .addDropdown(dropdown => dropdown
                .addOptions(Object.fromEntries(
                    syncIntervalValues.map(value => [
                        value.toString(),
                        value === 1 ? t('settings.syncInterval.option.1') :
                            value === 1440 ? t('settings.syncInterval.option.1440') :
                                t('settings.syncInterval.option.minutes').replace('{value}', value.toString())
                    ])
                ))
                .setValue(this.plugin.settings.syncInterval.toString())
                .onChange(async (value) => {
                    this.plugin.settings.syncInterval = parseInt(value);
                    await this.plugin.saveSettings();
                    // Restart the timer with the new interval
                    this.plugin.restartSyncTimer();
                }));

        // Add setting to manage include folders
        const includeFoldersContainer = containerEl.createDiv('include-folders-container');
        new Setting(includeFoldersContainer)
            .setName(t('settings.includeFolders.name'))
            .setDesc(t('settings.includeFolders.description'))
            .addButton(button => button
                .setButtonText(t('settings.includeFolders.button.add'))
                .onClick(() => {
                    const modal = new FolderSuggestModal(this.app, async (folder: string) => {
                        if (!this.plugin.settings.syncFolders.includes(folder)) {
                            this.plugin.settings.syncFolders.push(folder);
                            await this.plugin.saveSettings();
                            this.updateIncludeFolderList(includeFolderListEl);
                            this.refreshStorageDisplay();
                        }
                    });
                    modal.open();
                }));

        // Create a list to display selected include folders
        const includeFolderListEl = includeFoldersContainer.createDiv('folder-list');
        this.updateIncludeFolderList(includeFolderListEl);

        // Add setting to manage exclude folders
        const excludeFoldersContainer = containerEl.createDiv('exclude-folders-container');
        new Setting(excludeFoldersContainer)
            .setName(t('settings.excludeFolders.name'))
            .setDesc(t('settings.excludeFolders.description'))
            .addButton(button => button
                .setButtonText(t('settings.excludeFolders.button.add'))
                .onClick(() => {
                    const modal = new FolderSuggestModal(this.app, async (folder: string) => {
                        // Don't allow excluding root folder
                        if (folder === '') {
                            new Notice(t('settings.excludeFolders.cannotExcludeRoot'));
                            return;
                        }
                        if (!this.plugin.settings.excludeFolders.includes(folder)) {
                            this.plugin.settings.excludeFolders.push(folder);
                            await this.plugin.saveSettings();
                            this.updateExcludeFolderList(excludeFolderListEl);
                            this.refreshStorageDisplay();
                        }
                    });
                    modal.open();
                }));

        // Create a list to display selected exclude folders
        const excludeFolderListEl = excludeFoldersContainer.createDiv('folder-list');
        this.updateExcludeFolderList(excludeFolderListEl);

        let indexVaultSetting = new Setting(containerEl);
        indexVaultSetting
            .setName(t('settings.forceSync.name'))
            .setDesc(t('settings.forceSync.description'))
            .addButton(button => button
                .setButtonText(t('settings.forceSync.button'))
                .setCta()
                .onClick(async () => {
                    // Disable button while updating index
                    button.setButtonText(t('settings.forceSync.button.updating') + ' 🌑');
                    button.removeCta();
                    indexVaultSetting = indexVaultSetting.setDisabled(true);

                    // Show indicator for indexing in progress (animated text)
                    const progress_indicator = window.setInterval(() => {
                        const updatingPrefix = t('settings.forceSync.button.updating') + ' ';
                        if (button.buttonEl.innerText.startsWith(updatingPrefix)) {
                            // Keep the updating prefix with different moon phases
                            const currentPhase = button.buttonEl.innerText.replace(updatingPrefix, '');
                            const phases = ['🌑', '🌘', '🌗', '🌖', '🌕', '🌔', '🌓', '🌒'];
                            const currentIndex = phases.indexOf(currentPhase);
                            const nextIndex = (currentIndex + 1) % phases.length;
                            button.setButtonText(updatingPrefix + phases[nextIndex]);
                        }
                    }, 300);
                    this.plugin.registerInterval(progress_indicator);

                    // Obtain sync progress elements by id (created below)
                    const syncProgressEl = document.getElementById('khoj-sync-progress') as HTMLProgressElement | null;
                    const syncProgressText = document.getElementById('khoj-sync-progress-text') as HTMLElement | null;

                    if (syncProgressEl && syncProgressText) {
                        syncProgressEl.style.display = '';
                        syncProgressText.style.display = '';
                        syncProgressText.textContent = t('settings.forceSync.progress.preparing');
                        syncProgressEl.value = 0;
                        syncProgressEl.max = 1;
                    }

                    const onProgress = (progress: { processed: number, total: number }) => {
                        const el = document.getElementById('khoj-sync-progress') as HTMLProgressElement | null;
                        const txt = document.getElementById('khoj-sync-progress-text') as HTMLElement | null;
                        if (!el || !txt) return;
                        el.max = Math.max(progress.total, 1);
                        el.value = Math.min(progress.processed, el.max);
                        txt.textContent = t('settings.forceSync.progress.syncing').replace('{processed}', progress.processed.toString()).replace('{total}', progress.total.toString());
                    };

                    try {
                        this.plugin.settings.lastSync = await updateContentIndex(
                            this.app.vault, this.plugin.settings, this.plugin.settings.lastSync, true, true, onProgress
                        );
                    } finally {
                        // Cleanup: hide sync progress UI
                        const el = document.getElementById('khoj-sync-progress') as HTMLProgressElement | null;
                        const txt = document.getElementById('khoj-sync-progress-text') as HTMLElement | null;
                        if (el) el.style.display = 'none';
                        if (txt) txt.style.display = 'none';
                        this.refreshStorageDisplay();

                        // Reset button state
                        window.clearInterval(progress_indicator);
                        button.setButtonText('Update');
                        button.setCta();
                        indexVaultSetting = indexVaultSetting.setDisabled(false);
                    }
                })
            );
        // Estimated Cloud Storage (client-side)
        const storageSetting = new Setting(containerEl)
            .setName(t('settings.storage.name'))
            .setDesc(t('settings.storage.description'))
            .then(() => { });

        // Create custom elements: progress and text for storage estimation
        this.storageProgressEl = document.createElement('progress');
        this.storageProgressEl.value = 0;
        this.storageProgressEl.max = 1;
        this.storageProgressEl.style.width = '100%';
        this.storageProgressText = document.createElement('span');
        this.storageProgressText.textContent = t('settings.storage.calculating');
        storageSetting.descEl.appendChild(this.storageProgressEl);
        storageSetting.descEl.appendChild(this.storageProgressText);

        // Create progress bar for Force Sync operation (hidden by default)
        const syncProgressEl = document.createElement('progress');
        syncProgressEl.id = 'khoj-sync-progress';
        syncProgressEl.value = 0;
        syncProgressEl.max = 1;
        syncProgressEl.style.width = '100%';
        syncProgressEl.style.display = 'none';
        const syncProgressText = document.createElement('span');
        syncProgressText.id = 'khoj-sync-progress-text';
        syncProgressText.textContent = '';
        syncProgressText.style.display = 'none';
        storageSetting.descEl.appendChild(syncProgressEl);
        storageSetting.descEl.appendChild(syncProgressText);

        // Call initial update
        this.refreshStorageDisplay();
    }

    private connectStatusIcon() {
        if (this.plugin.settings.connectedToBackend && this.plugin.settings.userInfo?.email)
            return '🟢';
        else if (this.plugin.settings.connectedToBackend)
            return '🟡'
        else
            return '🔴';
    }

    private async refreshStorageDisplay() {
        if (!this.storageProgressEl || !this.storageProgressText) return;

        // Show calculating state
        this.storageProgressEl.removeAttribute('value');
        this.storageProgressText.textContent = t('settings.storage.calculating');
        try {
            const { calculateVaultSyncMetrics } = await import('./utils');
            const metrics = await calculateVaultSyncMetrics(this.app.vault, this.plugin.settings);
            const usedMB = (metrics.usedBytes / (1024 * 1024));
            const totalMB = (metrics.totalBytes / (1024 * 1024));
            const usedStr = `${usedMB.toFixed(1)} MB`;
            const totalStr = `${totalMB.toFixed(0)} MB`;
            this.storageProgressEl.value = metrics.usedBytes;
            this.storageProgressEl.max = metrics.totalBytes;
            this.storageProgressText.textContent = `${usedStr} / ${totalStr}`;
        } catch (err) {
            console.error('Khoj: Failed to update storage display', err);
            this.storageProgressText.textContent = t('settings.storage.unavailable');
        }
    }

    private async refreshModelsAndServerPreference() {
        let serverSelectedModelId: string | null = null;
        if (this.plugin.settings.connectedToBackend) {
            const [availableModels, serverConfig] = await Promise.all([
                fetchChatModels(this.plugin.settings),
                fetchUserServerSettings(this.plugin.settings)
            ]);

            this.plugin.settings.availableChatModels = availableModels;

            if (serverConfig && serverConfig.selected_chat_model_config !== undefined && serverConfig.selected_chat_model_config !== null) {
                const serverModelIdStr = serverConfig.selected_chat_model_config.toString();
                // Ensure the server's selected model is actually in the available list
                if (this.plugin.settings.availableChatModels.some(m => m.id === serverModelIdStr)) {
                    serverSelectedModelId = serverModelIdStr;
                } else {
                    // Server has a selection, but it's not in the options list (e.g. model removed, or different set of models)
                    // In this case, we might fall back to null (Khoj Default)
                    console.warn(`Khoj: Server's selected model ID ${serverModelIdStr} not in available models. Falling back to default.`);
                    serverSelectedModelId = null;
                }
            } else {
                // No specific model configured on the server, or it's explicitly null
                serverSelectedModelId = null;
            }
            this.plugin.settings.selectedChatModelId = serverSelectedModelId;

        } else {
            this.plugin.settings.availableChatModels = [];
            this.plugin.settings.selectedChatModelId = null; // Clear selection if disconnected
        }
        await this.plugin.saveSettings(); // Save the potentially updated selectedChatModelId
        this.renderChatModelDropdown(); // Re-render the dropdown with new data
    }

    private renderChatModelDropdown() {
        if (!this.chatModelSetting) {
            this.chatModelSetting = new Setting(this.containerEl)
                .setName(t('settings.chatModel.name'));
        } else {
            // Clear previous description and controls to prepare for re-rendering
            this.chatModelSetting.descEl.empty();
            this.chatModelSetting.controlEl.empty();
        }
        // Use this.chatModelSetting directly for modifications
        const modelSetting = this.chatModelSetting;

        if (!this.plugin.settings.connectedToBackend) {
            modelSetting.setDesc(t('settings.chatModel.description.disconnected'));
            modelSetting.addText(text => text.setValue(t('settings.chatModel.text.notConnected')).setDisabled(true));
            return;
        }

        if (this.plugin.settings.availableChatModels.length === 0 && this.plugin.settings.connectedToBackend) {
            modelSetting.setDesc(t('settings.chatModel.description.fetching'));
            modelSetting.addButton(button => button
                .setButtonText(t('settings.chatModel.button.refresh'))
                .onClick(async () => {
                    button.setButtonText(t('settings.chatModel.button.refreshing')).setDisabled(true);
                    await this.refreshModelsAndServerPreference();
                    // Re-rendering happens inside refreshModelsAndServerPreference
                }));
            return;
        }

        modelSetting.setDesc(t('settings.chatModel.description.connected'));
        modelSetting.addDropdown(dropdown => {
            dropdown.addOption('', t('settings.chatModel.option.default')); // Placeholder when cannot retrieve chat model options from server.
            this.plugin.settings.availableChatModels.forEach(model => {
                dropdown.addOption(model.id, model.name);
            });
            dropdown
                .setValue(this.plugin.settings.selectedChatModelId || '')
                .onChange(async (value) => {
                    // Attempt to update the server
                    const success = await updateServerChatModel(value, this.plugin.settings);
                    if (success) {
                        await this.plugin.saveSettings();
                    } else {
                        // Server update failed, revert dropdown to the current setting value
                        // to avoid UI mismatch.
                        dropdown.setValue(this.plugin.settings.selectedChatModelId || '');
                    }
                    // Potentially re-render or refresh if needed, though setValue should update UI.
                    // this.refreshModelsAndServerPreference(); // Could be called to ensure full sync, but might be too much
                });
        });
    }

    // Helper method to update the include folder list display
    private updateIncludeFolderList(containerEl: HTMLElement) {
        this.updateFolderList(
            containerEl,
            this.plugin.settings.syncFolders,
            t('settings.includeFolders.empty'),
            async (folder) => {
                this.plugin.settings.syncFolders = this.plugin.settings.syncFolders.filter(f => f !== folder);
                await this.plugin.saveSettings();
                this.updateIncludeFolderList(containerEl);
                this.refreshStorageDisplay();
            }
        );
    }

    // Helper method to update the exclude folder list display
    private updateExcludeFolderList(containerEl: HTMLElement) {
        this.updateFolderList(
            containerEl,
            this.plugin.settings.excludeFolders,
            t('settings.excludeFolders.empty'),
            async (folder) => {
                this.plugin.settings.excludeFolders = this.plugin.settings.excludeFolders.filter(f => f !== folder);
                await this.plugin.saveSettings();
                this.updateExcludeFolderList(containerEl);
                this.refreshStorageDisplay();
            }
        );
    }

    // Shared helper to render a folder list with remove buttons
    private updateFolderList(
        containerEl: HTMLElement,
        folders: string[],
        emptyText: string,
        onRemove: (folder: string) => void
    ) {
        containerEl.empty();
        if (folders.length === 0) {
            containerEl.createEl('div', {
                text: emptyText,
                cls: 'folder-list-empty'
            });
            return;
        }

        const list = containerEl.createEl('ul', { cls: 'folder-list' });
        folders.forEach(folder => {
            const item = list.createEl('li', { cls: 'folder-list-item' });
            item.createSpan({ text: folder });

            const removeButton = item.createEl('button', {
                cls: 'folder-list-remove',
                text: t('settings.folderList.remove')
            });
            removeButton.addEventListener('click', () => onRemove(folder));
        });
    }
}

// Modal with folder suggestions
class FolderSuggestModal extends SuggestModal<string> {
    constructor(app: App, private onChoose: (folder: string) => void) {
        super(app);
    }

    getSuggestions(query: string): string[] {
        const folders = this.getAllFolders();
        if (!query) return folders;

        return folders.filter(folder =>
            folder.toLowerCase().includes(query.toLowerCase())
        );
    }

    renderSuggestion(folder: string, el: HTMLElement) {
        el.createSpan({
            text: folder || '/',
            cls: 'folder-suggest-item'
        });
    }

    onChooseSuggestion(folder: string, _: MouseEvent | KeyboardEvent) {
        this.onChoose(folder);
    }

    private getAllFolders(): string[] {
        const folders = new Set<string>();
        folders.add(''); // Root folder

        // Get all files and extract folder paths
        this.app.vault.getAllLoadedFiles().forEach(file => {
            const folderPath = file.parent?.path;
            if (folderPath) {
                folders.add(folderPath);

                // Also add all parent folders
                let parent = folderPath;
                while (parent.includes('/')) {
                    parent = parent.substring(0, parent.lastIndexOf('/'));
                    folders.add(parent);
                }
            }
        });

        return Array.from(folders).sort();
    }
}
