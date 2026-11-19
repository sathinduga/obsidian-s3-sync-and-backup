/** Tests the shared settings rows through the modern definition and legacy display APIs. */
import { App, requireApiVersion, Setting, type SettingDefinitionRender } from 'obsidian';
import type S3SyncBackupPlugin from '../src/main';
import { S3SyncBackupSettingTab } from '../src/settings';
import { DEFAULT_SETTINGS } from '../src/types';

jest.mock('obsidian', () => ({
	...jest.requireActual('obsidian'),
	PluginSettingTab: class {},
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
		onChange: jest.fn<void, [(value: string | boolean) => void | Promise<void>]>(),
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
	const plugin = {
		settings,
		saveSettings: jest.fn().mockResolvedValue(undefined),
		onSettingsChanged: jest.fn(),
		resumeStartupJobs: jest.fn(),
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

/** Search metadata and both renderers must share the settings and their lifecycle callbacks. */
describe('S3 Sync + Backup settings', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		jest.mocked(Setting).mockImplementation(() => mockSetting().setting as unknown as Setting);
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
