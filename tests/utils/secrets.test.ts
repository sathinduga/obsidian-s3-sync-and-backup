/**
 * Unit tests for the SecretVault wrapper around Obsidian SecretStorage.
 */

import {
	DEFAULT_ACCESS_KEY_ID_SECRET,
	DEFAULT_SECRET_ACCESS_KEY_SECRET,
	PASSPHRASE_SECRET_ID,
	SecretStore,
	SecretVault,
} from '../../src/utils/secrets';
import { DEFAULT_SETTINGS, S3SyncBackupSettings } from '../../src/types';

/** In-memory SecretStorage fake mirroring Obsidian's ID validation. */
class FakeSecretStore implements SecretStore {
	readonly data = new Map<string, string>();

	getSecret(id: string): string | null {
		return this.data.get(id) ?? null;
	}

	setSecret(id: string, secret: string): void {
		if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) throw new Error('Invalid secret ID');
		this.data.set(id, secret);
	}
}

/** Builds settings as loaded from an old `data.json` that still has plaintext secrets. */
function legacySettings(extra: Record<string, unknown>): S3SyncBackupSettings {
	return { ...DEFAULT_SETTINGS, ...extra } as S3SyncBackupSettings;
}

/**
 * Covers reading credentials, the remembered passphrase lifecycle (including the
 * "clear = empty string" convention), and the one-time plaintext migration.
 */
describe('SecretVault', () => {
	let store: FakeSecretStore;
	let vault: SecretVault;

	beforeEach(() => {
		store = new FakeSecretStore();
		vault = new SecretVault(store);
	});

	describe('getCredentials', () => {
		it('resolves the values of the secrets named in settings', () => {
			store.setSecret('my-key', 'AKIA');
			store.setSecret('my-secret', 'shh');

			const creds = vault.getCredentials({ accessKeyIdSecret: 'my-key', secretAccessKeySecret: 'my-secret' });

			expect(creds).toEqual({ accessKeyId: 'AKIA', secretAccessKey: 'shh' });
		});

		it('returns empty strings for unset names and missing secrets', () => {
			const creds = vault.getCredentials({ accessKeyIdSecret: '', secretAccessKeySecret: 'absent' });

			expect(creds).toEqual({ accessKeyId: '', secretAccessKey: '' });
		});
	});

	describe('passphrase', () => {
		it('round-trips under the fixed secret ID', () => {
			vault.setPassphrase('correct horse');

			expect(vault.getPassphrase()).toBe('correct horse');
			expect(store.data.get(PASSPHRASE_SECRET_ID)).toBe('correct horse');
		});

		it('clearPassphrase empties the secret so it reads back as not set', () => {
			vault.setPassphrase('correct horse');
			vault.clearPassphrase();

			expect(vault.getPassphrase()).toBe('');
		});

		it('returns an empty string when never stored', () => {
			expect(vault.getPassphrase()).toBe('');
		});
	});

	describe('migrateLegacySettings', () => {
		it('does nothing and reports no change when no legacy keys exist', () => {
			const settings = { ...DEFAULT_SETTINGS };

			expect(vault.migrateLegacySettings(settings)).toBe(false);
			expect(store.data.size).toBe(0);
		});

		it('moves plaintext keys and passphrase into SecretStorage and strips them from settings', () => {
			const settings = legacySettings({
				accessKeyId: 'AKIA',
				secretAccessKey: 'shh',
				rememberPassphrase: true,
				savedPassphrase: 'correct horse',
			});

			expect(vault.migrateLegacySettings(settings)).toBe(true);

			expect(settings.accessKeyIdSecret).toBe(DEFAULT_ACCESS_KEY_ID_SECRET);
			expect(settings.secretAccessKeySecret).toBe(DEFAULT_SECRET_ACCESS_KEY_SECRET);
			expect(store.data.get(DEFAULT_ACCESS_KEY_ID_SECRET)).toBe('AKIA');
			expect(store.data.get(DEFAULT_SECRET_ACCESS_KEY_SECRET)).toBe('shh');
			expect(vault.getPassphrase()).toBe('correct horse');
			expect(settings).not.toHaveProperty('accessKeyId');
			expect(settings).not.toHaveProperty('secretAccessKey');
			expect(settings).not.toHaveProperty('savedPassphrase');
		});

		it('drops a saved passphrase when remember-passphrase was off', () => {
			const settings = legacySettings({ rememberPassphrase: false, savedPassphrase: 'stale' });

			expect(vault.migrateLegacySettings(settings)).toBe(true);

			expect(vault.getPassphrase()).toBe('');
			expect(settings).not.toHaveProperty('savedPassphrase');
		});

		it('never overwrites an existing secret holding a different value', () => {
			store.setSecret(DEFAULT_ACCESS_KEY_ID_SECRET, 'OTHER');
			const settings = legacySettings({ accessKeyId: 'AKIA' });

			vault.migrateLegacySettings(settings);

			expect(store.data.get(DEFAULT_ACCESS_KEY_ID_SECRET)).toBe('OTHER');
			expect(settings.accessKeyIdSecret).toBe(`${DEFAULT_ACCESS_KEY_ID_SECRET}-2`);
			expect(store.data.get(`${DEFAULT_ACCESS_KEY_ID_SECRET}-2`)).toBe('AKIA');
		});

		it('reuses the default ID when it already holds the same value', () => {
			store.setSecret(DEFAULT_ACCESS_KEY_ID_SECRET, 'AKIA');
			const settings = legacySettings({ accessKeyId: 'AKIA' });

			vault.migrateLegacySettings(settings);

			expect(settings.accessKeyIdSecret).toBe(DEFAULT_ACCESS_KEY_ID_SECRET);
		});

		it('keeps an already selected secret name and only strips the legacy key', () => {
			const settings = legacySettings({ accessKeyId: 'AKIA', accessKeyIdSecret: 'chosen' });

			vault.migrateLegacySettings(settings);

			expect(settings.accessKeyIdSecret).toBe('chosen');
			expect(store.data.size).toBe(0);
			expect(settings).not.toHaveProperty('accessKeyId');
		});

		it('is idempotent', () => {
			const settings = legacySettings({ accessKeyId: 'AKIA', secretAccessKey: 'shh' });

			expect(vault.migrateLegacySettings(settings)).toBe(true);
			expect(vault.migrateLegacySettings(settings)).toBe(false);
		});
	});
});
