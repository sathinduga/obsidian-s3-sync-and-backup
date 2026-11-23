/**
 * Settings Tab Module
 *
 * Provides the plugin settings UI with sections for:
 * - Connection (S3 provider configuration)
 * - Encryption (E2E encryption settings)
 * - Sync (synchronization options)
 * - Backup (backup scheduling and retention)
 * - Advanced (debug logging, exclude patterns)
 */

import { App, Modal, Notice, PluginSettingTab, requireApiVersion, SecretComponent, Setting } from 'obsidian';
import type { ButtonComponent, SettingDefinitionGroup, SettingDefinitionRender, TextComponent } from 'obsidian';
import type S3SyncBackupPlugin from './main';
import type { EncryptionCoordinator } from './crypto/EncryptionCoordinator';
import {
	S3ProviderType,
	type S3ConnectionSettings,
	S3_PROVIDER_NAMES,
	SyncIntervalMinutes,
	BackupInterval,
	BACKUP_INTERVAL_NAMES,
	RetentionMode,
	DEFAULT_SETTINGS,
} from './types';
import { normalizePrefix } from './utils/paths';
import { validatePassphrase } from './crypto/KeyDerivation';
import { BackupListModal } from './backup/BackupListModal';

/**
 * Sync interval display names for dropdown.
 *
 * Maps each allowed sync interval (in minutes) to a human-readable label shown in
 * the settings UI. The keys are the numeric `SyncIntervalMinutes` union values and
 * must stay in sync with that type. Stored as a module-level constant so it is
 * only allocated once regardless of how many times the settings tab is rendered.
 */
const SYNC_INTERVAL_NAMES: Record<SyncIntervalMinutes, string> = {
	1: '1 minute',
	2: '2 minutes',
	5: '5 minutes',
	10: '10 minutes',
	15: '15 minutes',
	30: '30 minutes',
};

/** Editable starting regions for a provider without a saved connection. */
const DEFAULT_REGIONS: Record<S3ProviderType, string> = {
	aws: DEFAULT_SETTINGS.region,
	r2: 'auto',
	b2: '',
	rustfs: 'us-east-1',
	custom: '',
};

/** Extract the region only from Backblaze's standard S3 endpoint hostname. */
function backblazeEndpointRegion(endpoint: string): string {
	try {
		const { hostname } = new URL(endpoint.trim());
		return /^s3\.([a-z0-9]+(?:-[a-z0-9]+)+)\.backblazeb2\.com$/.exec(hostname)?.[1] ?? '';
	} catch {
		return '';
	}
}

/** A setting name and description serve both the legacy form and the modern search index. */
type SettingsRow = Omit<SettingDefinitionRender, 'render'> & { render: (setting: Setting) => void };

/** Builds an ordered group of settings without creating DOM during search indexing. */
class SettingsSection {
	private readonly rows: SettingsRow[] = [];

	constructor(private readonly heading: string) {}

	add(name: string, desc: string, render: SettingsRow['render']): void {
		this.rows.push({ name, desc, render });
	}

	addHeading(name: string): void {
		this.rows.push({ name, searchable: false, render: (setting) => { setting.setHeading(); } });
	}

	/** Keep a multi-control form together so it also works when reached from search. */
	addForm(name: string, aliases: string[], render: (containerEl: HTMLElement) => void): void {
		this.rows.push({
			name,
			aliases,
			render: (setting) => {
				setting.setClass('s3-sync-settings-form');
				setting.settingEl.empty();
				render(setting.settingEl);
			},
		});
	}

	getDefinition(): SettingDefinitionGroup {
		return { type: 'group', heading: this.heading, items: this.rows };
	}

	display(containerEl: HTMLElement): void {
		new Setting(containerEl).setName(this.heading).setHeading();
		for (const row of this.rows) {
			const setting = new Setting(containerEl).setName(row.name);
			if (row.desc !== undefined) setting.setDesc(row.desc);
			row.render(setting);
		}
	}
}

/** Plugin settings with shared controls and callbacks for both Obsidian renderers. */
export class S3SyncBackupSettingTab extends PluginSettingTab {
	plugin: S3SyncBackupPlugin;
	private showEncryptionSetup = false;
	private connectionDraft: S3ConnectionSettings | null = null;
	private savingConnection = false;
	private backblazeRegionEdited = false;

	private get connection(): S3ConnectionSettings {
		return this.connectionDraft ?? this.plugin.settings;
	}

	/**
	 * @param app    - The Obsidian application instance.
	 * @param plugin - The plugin instance that owns this settings tab.
	 */
	constructor(app: App, plugin: S3SyncBackupPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	/** Obsidian 1.13+ calls this to render settings and index the rows for search. */
	getSettingDefinitions(): SettingDefinitionGroup[] {
		return this.getSections().map((section) => section.getDefinition());
	}

	/** Obsidian 1.11.5 and 1.12 render the same rows through the legacy API. */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('s3-sync-backup-settings');
		for (const section of this.getSections()) {
			section.display(containerEl);
		}
	}

	/** Closing or leaving the tab discards unsaved connection edits. */
	hide(): void {
		this.discardConnectionDraft();
		super.hide();
	}

