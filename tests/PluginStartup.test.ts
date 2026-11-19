/** Exercises the plugin startup callback with a delayed encryption unlock. */
import type { App, PluginManifest } from 'obsidian';
import S3SyncBackupPlugin from '../src/main';
import { BackupScheduler } from '../src/backup/BackupScheduler';
import { EncryptionCoordinator } from '../src/crypto/EncryptionCoordinator';
import { SyncJournal } from '../src/sync/SyncJournal';
import { SyncScheduler } from '../src/sync/SyncScheduler';

jest.mock('obsidian', () => ({
	...jest.requireActual('obsidian'),
	PluginSettingTab: class {},
}));
jest.mock('../src/statusbar');
jest.mock('../src/sync/SyncJournal');

async function loadPlugin(rememberPassphrase = true) {
	let layoutReady!: () => void;
	const app = {
		loadLocalStorage: () => 'test-device',
		vault: { getName: () => 'Startup test', on: jest.fn(), off: jest.fn() },
		workspace: { onLayoutReady: (callback: () => void) => { layoutReady = callback; } },
		secretStorage: { getSecret: () => 'test-passphrase' },
	};
	const plugin = new S3SyncBackupPlugin(app as unknown as App, {} as PluginManifest);
	Object.defineProperty(plugin, 'app', { value: app });
	jest.spyOn(plugin, 'loadData').mockResolvedValue({
		bucket: 'test-bucket', syncEnabled: true, syncOnStartup: true, backupEnabled: true, rememberPassphrase,
	});
	jest.spyOn(plugin, 'addRibbonIcon').mockReturnValue({} as HTMLElement);
	jest.spyOn(SyncJournal.prototype, 'initialize').mockResolvedValue(undefined);
	await plugin.onload();
	return { plugin, layoutReady };
}

/** Startup sync and catch-up backup must wait for the vault to be ready. */
describe('Encrypted plugin startup', () => {
	afterEach(() => jest.restoreAllMocks());

	it('waits for a delayed remembered-passphrase unlock before sync or backup', async () => {
		const sync = jest.spyOn(SyncScheduler.prototype, 'triggerSync').mockResolvedValue(null);
		const backup = jest.spyOn(BackupScheduler.prototype, 'start').mockResolvedValue(undefined);
		jest.spyOn(EncryptionCoordinator.prototype, 'refreshRemoteMode').mockResolvedValue(undefined);
		jest.spyOn(EncryptionCoordinator.prototype, 'getState').mockReturnValue({
			remoteMode: 'encrypted', hasKey: false, isBusy: false,
		});
		let finishUnlock!: (success: boolean) => void;
		const unlock = jest.spyOn(EncryptionCoordinator.prototype, 'unlock').mockReturnValue(
			new Promise(resolve => { finishUnlock = resolve; }),
		);
		const { plugin, layoutReady } = await loadPlugin();
		try {
			layoutReady();
			await Promise.resolve();
			expect(unlock).toHaveBeenCalledWith('test-passphrase');
			expect(sync).not.toHaveBeenCalled();
			expect(backup).not.toHaveBeenCalled();

			finishUnlock(true);
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(sync).toHaveBeenCalledTimes(1);
			expect(sync).toHaveBeenCalledWith('startup');
			expect(backup).toHaveBeenCalledTimes(1);
		} finally {
			finishUnlock(true);
			plugin.onunload();
		}
	});

	it('resumes one deferred startup sync and catch-up backup after a manual unlock', async () => {
		const sync = jest.spyOn(SyncScheduler.prototype, 'triggerSync').mockResolvedValue(null);
		const backup = jest.spyOn(BackupScheduler.prototype, 'start').mockResolvedValue(undefined);
		jest.spyOn(EncryptionCoordinator.prototype, 'refreshRemoteMode').mockResolvedValue(undefined);
		jest.spyOn(EncryptionCoordinator.prototype, 'getState').mockReturnValue({
			remoteMode: 'encrypted', hasKey: false, isBusy: false,
		});
		const blocked = jest.spyOn(EncryptionCoordinator.prototype, 'shouldBlock').mockReturnValue(true);
		const { plugin, layoutReady } = await loadPlugin(false);
		try {
			layoutReady();
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(sync).not.toHaveBeenCalled();
			expect(backup).not.toHaveBeenCalled();

			blocked.mockReturnValue(false);
			plugin.resumeStartupJobs();
			expect(sync).toHaveBeenCalledWith('startup');
			expect(backup).toHaveBeenCalledTimes(1);
			plugin.resumeStartupJobs();
			expect(sync).toHaveBeenCalledTimes(1);
		} finally {
			plugin.onunload();
		}
	});
});
