/** Exercises plugin startup and backup orchestration across module boundaries. */
import { Notice, requestUrl, type App, type PluginManifest, type RequestUrlResponse } from 'obsidian';
import JSZip from 'jszip';
import S3SyncBackupPlugin from '../src/main';
import { BackupScheduler } from '../src/backup/BackupScheduler';
import { RetentionManager } from '../src/backup/RetentionManager';
import { SnapshotCreator } from '../src/backup/SnapshotCreator';
import { EncryptionCoordinator } from '../src/crypto/EncryptionCoordinator';
import { encrypt } from '../src/crypto/FileEncryptor';
import { VaultMarker } from '../src/crypto/VaultMarker';
import { SyncJournal } from '../src/sync/SyncJournal';
import { SyncScheduler } from '../src/sync/SyncScheduler';
import type { S3ConnectionSettings, S3SyncBackupSettings } from '../src/types';

jest.mock('obsidian', () => ({
	...jest.requireActual('obsidian'),
	Notice: jest.fn(),
	requestUrl: jest.fn(),
	PluginSettingTab: class {},
}));
jest.mock('../src/statusbar');
jest.mock('../src/sync/SyncJournal');

async function loadPlugin(rememberPassphrase = true, settings: Partial<S3SyncBackupSettings> = {}) {
	let layoutReady!: () => void;
	const app = {
		loadLocalStorage: () => 'test-device',
		vault: { getName: () => 'Startup test', on: jest.fn(), off: jest.fn() },
		workspace: { onLayoutReady: (callback: () => void) => { layoutReady = callback; } },
		secretStorage: { getSecret: (id: string) => id === 's3-sync-passphrase' ? 'test-passphrase' : `synthetic-${id}` },
	};
	const plugin = new S3SyncBackupPlugin(app as unknown as App, {} as PluginManifest);
	Object.defineProperty(plugin, 'app', { value: app });
	jest.spyOn(plugin, 'loadData').mockResolvedValue({
		bucket: 'test-bucket', syncEnabled: true, syncOnStartup: true, backupEnabled: true, rememberPassphrase,
		...settings,
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

const savedConnection = {
	provider: 'aws', endpoint: '', region: 'eu-west-2', bucket: 'aws-test-bucket',
	accessKeyIdSecret: 'aws-id', secretAccessKeySecret: 'aws-key', forcePathStyle: false,
} satisfies S3ConnectionSettings;

const newConnection = {
	provider: 'r2', endpoint: 'https://test.r2.cloudflarestorage.com', region: 'auto', bucket: 'r2-test-bucket',
	accessKeyIdSecret: 'r2-id', secretAccessKeySecret: 'r2-key', forcePathStyle: false,
} satisfies S3ConnectionSettings;

/** Test and save are separate actions at the plugin boundary. */
describe('Connection activation', () => {
	afterEach(() => jest.restoreAllMocks());

	it('routes a draft test to its own endpoint with its own signed credentials', async () => {
		const { plugin } = await loadPlugin(false, savedConnection);
		const save = jest.spyOn(plugin, 'saveData');
		jest.mocked(requestUrl).mockResolvedValue({ status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0), json: null, text: '' });
		try {
			await expect(plugin.testConnection(newConnection)).resolves.toContain('r2-test-bucket');
			const draftRequest = jest.mocked(requestUrl).mock.lastCall?.[0];
			expect(draftRequest).toEqual(expect.objectContaining({
				method: 'HEAD', url: 'https://test.r2.cloudflarestorage.com/r2-test-bucket/',
				headers: expect.objectContaining({ authorization: expect.stringContaining('Credential=synthetic-r2-id/') }),
			}));
			await expect(plugin.testConnection()).resolves.toContain('aws-test-bucket');
			expect(jest.mocked(requestUrl).mock.lastCall?.[0]).toEqual(expect.objectContaining({
				url: 'https://aws-test-bucket.s3.eu-west-2.amazonaws.com/',
				headers: expect.objectContaining({ authorization: expect.stringContaining('Credential=synthetic-aws-id/') }),
			}));
			expect(save).not.toHaveBeenCalled();
		} finally {
			plugin.onunload();
		}
	});

	it('lets a backup finish against the saved destination before applying a replacement', async () => {
		jest.spyOn(SyncScheduler.prototype, 'triggerSync').mockResolvedValue(null);
		jest.spyOn(BackupScheduler.prototype, 'start').mockResolvedValue(undefined);
		const markerCheck = jest.spyOn(EncryptionCoordinator.prototype, 'refreshRemoteMode').mockResolvedValue(undefined);
		const { plugin, layoutReady } = await loadPlugin(false, savedConnection);
		const saveData = jest.spyOn(plugin, 'saveData');
		layoutReady();
		await new Promise<void>(resolve => setImmediate(resolve));

		let finishBackup!: (result: Awaited<ReturnType<SnapshotCreator['createSnapshot']>>) => void;
		jest.spyOn(SnapshotCreator.prototype, 'createSnapshot').mockReturnValue(new Promise(resolve => { finishBackup = resolve; }));
		const backup = plugin.triggerManualBackup();
		try {
			const save = plugin.saveConnection(newConnection);
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(plugin.settings).toMatchObject(savedConnection);
			expect(saveData).not.toHaveBeenCalled();

			finishBackup({ success: true, backupName: 'snapshot', filesBackedUp: 1, totalSize: 10, startedAt: 1, completedAt: 2, errors: [] });
			await backup;
			await save;
			expect(saveData).toHaveBeenLastCalledWith(expect.objectContaining({
				...newConnection, 'obsidian-s3-sync-last-backup': expect.any(Number),
			}));
			expect(plugin.settings).toMatchObject(newConnection);
			expect(markerCheck).toHaveBeenCalledTimes(2);
		} finally {
			finishBackup({ success: false, backupName: 'snapshot', filesBackedUp: 0, totalSize: 0, startedAt: 1, completedAt: 2, errors: [] });
			await backup;
			plugin.onunload();
		}
	});

	it('finishes decrypting a ZIP from the saved destination before activating the new connection', async () => {
		jest.spyOn(EncryptionCoordinator.prototype, 'refreshRemoteMode').mockResolvedValue(undefined);
		const key = new Uint8Array(32).fill(7);
		jest.spyOn(VaultMarker.prototype, 'verify').mockResolvedValue(key);
		const { plugin, layoutReady } = await loadPlugin(false, { ...savedConnection, syncEnabled: false, backupEnabled: false });
		const prefix = 'backups/backup-test/';
		const response = (data: Uint8Array): RequestUrlResponse => ({
			status: 200, headers: {}, arrayBuffer: new Uint8Array(data).buffer, json: null, text: '',
		});
		const plaintext = new TextEncoder().encode('From the saved connection');
		let releaseFile!: () => void;
		const filePaused = new Promise<void>((resolve) => { releaseFile = resolve; });
		let startFile!: () => void;
		const fileStarted = new Promise<void>((resolve) => { startFile = resolve; });
		jest.mocked(requestUrl).mockClear().mockImplementation(async (input) => {
			const { hostname, pathname, searchParams } = new URL(typeof input === 'string' ? input : input.url);
			expect(hostname).toBe('aws-test-bucket.s3.eu-west-2.amazonaws.com');
			if (searchParams.has('list-type')) {
				return response(new TextEncoder().encode(`<ListBucketResult><Contents><Key>${prefix}Note.md</Key><Size>32</Size></Contents></ListBucketResult>`));
			}
			if (pathname.endsWith('/Note.md')) {
				startFile();
				await filePaused;
				return response(encrypt(plaintext, key));
			}
			return response(new TextEncoder().encode('{"encrypted":true}'));
		});
		const operations: Promise<unknown>[] = [];
		const save = jest.spyOn(plugin, 'saveData');
		try {
			layoutReady();
			await new Promise<void>((resolve) => setImmediate(resolve));
			await expect(plugin.getEncryptionCoordinator()?.unlock('fixture passphrase')).resolves.toBe(true);
			const downloader = plugin.getBackupDownloader();
			if (!downloader) throw new Error('Missing backup downloader');
			const exporting = downloader.createDownloadBlob('backup-test');
			operations.push(exporting);
			await Promise.race([fileStarted, exporting]);
			const applying = plugin.saveConnection(newConnection);
			operations.push(applying);
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(plugin.settings).toMatchObject(savedConnection);
			expect(save).not.toHaveBeenCalled();
			const requestCount = jest.mocked(requestUrl).mock.calls.length;
			await expect(downloader.createDownloadBlob('backup-later')).rejects.toThrow('Wait for the connection save');
			expect(requestUrl).toHaveBeenCalledTimes(requestCount);

			releaseFile();
			const zip = await JSZip.loadAsync(await (await exporting).arrayBuffer());
			await expect(zip.file('Note.md')?.async('string')).resolves.toBe('From the saved connection');
			await applying;
			expect(plugin.settings).toMatchObject(newConnection);
		} finally {
			releaseFile();
			await Promise.allSettled(operations);
			plugin.onunload();
		}
	});

	it.each([
		{ changes: { provider: 'b2' as const, region: '' }, error: 'Backblaze B2 requires a region' },
		{ changes: { endpoint: 'file:///tmp/invalid' }, error: 'Enter an HTTP or HTTPS endpoint URL' },
		{ changes: { accessKeyIdSecret: '' }, error: 'Access Key ID is required' },
		{ changes: { bucket: ' ' }, error: 'Bucket name is required' },
	])('rejects invalid connection edits before saving or contacting S3 ($error)', async ({ changes, error }) => {
		jest.spyOn(EncryptionCoordinator.prototype, 'refreshRemoteMode').mockResolvedValue(undefined);
		const { plugin, layoutReady } = await loadPlugin(false, { ...savedConnection, syncEnabled: false, backupEnabled: false });
		const saveData = jest.spyOn(plugin, 'saveData');
		jest.mocked(requestUrl).mockClear();
		try {
			layoutReady();
			await new Promise<void>(resolve => setImmediate(resolve));
			await expect(plugin.saveConnection({ ...newConnection, ...changes })).rejects.toThrow(error);
			expect(plugin.settings).toMatchObject(savedConnection);
			expect(saveData).not.toHaveBeenCalled();
			expect(requestUrl).not.toHaveBeenCalled();
		} finally {
			plugin.onunload();
		}
	});

	it('preserves the running connection after a write failure and saves unrelated edits on retry', async () => {
		jest.spyOn(EncryptionCoordinator.prototype, 'refreshRemoteMode').mockResolvedValue(undefined);
		const { plugin, layoutReady } = await loadPlugin(false, { ...savedConnection, syncEnabled: false, backupEnabled: false });
		const saveData = jest.spyOn(plugin, 'saveData').mockRejectedValueOnce(new Error('Disk write failed'));
		try {
			layoutReady();
			await new Promise<void>(resolve => setImmediate(resolve));
			await expect(plugin.saveConnection(newConnection)).rejects.toThrow('Disk write failed');
			expect(plugin.settings).toMatchObject(savedConnection);

			const retry = plugin.saveConnection(newConnection);
			plugin.settings.debugLogging = true;
			await Promise.all([retry, plugin.saveSettings()]);
			expect(plugin.settings).toMatchObject({ ...newConnection, debugLogging: true });
			expect(saveData).toHaveBeenLastCalledWith(expect.objectContaining({ ...newConnection, debugLogging: true }));
		} finally {
			plugin.onunload();
		}
	});

	it('keeps an encrypted connection active when the draft destination has no encryption marker', async () => {
		jest.spyOn(EncryptionCoordinator.prototype, 'refreshRemoteMode').mockResolvedValue(undefined);
		const { plugin, layoutReady } = await loadPlugin(false, {
			...savedConnection, encryptionEnabled: true, syncEnabled: false, backupEnabled: false,
		});
		const save = jest.spyOn(plugin, 'saveData');
		jest.mocked(requestUrl).mockResolvedValue({ status: 404, headers: {}, arrayBuffer: new ArrayBuffer(0), json: null, text: '' });
		try {
			layoutReady();
			await new Promise<void>(resolve => setImmediate(resolve));
			await expect(plugin.saveConnection(newConnection)).rejects.toThrow('must have vault encryption enabled');
			expect(plugin.settings).toMatchObject({ ...savedConnection, encryptionEnabled: true });
			expect(save).not.toHaveBeenCalled();
		} finally {
			plugin.onunload();
		}
	});

	it('keeps an encrypted destination blocked if its marker disappears during the connection save', async () => {
		const sync = jest.spyOn(SyncScheduler.prototype, 'triggerSync').mockResolvedValue(null);
		const backup = jest.spyOn(BackupScheduler.prototype, 'start').mockResolvedValue(undefined);
		const snapshot = jest.spyOn(SnapshotCreator.prototype, 'createSnapshot');
		let markerPresent = true;
		jest.spyOn(VaultMarker.prototype, 'exists').mockImplementation(async () => markerPresent);
		jest.spyOn(VaultMarker.prototype, 'getMetadata').mockResolvedValue({
			version: 3, state: 'enabled', salt: 'fixture', createdAt: '', createdBy: '', updatedAt: '', updatedBy: '',
		});
		const initial = { ...savedConnection, encryptionEnabled: true, syncEnabled: true, backupEnabled: true, autoSyncEnabled: false };
		const original = await loadPlugin(false, initial);
		let persisted: Partial<S3SyncBackupSettings> = {};
		jest.spyOn(original.plugin, 'saveData').mockImplementation(async (data: S3SyncBackupSettings) => {
			persisted = { ...data };
			markerPresent = false;
		});

		try {
			original.layoutReady();
			await new Promise<void>((resolve) => setImmediate(resolve));
			await original.plugin.saveConnection(newConnection);
			expect(original.plugin.settings).toMatchObject({ ...newConnection, encryptionEnabled: true });
			expect(original.plugin.getEncryptionCoordinator()?.shouldBlock()).toBe(true);
			expect(persisted).toMatchObject({ ...newConnection, encryptionEnabled: true, pendingEncryptedConnection: true });

			await original.plugin.triggerManualSync();
			await original.plugin.triggerManualBackup();
			expect(sync).not.toHaveBeenCalled();
			expect(backup).not.toHaveBeenCalled();
			expect(snapshot).not.toHaveBeenCalled();
		} finally {
			original.plugin.onunload();
		}

		const reopened = await loadPlugin(false, persisted);
		try {
			reopened.layoutReady();
			await new Promise<void>((resolve) => setImmediate(resolve));
			await reopened.plugin.triggerManualSync();
			await reopened.plugin.triggerManualBackup();
			expect(reopened.plugin.settings).toMatchObject({ ...newConnection, encryptionEnabled: true });
			expect(reopened.plugin.getEncryptionCoordinator()?.shouldBlock()).toBe(true);
			expect(sync).not.toHaveBeenCalled();
			expect(backup).not.toHaveBeenCalled();
			expect(snapshot).not.toHaveBeenCalled();
		} finally {
			reopened.plugin.onunload();
		}
	});

	it('keeps the recovered destination blocked until a correct passphrase and confirmation are saved', async () => {
		jest.spyOn(VaultMarker.prototype, 'exists').mockResolvedValue(true);
		jest.spyOn(VaultMarker.prototype, 'getMetadata').mockResolvedValue({
			version: 3, state: 'enabled', salt: 'fixture', createdAt: '', createdBy: '', updatedAt: '', updatedBy: '',
		});
		jest.spyOn(VaultMarker.prototype, 'verify').mockResolvedValueOnce(null).mockResolvedValue(new Uint8Array(32));
		const { plugin, layoutReady } = await loadPlugin(false, {
			...newConnection, encryptionEnabled: true, pendingEncryptedConnection: true, syncEnabled: false, backupEnabled: false,
		});
		const save = jest.spyOn(plugin, 'saveData').mockRejectedValueOnce(new Error('Disk write failed'));
		try {
			layoutReady();
			await new Promise<void>((resolve) => setImmediate(resolve));
			const coordinator = plugin.getEncryptionCoordinator();
			if (!coordinator) throw new Error('Missing encryption coordinator');
			expect(coordinator.shouldBlock()).toBe(true);
			await expect(coordinator.unlock('incorrect passphrase')).resolves.toBe(false);
			expect(save).not.toHaveBeenCalled();

			await expect(coordinator.unlock('fixture passphrase')).rejects.toThrow('Disk write failed');
			expect(plugin.settings.pendingEncryptedConnection).toBe(true);
			expect(coordinator.getState().hasKey).toBe(false);
			expect(coordinator.shouldBlock()).toBe(true);

			await expect(coordinator.unlock('fixture passphrase')).resolves.toBe(true);
			expect(save).toHaveBeenLastCalledWith(expect.objectContaining({
				...newConnection, encryptionEnabled: true, pendingEncryptedConnection: false,
			}));
			expect(coordinator.getState().hasKey).toBe(true);
			expect(coordinator.shouldBlock()).toBe(false);
		} finally {
			plugin.onunload();
		}
	});

	it('finishes confirming the saved destination with the remembered passphrase on startup', async () => {
		jest.spyOn(VaultMarker.prototype, 'exists').mockResolvedValue(true);
		jest.spyOn(VaultMarker.prototype, 'getMetadata').mockResolvedValue({
			version: 3, state: 'enabled', salt: 'fixture', createdAt: '', createdBy: '', updatedAt: '', updatedBy: '',
		});
		jest.spyOn(VaultMarker.prototype, 'verify').mockResolvedValue(new Uint8Array(32));
		const sync = jest.spyOn(SyncScheduler.prototype, 'triggerSync').mockResolvedValue(null);
		const backup = jest.spyOn(BackupScheduler.prototype, 'start').mockResolvedValue(undefined);
		const { plugin, layoutReady } = await loadPlugin(true, {
			...newConnection, encryptionEnabled: true, pendingEncryptedConnection: true, autoSyncEnabled: false,
		});
		const save = jest.spyOn(plugin, 'saveData');
		try {
			layoutReady();
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(save).toHaveBeenCalledWith(expect.objectContaining({ pendingEncryptedConnection: false, encryptionEnabled: true }));
			expect(plugin.getEncryptionCoordinator()?.getState().hasKey).toBe(true);
			expect(sync).toHaveBeenCalledWith('startup');
			expect(backup).toHaveBeenCalledTimes(1);
			expect(save.mock.invocationCallOrder[0]).toBeLessThan(sync.mock.invocationCallOrder[0]!);
		} finally {
			plugin.onunload();
		}
	});

	it('pauses jobs during the new destination check and clears the previous encryption key', async () => {
		const sync = jest.spyOn(SyncScheduler.prototype, 'triggerSync').mockResolvedValue(null);
		jest.spyOn(BackupScheduler.prototype, 'start').mockResolvedValue(undefined);
		let finishCheck!: () => void;
		const waitingForMarker = new Promise<void>((resolve) => { finishCheck = resolve; });
		let checkStarted!: () => void;
		const checking = new Promise<void>((resolve) => { checkStarted = resolve; });
		jest.spyOn(EncryptionCoordinator.prototype, 'refreshRemoteMode').mockResolvedValueOnce(undefined)
			.mockImplementationOnce(async () => { checkStarted(); await waitingForMarker; });
		jest.spyOn(VaultMarker.prototype, 'verify').mockResolvedValue(new Uint8Array(32));
		const { plugin, layoutReady } = await loadPlugin(false, { ...savedConnection, syncOnStartup: false });
		const snapshot = jest.spyOn(SnapshotCreator.prototype, 'createSnapshot');
		try {
			layoutReady();
			await new Promise<void>(resolve => setImmediate(resolve));
			const coordinator = plugin.getEncryptionCoordinator();
			await expect(coordinator?.unlock('old passphrase')).resolves.toBe(true);
			const applying = plugin.saveConnection(newConnection);
			await checking;
			expect(coordinator?.getState().hasKey).toBe(false);
			await plugin.triggerManualSync();
			await plugin.triggerManualBackup();
			expect(sync).not.toHaveBeenCalled();
			expect(snapshot).not.toHaveBeenCalled();
			finishCheck();
			await applying;
			expect(coordinator?.shouldBlock()).toBe(true);
			expect(plugin.settings).toMatchObject(newConnection);
		} finally {
			finishCheck();
			plugin.onunload();
		}
	});
});

/** A saved snapshot remains successful if retention cleanup fails. */
describe('Plugin backup retention', () => {
	afterEach(() => jest.restoreAllMocks());

	it('records a successful manual backup when retention rejects after the upload', async () => {
		jest.spyOn(SyncScheduler.prototype, 'triggerSync').mockResolvedValue(null);
		jest.spyOn(BackupScheduler.prototype, 'start').mockResolvedValue(undefined);
		jest.spyOn(EncryptionCoordinator.prototype, 'refreshRemoteMode').mockResolvedValue(undefined);
		const { plugin, layoutReady } = await loadPlugin();
		const snapshot = {
			success: true, backupName: 'backup-test', filesBackedUp: 1,
			totalSize: 10, startedAt: 1, completedAt: 2, errors: [],
		};
		jest.spyOn(SnapshotCreator.prototype, 'createSnapshot').mockResolvedValue(snapshot);
		const retention = jest.spyOn(RetentionManager.prototype, 'applyRetentionPolicy').mockRejectedValue(new Error('Access denied'));
		const save = jest.spyOn(plugin, 'saveData');
		try {
			plugin.settings.retentionEnabled = true;
			layoutReady();
			await new Promise<void>(resolve => setImmediate(resolve));
			await plugin.triggerManualBackup();

			expect(retention).toHaveBeenCalledTimes(1);
			expect(Notice).toHaveBeenCalledWith('Backup saved. Retention cleanup failed: Access denied', 10000);
			expect(save).toHaveBeenCalledWith(expect.objectContaining({
				'obsidian-s3-sync-last-backup': expect.any(Number),
			}));
		} finally {
			plugin.onunload();
		}
	});
});