	private getSections(): SettingsSection[] {
		const connection = new SettingsSection('Connection');
		this.addConnectionSettings(connection);

		const encryption = new SettingsSection('Encryption');
		encryption.addForm(
			'End-to-end encryption',
			['Enable end-to-end encryption', 'Passphrase', 'Remember passphrase'],
			(containerEl) => { this.renderEncryptionForm(containerEl); },
		);

		const sync = new SettingsSection('Sync');
		this.addSyncSettings(sync);

		const backup = new SettingsSection('Backup');
		this.addBackupSettings(backup);

		const advanced = new SettingsSection('Advanced');
		this.addAdvancedSettings(advanced);

		return [connection, encryption, sync, backup, advanced];
	}

	/** Refresh conditional rows and the search index after a setting changes. */
	private refreshSettings(): void {
		if (requireApiVersion('1.13.0')) {
			this.update();
		} else {
			this.display();
		}
	}

	private discardConnectionDraft(): void {
		this.connectionDraft = null;
		this.backblazeRegionEdited = false;
	}

	/** Render an editable connection draft shared by both settings APIs. */
	private addConnectionSettings(section: SettingsSection): void {
		const shownProvider = this.connection.provider;
		let saveButton: ButtonComponent | undefined;
		let discardButton: ButtonComponent | undefined;
		let regionInput: TextComponent | undefined;
		const updateButtons = () => {
			const disabled = !this.connectionDraft || this.savingConnection;
			saveButton?.setDisabled(disabled);
			discardButton?.setDisabled(disabled);
		};
		const edit = (changes: Partial<S3ConnectionSettings>) => {
			if (this.savingConnection || this.connection.provider !== shownProvider) return;
			const { provider, endpoint, region, bucket, accessKeyIdSecret, secretAccessKeySecret, forcePathStyle } = this.connection;
			this.connectionDraft = {
				provider, endpoint, region, bucket, accessKeyIdSecret, secretAccessKeySecret, forcePathStyle, ...changes,
			};
			updateButtons();
		};

		section.add('Provider', 'Select your S3-compatible storage provider', (setting) => {
			setting.addDropdown((dropdown) => {
				for (const [value, name] of Object.entries(S3_PROVIDER_NAMES)) {
					dropdown.addOption(value, name);
				}
				dropdown.setDisabled(this.savingConnection).setValue(this.connection.provider);
				dropdown.onChange((value) => {
					const provider = value as S3ProviderType;
					if (this.savingConnection || provider === this.connection.provider) return;
					this.discardConnectionDraft();
					if (provider !== this.plugin.settings.provider) this.connectionDraft = {
						provider,
						endpoint: '',
						region: DEFAULT_REGIONS[provider],
						bucket: '',
						accessKeyIdSecret: '',
						secretAccessKeySecret: '',
						forcePathStyle: DEFAULT_SETTINGS.forcePathStyle,
					};
					this.refreshSettings();
				});
			});
		});

		if (this.connection.provider !== 'aws') {
			section.add('Endpoint URL', this.getEndpointDescription(), (setting) => {
				setting.addText((text) => text
					.setDisabled(this.savingConnection)
					.setPlaceholder(this.getEndpointPlaceholder())
					.setValue(this.connection.endpoint)
					.onChange((endpoint) => {
						if (this.savingConnection) return;
						const current = this.connection;
						if (current.provider === 'b2' && !this.backblazeRegionEdited &&
							(!current.region || current.region === backblazeEndpointRegion(current.endpoint))) {
							const region = backblazeEndpointRegion(endpoint);
							edit({ endpoint, region });
							regionInput?.setValue(region);
							return;
						}
						edit({ endpoint });
					}));
			});
		}

		section.add('Region', this.getRegionDescription(), (setting) => {
			setting.addText((text) => {
				regionInput = text.setDisabled(this.savingConnection)
					.setPlaceholder(this.getRegionPlaceholder())
					.setValue(this.connection.region)
					.onChange((region) => {
						if (this.savingConnection) return;
						this.backblazeRegionEdited = this.connection.provider === 'b2' && !!region.trim();
						edit({ region });
					});
			});
		});

		section.add('Bucket', 'Name of your S3 bucket', (setting) => {
			setting.addText((text) => text
				.setDisabled(this.savingConnection)
				.setPlaceholder('Bucket name')
				.setValue(this.connection.bucket)
				.onChange((bucket) => edit({ bucket })));
		});

		section.add('Access key ID', 'Select or create a secret holding your S3 access key ID', (setting) => {
			setting.addComponent((el) => new SecretComponent(this.app, el)
				.setDisabled(this.savingConnection)
				.setValue(this.connection.accessKeyIdSecret)
				.onChange((value) => edit({ accessKeyIdSecret: value ?? '' })));
		});

		section.add('Secret access key', 'Select or create a secret holding your S3 secret access key', (setting) => {
			setting.addComponent((el) => new SecretComponent(this.app, el)
				.setDisabled(this.savingConnection)
				.setValue(this.connection.secretAccessKeySecret)
				.onChange((value) => edit({ secretAccessKeySecret: value ?? '' })));
		});

		if (this.connection.provider === 'custom') {
			section.add('Force path style', 'Use path-style URL format (required for some S3 compatible services)', (setting) => {
				setting.addToggle((toggle) => toggle
					.setDisabled(this.savingConnection)
					.setValue(this.connection.forcePathStyle)
					.onChange((forcePathStyle) => edit({ forcePathStyle })));
			});
		}

		section.add('Test connection', 'Verify your S3 credentials and bucket access', (setting) => {
			setting.addButton((button) => {
				button.setButtonText('Test connection').setDisabled(this.savingConnection);
				button.onClick(async () => {
					await this.testConnection(button.buttonEl);
				});
			});
		});

		section.add('Connection changes', 'Sync and backup use the saved connection. Switching providers or leaving settings discards pending edits.', (setting) => {
			setting.addButton((button) => {
				saveButton = button.setButtonText(this.savingConnection ? 'Saving connection…' : 'Save connection')
					.setCta().onClick(() => this.saveConnectionDraft());
				updateButtons();
			});
			setting.addButton((button) => {
				discardButton = button.setButtonText('Discard changes').onClick(() => {
					if (this.savingConnection) return;
					this.discardConnectionDraft();
					this.refreshSettings();
				});
				updateButtons();
			});
		});
	}

