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

	/** Looks up the two secret references on the current device. */
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

	/** Covers remembering and forgetting the local passphrase. */
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

	/** Covers legacy-only and restored settings, plus failures before JSON cleanup. */
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

		it('keeps a selected secret that resolves successfully', () => {
			store.setSecret('chosen', 'current');
			const settings = legacySettings({ accessKeyId: 'AKIA', accessKeyIdSecret: 'chosen' });

			vault.migrateLegacySettings(settings);

			expect(settings.accessKeyIdSecret).toBe('chosen');
			expect(vault.getCredentials(settings).accessKeyId).toBe('current');
			expect(settings).not.toHaveProperty('accessKeyId');
		});

		it('uses the legacy credential pair when one selected secret is missing', () => {
			store.setSecret('chosen-secret', 'different-secret');
			const settings = legacySettings({
				accessKeyId: 'legacy-id', secretAccessKey: 'legacy-secret',
				accessKeyIdSecret: 'missing-id', secretAccessKeySecret: 'chosen-secret',
			});

			vault.migrateLegacySettings(settings);

			expect(vault.getCredentials(settings)).toEqual({ accessKeyId: 'legacy-id', secretAccessKey: 'legacy-secret' });
			expect(settings).not.toHaveProperty('accessKeyId');
			expect(settings).not.toHaveProperty('secretAccessKey');
			expect(store.getSecret('chosen-secret')).toBe('different-secret');
		});

		it('preserves a remembered local passphrase when the legacy value differs', () => {
			store.setSecret(PASSPHRASE_SECRET_ID, 'current-passphrase');
			const settings = legacySettings({ rememberPassphrase: true, savedPassphrase: 'old-passphrase' });

			vault.migrateLegacySettings(settings);

			expect(vault.getPassphrase()).toBe('current-passphrase');
			expect(settings).not.toHaveProperty('savedPassphrase');
		});

		it('keeps the legacy fields when a secret cannot be read back and reuses successful writes on retry', () => {
			const saved = { accessKeyId: 'AKIA', secretAccessKey: 'legacy-secret' };
			const settings = legacySettings(saved);
			const write = store.setSecret.bind(store);
			const setSecret = jest.spyOn(store, 'setSecret').mockImplementation((id, value) => {
				if (id === DEFAULT_ACCESS_KEY_ID_SECRET) write(id, value);
			});
			try {
				expect(() => vault.migrateLegacySettings(settings)).toThrow('could not save');
				expect(settings).toMatchObject(saved);
			} finally {
				setSecret.mockRestore();
			}
			const retry = legacySettings(saved);
			expect(vault.migrateLegacySettings(retry)).toBe(true);
			expect(vault.getCredentials(retry)).toEqual(saved);
			expect(store.data.size).toBe(2);
		});

		it('is idempotent', () => {
			const settings = legacySettings({ accessKeyId: 'AKIA', secretAccessKey: 'shh' });

			expect(vault.migrateLegacySettings(settings)).toBe(true);
			expect(vault.migrateLegacySettings(settings)).toBe(false);
		});
	});
});
