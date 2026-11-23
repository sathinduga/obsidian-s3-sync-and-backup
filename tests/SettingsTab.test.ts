/** Tests the shared settings rows through the modern definition and legacy display APIs. */
import { App, requireApiVersion, SecretComponent, Setting, type SettingDefinitionRender } from 'obsidian';
import type S3SyncBackupPlugin from '../src/main';
import { S3SyncBackupSettingTab } from '../src/settings';
import { DEFAULT_SETTINGS } from '../src/types';

jest.mock('obsidian', () => ({
	...jest.requireActual('obsidian'),
	PluginSettingTab: class { hide() {} },
	requireApiVersion: jest.fn(),
	SecretComponent: jest.fn(),
	Setting: jest.fn(),
}));

/** Capture the callbacks wired to Obsidian's components without simulating CSS or Obsidian search. */
function mockSetting() {
	const control = {
		inputEl: { type: 'text' },
		setValue: jest.fn().mockReturnThis(),
		setPlaceholder: jest.fn().mockReturnThis(),
		setButtonText: jest.fn().mockReturnThis(),
		setCta: jest.fn().mockReturnThis(),
		setWarning: jest.fn().mockReturnThis(),
		setDisabled: jest.fn().mockReturnThis(),
		addOption: jest.fn().mockReturnThis(),
		buttonEl: { textContent: '', disabled: false, isConnected: true },
		onChange: jest.fn<void, [(value: string | boolean | null) => void | Promise<void>]>(),
		onClick: jest.fn<void, [() => void | Promise<void>]>(),
	};
	const setting = {
		setName: jest.fn().mockReturnThis(),
		setDesc: jest.fn().mockReturnThis(),
		setHeading: jest.fn().mockReturnThis(),
		setClass: jest.fn().mockReturnThis(),
		settingEl: {
			empty: jest.fn(),
			createEl: jest.fn(() => ({ createEl: jest.fn() })),
			createDiv: jest.fn(() => ({ createEl: jest.fn() })),
		},
		addToggle: jest.fn(),
		addText: jest.fn(),
		addDropdown: jest.fn(),
		addButton: jest.fn(),
		addTextArea: jest.fn(),
		addComponent: jest.fn(),
	};
	for (const add of [setting.addToggle, setting.addText, setting.addDropdown, setting.addButton, setting.addTextArea]) {
		add.mockImplementation((configure: (component: typeof control) => void) => {
			configure(control);
			return setting;
		});
	}
	setting.addComponent.mockImplementation((create: (element: HTMLElement) => unknown) => {
		create({} as HTMLElement);
		return setting;
	});
	return { setting, control };
}

function createTab() {
	const settings = {
		...DEFAULT_SETTINGS,
		provider: 'aws' as const,
		accessKeyIdSecret: 'existing-access-key',
		secretAccessKeySecret: 'existing-secret-key',
		syncEnabled: false,
		backupEnabled: true,
		retentionEnabled: true,
		retentionMode: 'copies' as const,
	};
	let savedPassphrase = '';
	const plugin = {
		settings,
		saveSettings: jest.fn().mockResolvedValue(undefined),
		saveConnection: jest.fn(),
		testConnection: jest.fn().mockResolvedValue('Connected'),
		onSettingsChanged: jest.fn(),
		resumeStartupJobs: jest.fn(),
		secrets: {
			getPassphrase: jest.fn(() => savedPassphrase),
			setPassphrase: jest.fn((value: string) => { savedPassphrase = value; }),
		},
		getEncryptionCoordinator: jest.fn(),
	};
	const tab = new S3SyncBackupSettingTab(new App(), plugin as unknown as S3SyncBackupPlugin);
	const update = jest.fn();
	Object.assign(tab, { update, containerEl: { empty: jest.fn(), addClass: jest.fn() } });
	return { tab, plugin, update };
}

function modernRows(tab: S3SyncBackupSettingTab) {
	return tab.getSettingDefinitions().flatMap((group) => group.items ?? [])
		.filter((row): row is SettingDefinitionRender => 'render' in row && typeof row.render === 'function');
}

function renderRow(tab: S3SyncBackupSettingTab, name: string) {
	const row = modernRows(tab).find((item) => item.name === name);
	if (!row) throw new Error(`Missing settings row: ${name}`);
	const { setting, control } = mockSetting();
	row.render(setting as unknown as Setting, {} as Parameters<typeof row.render>[1]);
	return control;
}