	private async saveConnectionDraft(): Promise<void> {
		if (!this.connectionDraft || this.savingConnection) return;
		const draft = this.connectionDraft;
		this.savingConnection = true;
		this.refreshSettings();
		try {
			await this.plugin.saveConnection(draft);
			this.discardConnectionDraft();
			new Notice('Connection saved');
		} catch (error) {
			new Notice(error instanceof Error ? error.message : 'Unable to save the connection');
		} finally {
			this.savingConnection = false;
			this.refreshSettings();
		}
	}

	/**
	 * Return a human-readable description for the endpoint URL field.
	 *
	 * Each provider has a distinct URL format, so the description gives provider-
	 * specific guidance (e.g., the R2 account-ID URL pattern).
	 *
	 * @returns A localized description string appropriate for the current provider.
	 */
	private getEndpointDescription(): string {
		switch (this.connection.provider) {
			case 'r2':
				return 'Your R2 endpoint URL (https://<ACCOUNT_ID>.r2.cloudflarestorage.com)';
			case 'b2':
				return 'Your Backblaze B2 S3 endpoint URL (https://s3.<REGION>.backblazeb2.com)';
			case 'rustfs':
				return 'Your RustFS server URL (e.g., http://localhost:9000)';
			case 'custom':
				return 'Your S3-compatible endpoint URL';
			default:
				return 'S3 endpoint URL';
		}
	}

	/**
	 * Return the placeholder text for the endpoint URL input field.
	 *
	 * Provides a concrete example URL so users know the expected format for their
	 * chosen provider (e.g., the RustFS localhost URL pattern).
	 *
	 * @returns A provider-specific example URL string, or an empty string for AWS
	 *   (endpoint not shown for AWS).
	 */
	private getEndpointPlaceholder(): string {
		switch (this.connection.provider) {
			case 'r2':
				return 'https://abc123.r2.cloudflarestorage.com';
			case 'b2':
				return 'https://s3.us-west-004.backblazeb2.com';
			case 'rustfs':
				return 'http://localhost:9000';
			case 'custom':
				return 'https://s3.example.com';
			default:
				return '';
		}
	}

	/** Explain which signing region the displayed provider expects. */
	private getRegionDescription(): string {
		switch (this.connection.provider) {
			case 'r2':
				return 'Use "auto" for Cloudflare R2';
			case 'b2':
				return 'Filled from your Backblaze B2 endpoint. You can also enter the region manually.';
			case 'rustfs':
				return 'Your RustFS server region (defaults to us-east-1)';
			case 'aws':
				return 'Your AWS bucket region (e.g., us-east-1)';
			default:
				return 'Enter the region your S3-compatible service expects';
		}
	}

	/**
	 * Return the placeholder text for the region input field.
	 *
	 * @returns A provider-specific example region string.
	 */
	private getRegionPlaceholder(): string {
		const { provider } = this.connection;
		return provider === 'b2' ? 'us-west-004' : DEFAULT_REGIONS[provider] ?? '';
	}

	/** Use the selected draft without changing the client used by sync and backup. */
	private async testConnection(buttonEl: HTMLButtonElement): Promise<void> {
		const draft = this.connectionDraft;
		const originalText = buttonEl.textContent;
		buttonEl.textContent = 'Testing…';
		buttonEl.disabled = true;

		try {
			const message = await this.plugin.testConnection(draft ?? undefined);
			if (buttonEl.isConnected && draft === this.connectionDraft) new Notice(message);
		} catch (error) {
			if (buttonEl.isConnected && draft === this.connectionDraft) {
				new Notice(error instanceof Error ? error.message : 'Unable to test the connection');
			}
		} finally {
			buttonEl.textContent = originalText;
			buttonEl.disabled = false;
		}
	}

	/**
	 * Render the Encryption settings section.
	 *
	 * The UI state is derived from the EncryptionCoordinator's runtime state:
	 * - Plaintext + no key → show "Enable encryption" toggle + passphrase field
	 * - Encrypted + no key → show "Unlock" passphrase field (vault locked)
	 * - Encrypted + key loaded → show "Encryption active" status + disable button
	 * - Transitioning → show migration status message
	 *
	 * @param containerEl - The settings tab container element to append into.
	 */
	private renderEncryptionForm(containerEl: HTMLElement): void {
		if (this.savingConnection) {
			new Setting(containerEl).setDesc('Wait for the connection save to finish before changing encryption.');
			return;
		}
		const coordinator = this.plugin.getEncryptionCoordinator();
		const state = coordinator?.getState();

		// State: transitioning (migration in progress on this or another device)
		if (state?.remoteMode === 'transitioning') {
			const noteEl = containerEl.createDiv({ cls: 's3-sync-backup-warning' });
			noteEl.createEl('p', {
				text: 'Encryption state transition in progress. Sync and backup are paused until migration completes.',
			});
			return;
		}

		// State: encrypted but no key loaded (locked — other device enabled, or restart)
		if (state?.remoteMode === 'encrypted' && !state.hasKey) {
			const noteEl = containerEl.createDiv({ cls: 's3-sync-backup-warning' });
			noteEl.createEl('p', {
				text: 'Vault is encrypted. Enter your passphrase to unlock sync and backup.',
			});

			let passphraseValue = '';

			new Setting(containerEl)
				.setName('Passphrase')
				.setDesc('Enter the passphrase used to encrypt this vault')
				.addText((text) => {
					text.setPlaceholder('Enter passphrase...');
					text.inputEl.type = 'password';
					text.onChange((value) => { passphraseValue = value; });
				});

			new Setting(containerEl)
				.setName('Remember passphrase')
				.setDesc('Save passphrase locally so the vault unlocks automatically on startup')
				.addToggle((toggle) => {
					toggle.setValue(this.plugin.settings.rememberPassphrase);
					toggle.onChange(async (value) => {
						this.plugin.settings.rememberPassphrase = value;
						if (!value) {
							this.plugin.secrets.clearPassphrase();
						}
						await this.plugin.saveSettings();
					});
				});

			new Setting(containerEl)
				.addButton((button) => {
					button.setButtonText('Unlock');
					button.setCta();
					button.onClick(async () => {
						if (!passphraseValue) {
							new Notice('Please enter a passphrase');
							return;
						}

						button.setButtonText('Unlocking...');
						button.setDisabled(true);

						try {
							const success = await coordinator?.unlock(passphraseValue);
							if (success) {
								this.plugin.resumeStartupJobs();
								if (this.plugin.settings.rememberPassphrase) {
									this.plugin.secrets.setPassphrase(passphraseValue);
									await this.plugin.saveSettings();
								}
								new Notice('Vault unlocked successfully');
								this.refreshSettings();
							} else {
								new Notice('Incorrect passphrase');
							}
						} catch (error) {
							const msg = error instanceof Error ? error.message : 'Unknown error';
							new Notice(`Unlock failed: ${msg}`);
						} finally {
							button.setButtonText('Unlock');
							button.setDisabled(false);
						}
					});
				});

			return;
		}

		// State: encrypted and key loaded (fully unlocked)
		if (coordinator && state?.remoteMode === 'encrypted' && state.hasKey) {
			const noteEl = containerEl.createDiv({ cls: 's3-sync-backup-info' });
			noteEl.createEl('p', {
				text: 'End-to-end encryption is active. All files are encrypted before upload.',
			});

			new Setting(containerEl)
				.setName('Remember passphrase')
				.setDesc('Save passphrase locally so the vault unlocks automatically on startup')
				.addToggle((toggle) => {
					toggle.setValue(this.plugin.settings.rememberPassphrase);
					toggle.onChange(async (value) => {
						toggle.setValue(this.plugin.settings.rememberPassphrase);
						toggle.setDisabled(true);
						try {
							await this.updateUnlockedRememberPreference(value, coordinator);
						} catch {
							new Notice('Unable to update the remembered passphrase. Try again.');
						} finally {
							toggle.setValue(this.plugin.settings.rememberPassphrase);
							toggle.setDisabled(false);
						}
					});
				});

			new Setting(containerEl)
				.setName('Disable encryption')
				.setDesc('Re-upload all files as plaintext and remove encryption')
				.addButton((button) => {
					button.setButtonText('Disable encryption');
					button.setWarning();
					button.onClick(async () => {
						const confirmed = await this.showDisableEncryptionConfirmation();
						if (!confirmed) return;

						button.setButtonText('Disabling...');
						button.setDisabled(true);

						const result = await coordinator?.disableEncryption(
							this.plugin.getEncryptionCallbacks(),
						);

						if (result?.success) {
							this.plugin.settings.rememberPassphrase = false;
							this.plugin.secrets.clearPassphrase();
							await this.plugin.saveSettings();
							this.plugin.onSettingsChanged();
							this.refreshSettings();
						} else {
							new Notice(`Failed to disable encryption: ${result?.error ?? 'Unknown error'}`);
							button.setButtonText('Disable encryption');
							button.setDisabled(false);
						}
					});
				});

			return;
		}

		// State: plaintext (default — encryption not enabled)
		new Setting(containerEl)
			.setName('Enable end-to-end encryption')
			.setDesc('Encrypt all files before uploading to S3')
			.addToggle((toggle) => {
				toggle.setValue(false);
				toggle.onChange((value) => {
					if (value) {
						this.showEncryptionSetup = true;
						this.refreshSettings();
					}
				});
			});

		// If the user just toggled ON, show passphrase entry
		if (this.showEncryptionSetup && state?.remoteMode === 'plaintext') {
			const noteEl = containerEl.createDiv({ cls: 's3-sync-backup-warning' });
			noteEl.createEl('p', {
				text: 'This passphrase encrypts both synced files and backups. If lost, your data cannot be recovered.',
			});

			let passphraseValue = '';
			let strengthEl: HTMLElement | null = null;

			new Setting(containerEl)
				.setName('Passphrase')
				.setDesc('Enter a strong passphrase (minimum 8 characters)')
				.addText((text) => {
					text.setPlaceholder('Enter passphrase...');
					text.inputEl.type = 'password';
					text.onChange((value) => {
						passphraseValue = value;
						if (strengthEl) {
							const validation = validatePassphrase(value);
							strengthEl.textContent = value.length === 0
								? ''
								: `Strength: ${validation.strength}${validation.message ? ` — ${validation.message}` : ''}`;
							strengthEl.className = `s3-sync-passphrase-strength s3-sync-strength-${validation.strength}`;
						}
					});
				});

			strengthEl = containerEl.createDiv({ cls: 's3-sync-passphrase-strength' });

			new Setting(containerEl)
				.setName('Remember passphrase')
				.setDesc('Save passphrase locally so the vault unlocks automatically on startup')
				.addToggle((toggle) => {
					toggle.setValue(this.plugin.settings.rememberPassphrase);
					toggle.onChange(async (value) => {
						this.plugin.settings.rememberPassphrase = value;
						await this.plugin.saveSettings();
					});
				});

			new Setting(containerEl)
				.addButton((button) => {
					button.setButtonText('Enable encryption');
					button.setCta();
					button.onClick(async () => {
						const validation = validatePassphrase(passphraseValue);
						if (!validation.valid) {
							new Notice(validation.message ?? 'Invalid passphrase');
							return;
						}

						button.setButtonText('Enabling...');
						button.setDisabled(true);

						const result = await coordinator?.enableEncryption(
							passphraseValue,
							this.plugin.getEncryptionCallbacks(),
						);

						if (result?.success) {
							if (this.plugin.settings.rememberPassphrase) {
								this.plugin.secrets.setPassphrase(passphraseValue);
								await this.plugin.saveSettings();
							}
							this.showEncryptionSetup = false;
							this.plugin.onSettingsChanged();
							this.refreshSettings();
						} else {
							new Notice(`Failed to enable encryption: ${result?.error ?? 'Unknown error'}`);
							button.setButtonText('Enable encryption');
							button.setDisabled(false);
						}
					});
				});

			// Cancel button to revert the toggle
			new Setting(containerEl)
				.addButton((button) => {
					button.setButtonText('Cancel');
					button.onClick(() => {
						this.showEncryptionSetup = false;
						this.refreshSettings();
					});
				});
		}
	}