/** Search metadata and both renderers must share the settings and their lifecycle callbacks. */
describe('S3 Sync + Backup settings', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		jest.mocked(Setting).mockImplementation(() => mockSetting().setting as unknown as Setting);
		jest.mocked(SecretComponent).mockImplementation(() => mockSetting().control as unknown as SecretComponent);
	});

	it('indexes only available rows and leaves credentials and persisted settings alone', () => {
		const { tab, plugin } = createTab();
		const rows = modernRows(tab);
		expect(rows.map((row) => row.name)).toEqual(expect.arrayContaining([
			'Access key ID', 'Secret access key', 'Enable sync', 'Retention copies', 'Exclude patterns',
		]));
		expect(rows.map((row) => row.name)).not.toContain('Sync on startup');
		expect(rows.map((row) => row.name)).not.toContain('Endpoint URL');
		expect(rows.map((row) => row.name)).not.toContain('Retention days');
		expect(rows.find((row) => row.name === 'End-to-end encryption')?.aliases).toContain('Remember passphrase');
		expect(JSON.stringify(rows)).not.toContain(plugin.settings.accessKeyIdSecret);
		expect(JSON.stringify(rows)).not.toContain(plugin.settings.secretAccessKeySecret);
		expect(Setting).not.toHaveBeenCalled();
		expect(plugin.saveSettings).not.toHaveBeenCalled();
	});

	it('restores the saved AWS connection after previewing Cloudflare without saving', async () => {
		jest.mocked(requireApiVersion).mockReturnValue(true);
		const { tab, plugin } = createTab();
		plugin.settings.region = 'eu-west-2';
		plugin.settings.bucket = 'existing-aws-bucket';
		const saved = { ...plugin.settings };

		await renderRow(tab, 'Provider').onChange.mock.calls[0]![0]('r2');
		expect(renderRow(tab, 'Region').setValue).toHaveBeenCalledWith('auto');
		expect(renderRow(tab, 'Bucket').setValue).toHaveBeenCalledWith('');
		expect(plugin.settings).toEqual(saved);

		await renderRow(tab, 'Provider').onChange.mock.calls[0]![0]('aws');
		expect(renderRow(tab, 'Region').setValue).toHaveBeenCalledWith('eu-west-2');
		expect(renderRow(tab, 'Bucket').setValue).toHaveBeenCalledWith('existing-aws-bucket');
		expect(plugin.settings).toEqual(saved);
		expect(plugin.saveSettings).not.toHaveBeenCalled();
	});

	it('keeps connection edits in the form until save and retains the draft after a failed save', async () => {
		const { tab, plugin } = createTab();
		plugin.saveConnection.mockRejectedValueOnce(new Error('Could not write settings'))
			.mockImplementation((connection: object) => Object.assign(plugin.settings, connection));
		const saved = { ...plugin.settings };

		await renderRow(tab, 'Provider').onChange.mock.calls[0]![0]('custom');
		await renderRow(tab, 'Endpoint URL').onChange.mock.calls[0]![0]('https://storage.example.com');
		await renderRow(tab, 'Region').onChange.mock.calls[0]![0]('custom-region');
		await renderRow(tab, 'Bucket').onChange.mock.calls[0]![0]('test-bucket');
		await renderRow(tab, 'Force path style').onChange.mock.calls[0]![0](true);
		expect(plugin.settings).toEqual(saved);
		expect(plugin.saveSettings).not.toHaveBeenCalled();

		const save = () => renderRow(tab, 'Connection changes').onClick.mock.calls[0]![0]();
		await save();
		expect(plugin.settings).toEqual(saved);
		expect(renderRow(tab, 'Region').setValue).toHaveBeenCalledWith('custom-region');
		await save();
		expect(plugin.settings).toEqual({
			...saved,
			provider: 'custom', endpoint: 'https://storage.example.com', region: 'custom-region', bucket: 'test-bucket',
			accessKeyIdSecret: '', secretAccessKeySecret: '', forcePathStyle: true,
		});
	});

	it('derives a Backblaze region as the endpoint changes until the user enters a manual override', async () => {
		const { tab } = createTab();
		const change = async (row: string, value: string) => renderRow(tab, row).onChange.mock.calls[0]![0](value);
		await change('Provider', 'b2');
		expect(renderRow(tab, 'Region').setValue).toHaveBeenCalledWith('');
		await change('Endpoint URL', 'https://s3.us-west-004.backblazeb2.com');
		expect(renderRow(tab, 'Region').setValue).toHaveBeenCalledWith('us-west-004');
		await change('Endpoint URL', 'https://s3.eu-central-003.backblazeb2.com.example.com');
		expect(renderRow(tab, 'Region').setValue).toHaveBeenCalledWith('');
		await change('Endpoint URL', 'https://s3.eu-central-003.backblazeb2.com');
		expect(renderRow(tab, 'Region').setValue).toHaveBeenCalledWith('eu-central-003');
		await change('Region', 'us-west-004');
		await change('Endpoint URL', 'https://s3.us-east-005.backblazeb2.com');
		expect(renderRow(tab, 'Region').setValue).toHaveBeenCalledWith('us-west-004');
	});

	it('tests unsaved settings without sending saved credentials to another provider', async () => {
		const { tab, plugin } = createTab();
		await renderRow(tab, 'Provider').onChange.mock.calls[0]![0]('r2');
		await renderRow(tab, 'Endpoint URL').onChange.mock.calls[0]![0]('https://test.r2.cloudflarestorage.com');
		await renderRow(tab, 'Test connection').onClick.mock.calls[0]![0]();
		expect(plugin.testConnection).toHaveBeenCalledWith({
			provider: 'r2', endpoint: 'https://test.r2.cloudflarestorage.com', region: 'auto', bucket: '',
			accessKeyIdSecret: '', secretAccessKeySecret: '', forcePathStyle: false,
		});
		expect(plugin.saveConnection).not.toHaveBeenCalled();
		expect(plugin.settings.provider).toBe('aws');
	});

	it('leaves saved SecretStorage references in place when a draft selection is cleared or discarded', async () => {
		const { tab, plugin } = createTab();
		const selected = mockSetting().control;
		jest.mocked(SecretComponent).mockReturnValueOnce(selected as unknown as SecretComponent);
		renderRow(tab, 'Access key ID');
		expect(selected.setValue).toHaveBeenCalledWith('existing-access-key');
		await selected.onChange.mock.calls[0]![0](null);
		await renderRow(tab, 'Test connection').onClick.mock.calls[0]![0]();
		expect(plugin.testConnection).toHaveBeenCalledWith(expect.objectContaining({ accessKeyIdSecret: '' }));
		expect(plugin.settings.accessKeyIdSecret).toBe('existing-access-key');
		await renderRow(tab, 'Connection changes').onClick.mock.calls[1]![0]();

		const restored = mockSetting().control;
		jest.mocked(SecretComponent).mockReturnValueOnce(restored as unknown as SecretComponent);
		renderRow(tab, 'Access key ID');
		expect(restored.setValue).toHaveBeenCalledWith('existing-access-key');
		expect(plugin.saveSettings).not.toHaveBeenCalled();
		expect(plugin.saveConnection).not.toHaveBeenCalled();
	});

	it('restores the saved connection when the settings tab closes', async () => {
		const { tab, plugin } = createTab();
		await renderRow(tab, 'Provider').onChange.mock.calls[0]![0]('rustfs');
		expect(renderRow(tab, 'Region').setValue).toHaveBeenCalledWith('us-east-1');
		await renderRow(tab, 'Endpoint URL').onChange.mock.calls[0]![0]('http://localhost:9000');
		tab.hide();
		expect(renderRow(tab, 'Provider').setValue).toHaveBeenCalledWith('aws');
		expect(modernRows(tab).some((row) => row.name === 'Endpoint URL')).toBe(false);
		expect(plugin.saveConnection).not.toHaveBeenCalled();
	});

	it.each([true, false])('saves conditional sync changes before refreshing (modern=%s)', async (modern) => {
		jest.mocked(requireApiVersion).mockReturnValue(modern);
		const { tab, plugin, update } = createTab();
		const display = jest.spyOn(tab, 'display');
		const control = mockSetting();
		const row = modernRows(tab).find(({ name }) => name === 'Enable sync');
		if (!row) throw new Error('Enable sync row missing');
		row.render(control.setting as unknown as Setting, {} as Parameters<typeof row.render>[1]);

		await control.control.onChange.mock.calls[0]![0](true);

		expect(plugin.settings.syncEnabled).toBe(true);
		expect(plugin.saveSettings).toHaveBeenCalledTimes(1);
		expect(plugin.onSettingsChanged).toHaveBeenCalledTimes(1);
		expect(plugin.saveSettings.mock.invocationCallOrder[0]).toBeLessThan(plugin.onSettingsChanged.mock.invocationCallOrder[0]!);
		expect(update).toHaveBeenCalledTimes(modern ? 1 : 0);
		expect(display).toHaveBeenCalledTimes(modern ? 0 : 1);
		expect(modernRows(tab).some(({ name }) => name === 'Sync on startup')).toBe(true);
	});

	it('keeps passphrase entry and unlock together when opened from search', async () => {
		jest.mocked(requireApiVersion).mockReturnValue(true);
		const { tab, plugin, update } = createTab();
		const unlock = jest.fn().mockResolvedValue(true);
		plugin.getEncryptionCoordinator.mockReturnValue({
			getState: () => ({ remoteMode: 'encrypted', hasKey: false }),
			unlock,
		});
		const form = modernRows(tab).find(({ name }) => name === 'End-to-end encryption');
		if (!form) throw new Error('Encryption form missing');
		const controls = [mockSetting(), mockSetting(), mockSetting()];
		for (const { setting } of controls) {
			jest.mocked(Setting).mockImplementationOnce(() => setting as unknown as Setting);
		}
		form.render(mockSetting().setting as unknown as Setting, {} as Parameters<typeof form.render>[1]);

		const [passphrase, remember, unlockButton] = controls.map(({ control }) => control);
		expect(passphrase!.inputEl.type).toBe('password');
		expect(remember!.setValue).toHaveBeenCalledWith(false);
		await passphrase!.onChange.mock.calls[0]![0]('synthetic test passphrase');
		await unlockButton!.onClick.mock.calls[0]![0]();

		expect(unlock).toHaveBeenCalledWith('synthetic test passphrase');
		expect(plugin.resumeStartupJobs).toHaveBeenCalledTimes(1);
		expect(plugin.saveSettings).not.toHaveBeenCalled();
		expect(update).toHaveBeenCalledTimes(1);
	});

	it.each([
		{ reason: 'verified', input: 'synthetic verified passphrase', valid: true, fail: null },
		{ reason: 'incorrect', input: 'synthetic incorrect passphrase', valid: false, fail: null },
		{ reason: 'cancelled', input: null, valid: false, fail: null },
		{ reason: 'Keychain write failed', input: 'synthetic verified passphrase', valid: true, fail: 'keychain' },
		{ reason: 'settings save failed', input: 'synthetic verified passphrase', valid: true, fail: 'settings' },
	])('only enables remember after unlocking with a verified and saved passphrase ($reason)',
		async ({ input, valid, fail }) => {
			const { tab, plugin } = createTab();
			const promptForPassphrase = jest.fn().mockResolvedValue(input);
			Object.assign(tab, { promptForPassphrase });
			const verifyCurrentPassphrase = jest.fn().mockResolvedValue(valid);
			plugin.getEncryptionCoordinator.mockReturnValue({
				getState: () => ({ remoteMode: 'encrypted', hasKey: true }),
				verifyCurrentPassphrase,
			});
			if (fail === 'keychain') plugin.secrets.setPassphrase.mockImplementationOnce(() => {});
			if (fail === 'settings') plugin.saveSettings.mockRejectedValueOnce(new Error('Write failed'));

			const form = modernRows(tab).find(({ name }) => name === 'End-to-end encryption');
			if (!form) throw new Error('Encryption form missing');
			const { control, setting } = mockSetting();
			jest.mocked(Setting).mockImplementationOnce(() => setting as unknown as Setting);
			form.render(mockSetting().setting as unknown as Setting, {} as Parameters<typeof form.render>[1]);

			await control.onChange.mock.calls[0]![0](true);

			const remembered = valid && !fail;
			expect(promptForPassphrase).toHaveBeenCalledTimes(1);
			expect(verifyCurrentPassphrase).toHaveBeenCalledTimes(input === null ? 0 : 1);
			expect(plugin.secrets.getPassphrase()).toBe(remembered ? input : '');
			expect(plugin.settings.rememberPassphrase).toBe(remembered);
			expect(control.setValue).toHaveBeenLastCalledWith(remembered);
			expect(plugin.saveSettings).toHaveBeenCalledTimes(valid && fail !== 'keychain' ? 1 : 0);
			if (remembered) {
				expect(plugin.secrets.setPassphrase.mock.invocationCallOrder[0]).toBeLessThan(
					plugin.saveSettings.mock.invocationCallOrder[0]!,
				);
			}
		},
	);

	it('renders the available controls with the legacy settings API', () => {
		const { tab } = createTab();
		tab.display();
		const names = jest.mocked(Setting).mock.results.flatMap(({ value }) => value.setName.mock.calls.flat());
		expect(names).toEqual(expect.arrayContaining([
			'Connection', 'Encryption', 'Sync', 'Backup', 'Advanced',
			'Enable end-to-end encryption', 'Access key ID', 'Retention copies',
		]));
		expect(names).not.toContain('Endpoint URL');
		expect(names).not.toContain('Retention days');
	});
});