	/** Save the verified passphrase before turning on automatic unlock for an unlocked vault. */
	private async updateUnlockedRememberPreference(remember: boolean, coordinator: EncryptionCoordinator): Promise<void> {
		const passphrase = remember ? await this.promptForPassphrase() : null;
		if (remember) {
			if (!passphrase) return;
			if (!await coordinator.verifyCurrentPassphrase(passphrase)) {
				new Notice('Unable to verify the passphrase. Check the passphrase and storage connection, then try again.');
				return;
			}
		}

		const { settings, secrets } = this.plugin;
		const previousPreference = settings.rememberPassphrase;
		const previousSecret = secrets.getPassphrase();
		const nextSecret = passphrase ?? '';
		secrets.setPassphrase(nextSecret);
		if (secrets.getPassphrase() !== nextSecret) throw new Error('Obsidian could not save the passphrase');
		settings.rememberPassphrase = remember;
		try {
			await this.plugin.saveSettings();
		} catch (error) {
			settings.rememberPassphrase = previousPreference;
			secrets.setPassphrase(previousSecret);
			throw error;
		}
	}

	private promptForPassphrase(): Promise<string | null> {
		return new Promise((resolve) => { new RememberPassphraseModal(this.app, resolve).open(); });
	}

	/**
	 * Show a confirmation modal before disabling encryption.
	 *
	 * @returns true if the user confirmed, false if cancelled.
	 */
	private showDisableEncryptionConfirmation(): Promise<boolean> {
		return new Promise((resolve) => {
			const modal = new DisableEncryptionModal(this.app, resolve);
			modal.open();
		});
	}

	private showResetConfirmation(): Promise<boolean> {
		return new Promise((resolve) => {
			const modal = new ResetSettingsModal(this.app, resolve);
			modal.open();
		});
	}

	/**
	 * Show the confirmation modal for resetting the sync journal.
	 *
	 * The journal stores per-file baselines used by three-way reconciliation.
	 * Clearing it is non-destructive on its own — the very next sync simply
	 * re-uploads every file from the vault as if for the first time.
	 *
	 * @returns A Promise that resolves with `true` when the user confirms.
	 */
	private showJournalResetConfirmation(): Promise<boolean> {
		return new Promise((resolve) => {
			const modal = new ResetSyncJournalModal(this.app, resolve);
			modal.open();
		});
	}

	private openBackupListModal(): void {
		const retentionManager = this.plugin.getRetentionManager();
		const backupDownloader = this.plugin.getBackupDownloader();

		if (!retentionManager || !backupDownloader) {
			new Notice('Backup system not initialized. Check your S3 connection.');
			return;
		}

		const modal = new BackupListModal(this.app, retentionManager, backupDownloader);
		modal.open();
	}

	/**
	 * Render the Sync settings section.
	 *
	 * Always shows the "Enable sync" master toggle. When sync is enabled, additional
	 * fields are rendered conditionally: sync prefix, auto-sync toggle, sync interval
	 * (only when auto-sync is on), and sync-on-startup toggle. Toggling the master
	 * switch or auto-sync calls `this.plugin.onSettingsChanged()` to restart services
	 * with the new configuration.
	 *
	 * @param section - Shared rows for the settings section.
	 */
	private addSyncSettings(section: SettingsSection): void {
		section.add('Enable sync', 'Enable bi-directional vault synchronization', (setting) => {
			setting.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.syncEnabled);
				toggle.onChange(async (value) => {
					this.plugin.settings.syncEnabled = value;
					await this.plugin.saveSettings();
					this.plugin.onSettingsChanged();
					this.refreshSettings();
				});
			});
		});

		if (this.plugin.settings.syncEnabled) {
			// Sync Prefix
			section.add('Sync prefix', 'S3 path prefix for synced files (e.g., "vault" → s3://bucket/vault/)', (setting) => {
				setting.addText((text) => {
					text.setDisabled(this.savingConnection);
					text.setPlaceholder('Sync prefix');
					text.setValue(this.plugin.settings.syncPrefix);
					text.onChange(async (value) => {
						if (this.savingConnection) return;
						this.plugin.settings.syncPrefix = normalizePrefix(value) || 'vault';
						await this.plugin.saveSettings();
					});
				});
			});

			// Auto-sync toggle
			section.add('Auto-sync', 'Automatically sync at regular intervals', (setting) => {
				setting.addToggle((toggle) => {
					toggle.setValue(this.plugin.settings.autoSyncEnabled);
					toggle.onChange(async (value) => {
						this.plugin.settings.autoSyncEnabled = value;
						await this.plugin.saveSettings();
						this.plugin.onSettingsChanged();
						this.refreshSettings();
					});
				});
			});

			// Sync interval (only shown if auto-sync enabled)
			if (this.plugin.settings.autoSyncEnabled) {
				section.add('Sync interval', 'How often to automatically sync', (setting) => {
					setting.addDropdown((dropdown) => {
						for (const [value, name] of Object.entries(SYNC_INTERVAL_NAMES)) {
							dropdown.addOption(value, name);
						}
						dropdown.setValue(String(this.plugin.settings.syncIntervalMinutes));
						dropdown.onChange(async (value) => {
							this.plugin.settings.syncIntervalMinutes = parseInt(value) as SyncIntervalMinutes;
							await this.plugin.saveSettings();
							this.plugin.onSettingsChanged();
						});
					});
				});
			}

			// Sync on startup
			section.add('Sync on startup', 'Run a sync when the app starts', (setting) => {
				setting.addToggle((toggle) => {
					toggle.setValue(this.plugin.settings.syncOnStartup);
					toggle.onChange(async (value) => {
						this.plugin.settings.syncOnStartup = value;
						await this.plugin.saveSettings();
					});
				});
			});
		}
	}

	/**
	 * Render the Backup settings section.
	 *
	 * Always shows the "Enable backups" master toggle. When enabled, renders backup
	 * prefix, interval, retention policy sub-section (mode + days/copies depending on
	 * mode), and a "Backup now" button. Toggling backup or changing the interval calls
	 * `this.plugin.onSettingsChanged()` to restart the backup scheduler.
	 *
	 * @param section - Shared rows for the settings section.
	 */
	private addBackupSettings(section: SettingsSection): void {
		section.add('Enable backups', 'Create scheduled backup snapshots of your vault', (setting) => {
			setting.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.backupEnabled);
				toggle.onChange(async (value) => {
					this.plugin.settings.backupEnabled = value;
					await this.plugin.saveSettings();
					this.plugin.onSettingsChanged();
					this.refreshSettings();
				});
			});
		});

		if (this.plugin.settings.backupEnabled) {
			// Backup Prefix
			section.add('Backup prefix', 'S3 path prefix for backups (e.g., "backups" → s3://bucket/backups/)', (setting) => {
				setting.addText((text) => {
					text.setPlaceholder('Backup prefix');
					text.setValue(this.plugin.settings.backupPrefix);
					text.onChange(async (value) => {
						this.plugin.settings.backupPrefix = normalizePrefix(value) || 'backups';
						await this.plugin.saveSettings();
					});
				});
			});

			// Backup interval
			section.add('Backup interval', 'How often to create backup snapshots', (setting) => {
				setting.addDropdown((dropdown) => {
					for (const [value, name] of Object.entries(BACKUP_INTERVAL_NAMES)) {
						dropdown.addOption(value, name);
					}
					dropdown.setValue(this.plugin.settings.backupInterval);
					dropdown.onChange(async (value) => {
						this.plugin.settings.backupInterval = value as BackupInterval;
						await this.plugin.saveSettings();
						this.plugin.onSettingsChanged();
					});
				});
			});

			// Retention settings header
			section.addHeading('Retention policy');

			section.add('Enable retention', 'Automatically delete old backups', (setting) => {
				setting.addToggle((toggle) => {
					toggle.setValue(this.plugin.settings.retentionEnabled);
					toggle.onChange(async (value) => {
						this.plugin.settings.retentionEnabled = value;
						await this.plugin.saveSettings();
						this.refreshSettings();
					});
				});
			});

			if (this.plugin.settings.retentionEnabled) {
				// Retention mode
				section.add('Retention mode', 'How to determine which backups to keep', (setting) => {
					setting.addDropdown((dropdown) => {
						dropdown.addOption('days', 'By days');
						dropdown.addOption('copies', 'By copies');
						dropdown.setValue(this.plugin.settings.retentionMode);
						dropdown.onChange(async (value) => {
							this.plugin.settings.retentionMode = value as RetentionMode;
							await this.plugin.saveSettings();
							this.refreshSettings();
						});
					});
				});

				if (this.plugin.settings.retentionMode === 'days') {
					section.add('Retention days', 'Delete backups older than this many days (1-360)', (setting) => {
						setting.addText((text) => {
							text.setPlaceholder('30');
							text.setValue(String(this.plugin.settings.retentionDays));
							text.onChange(async (value) => {
								const days = parseInt(value) || 30;
								this.plugin.settings.retentionDays = Math.max(1, Math.min(360, days));
								await this.plugin.saveSettings();
							});
						});
					});
				} else {
					section.add('Retention copies', 'Keep only the latest n backups (1-1000)', (setting) => {
						setting.addText((text) => {
							text.setPlaceholder('30');
							text.setValue(String(this.plugin.settings.retentionCopies));
							text.onChange(async (value) => {
								const copies = parseInt(value) || 30;
								this.plugin.settings.retentionCopies = Math.max(1, Math.min(1000, copies));
								await this.plugin.saveSettings();
							});
						});
					});
				}
			}

			// Backup Now button
			section.add('Manual backup', 'Create a backup snapshot now', (setting) => {
				setting.addButton((button) => {
					button.setButtonText('Backup now');
					button.onClick(async () => {
						await this.plugin.triggerManualBackup();
					});
				});
			});

			// View Backups button
			section.add('View backups', 'View and download recent backup snapshots', (setting) => {
				setting.addButton((button) => {
					button.setButtonText('View backups');
					button.onClick(() => {
						this.openBackupListModal();
					});
				});
			});
		}
	}

	/**
	 * Render the Advanced settings section.
	 *
	 * Renders debug logging toggle, exclude patterns textarea, and a "Reset to defaults"
	 * button. Exclusions are comma-separated vault-relative paths or globs.
	 *
	 * @param section - Shared rows for the settings section.
	 */
	private addAdvancedSettings(section: SettingsSection): void {
		// Debug logging
		section.add('Debug logging', 'Enable verbose logging for troubleshooting', (setting) => {
			setting.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.debugLogging);
				toggle.onChange(async (value) => {
					this.plugin.settings.debugLogging = value;
					await this.plugin.saveSettings();
				});
			});
		});

		// Exclude patterns
		section.add('Exclude patterns', 'Exclude files from sync and backup using comma-separated vault-relative paths or globs', (setting) => {
			setting.addTextArea((text) => {
				text.setValue(this.plugin.settings.excludePatterns.join(', '));
				text.onChange(async (value) => {
					this.plugin.settings.excludePatterns = value
						.split(',')
						.map((p) => p.trim())
						.filter((p) => p.length > 0);
					await this.plugin.saveSettings();
				});
			});
		});

		// Reset sync journal
		section.add(
			'Reset sync journal',
			'Discard per-file sync baselines for this vault.  Use when sync has been blocked ' +
				'because the configured destination is unfamiliar, or to force a fresh full upload.',
			(setting) => {
				setting.addButton((button) => {
					button.setButtonText('Reset journal');
					button.setWarning();
					button.onClick(async () => {
						const confirmed = await this.showJournalResetConfirmation();
						if (!confirmed) return;

						const journal = this.plugin.getSyncJournal();
						if (!journal) {
							new Notice('Sync system not initialised yet — try again in a moment.');
							return;
						}

						await journal.clear();
						new Notice('Sync journal reset — the next sync will re-upload every file.');
					});
				});
			},
		);

		// Reset to defaults
		section.add('Reset to defaults', 'Reset all settings except S3 credentials to their default values', (setting) => {
			setting.addButton((button) => {
				button.setButtonText('Reset');
				button.setDisabled(this.savingConnection);
				button.setWarning();
				button.onClick(async () => {
					const confirmed = await this.showResetConfirmation();
					if (!confirmed || this.savingConnection) return;

					const { provider, endpoint, region, bucket, accessKeyIdSecret, secretAccessKeySecret, forcePathStyle } =
						this.plugin.settings;

					Object.assign(this.plugin.settings, { ...DEFAULT_SETTINGS });
					Object.assign(this.plugin.settings, {
						provider, endpoint, region, bucket, accessKeyIdSecret, secretAccessKeySecret, forcePathStyle,
					});
					this.plugin.secrets.clearPassphrase();

					await this.plugin.saveSettings();
					this.plugin.onSettingsChanged();
					this.refreshSettings();
					new Notice('Settings reset to defaults (credentials preserved)');
				});
			});
		});
	}
}

/** Request the current vault passphrase for saving in Obsidian's Keychain. */
class RememberPassphraseModal extends Modal {
	constructor(app: App, private readonly resolve: (passphrase: string | null) => void) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h2', { text: 'Remember passphrase' });
		contentEl.createEl('p', { text: 'Enter your vault passphrase to unlock automatically on startup.' });

		const form = contentEl.createEl('form');
		const label = form.createEl('label', { text: 'Vault passphrase' });
		const input = label.createEl('input', {
			attr: { type: 'password', autocomplete: 'off', required: '' },
		});
		const buttons = form.createDiv({ cls: 'modal-button-container' });
		buttons.createEl('button', { text: 'Cancel', attr: { type: 'button' } })
			.addEventListener('click', () => { this.close(); });
		buttons.createEl('button', {
			text: 'Remember passphrase',
			cls: 'mod-cta',
			attr: { type: 'submit' },
		});
		form.addEventListener('submit', (event) => {
			event.preventDefault();
			if (!input.value) return;
			this.resolve(input.value);
			this.close();
		});
		input.focus();
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolve(null);
	}
}

/**
 * Confirmation modal shown when the user requests to disable encryption.
 *
 * Warns that all vault files will be re-uploaded to S3 as plaintext and that
 * the operation cannot be interrupted once started. Resolves a Promise with
 * `true` when the user clicks "Disable encryption", or `false` on cancel /
 * close.
 */
class DisableEncryptionModal extends Modal {
	private resolve: (value: boolean) => void;

	constructor(app: App, resolve: (value: boolean) => void) {
		super(app);
		this.resolve = resolve;
	}

	onOpen(): void {
		const { contentEl } = this;

		contentEl.createEl('h2', { text: 'Disable encryption?' });

		contentEl.createEl('p', {
			text:
				'This will re-upload every file in your vault to S3 as plaintext. ' +
				'The operation may take several minutes depending on vault size.',
		});

		contentEl.createEl('p', {
			text:
				'Other devices syncing this vault will detect the change and ' +
				'switch to plaintext mode automatically on their next sync.',
			cls: 'mod-warning',
		});

		const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

		buttonContainer
			.createEl('button', { text: 'Cancel' })
			.addEventListener('click', () => {
				this.resolve(false);
				this.close();
			});

		const confirmBtn = buttonContainer.createEl('button', {
			text: 'Disable encryption',
			cls: 'mod-warning',
		});
		confirmBtn.addEventListener('click', () => {
			this.resolve(true);
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolve(false);
	}
}

/**
 * Confirmation modal shown when the user requests to reset the sync journal.
 *
 * Clearing the journal removes every per-file baseline (mtime, size, fingerprint,
 * etag) so the next sync treats every vault file as new and re-uploads it.  No
 * S3 objects or local files are deleted by this action.  Resolves the Promise
 * with `true` on confirm, `false` on cancel or close.
 */
class ResetSyncJournalModal extends Modal {
	private resolve: (value: boolean) => void;

	constructor(app: App, resolve: (value: boolean) => void) {
		super(app);
		this.resolve = resolve;
	}

	onOpen(): void {
		const { contentEl } = this;

		contentEl.createEl('h2', { text: 'Reset sync journal?' });

		contentEl.createEl('p', {
			text:
				'This clears per-file sync baselines stored locally for this vault.  ' +
				'The next sync will treat every file as new and re-upload it to S3.  ' +
				'No vault files or S3 objects are deleted by this action.',
		});

		const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

		buttonContainer
			.createEl('button', { text: 'Cancel' })
			.addEventListener('click', () => {
				this.resolve(false);
				this.close();
			});

		const confirmBtn = buttonContainer.createEl('button', {
			text: 'Reset journal',
			cls: 'mod-warning',
		});
		confirmBtn.addEventListener('click', () => {
			this.resolve(true);
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolve(false);
	}
}

class ResetSettingsModal extends Modal {
	private resolve: (value: boolean) => void;

	constructor(app: App, resolve: (value: boolean) => void) {
		super(app);
		this.resolve = resolve;
	}

	onOpen(): void {
		const { contentEl } = this;

		contentEl.createEl('h2', { text: 'Reset settings?' });

		contentEl.createEl('p', {
			text:
				'This will reset all settings to their default values. ' +
				'Your S3 connection credentials will be preserved.',
		});

		const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });

		buttonContainer
			.createEl('button', { text: 'Cancel' })
			.addEventListener('click', () => {
				this.resolve(false);
				this.close();
			});

		const confirmBtn = buttonContainer.createEl('button', {
			text: 'Reset settings',
			cls: 'mod-warning',
		});
		confirmBtn.addEventListener('click', () => {
			this.resolve(true);
			this.close();
		});
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolve(false);
	}
}
