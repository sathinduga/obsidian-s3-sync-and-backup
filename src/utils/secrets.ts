/**
 * Secret handling (Obsidian SecretStorage).
 *
 * Why: S3 credentials and the remembered passphrase used to live in plaintext in
 * `data.json`. They now live in Obsidian's SecretStorage (device-local, per vault);
 * settings only hold the *names* of the S3 key secrets, and the passphrase uses a
 * fixed secret ID managed by the plugin.
 *
 * Fit: `SecretVault` is created once in `main.ts` and handed to the S3 layer (as a
 * credentials resolver) and to the settings UI / startup unlock flow.
 *
 * Note: SecretStorage has no delete API, so "clearing" a secret stores an empty
 * string, and an empty value is always treated as "not set".
 */

import type { S3SyncBackupSettings } from '../types';

/** Default secret IDs used when migrating legacy plaintext values. */
export const DEFAULT_ACCESS_KEY_ID_SECRET = 's3-sync-access-key-id';
export const DEFAULT_SECRET_ACCESS_KEY_SECRET = 's3-sync-secret-access-key';

/** Fixed secret ID for the remembered encryption passphrase. */
export const PASSPHRASE_SECRET_ID = 's3-sync-passphrase';

/** Subset of Obsidian's `SecretStorage` used by the plugin (eases mocking). */
export interface SecretStore {
	getSecret(id: string): string | null;
	setSecret(id: string, secret: string): void;
}

/** Resolved S3 credentials; empty strings mean "not configured". */
export interface S3Credentials {
	accessKeyId: string;
	secretAccessKey: string;
}

/** Resolves credentials at call time so rotated secrets are picked up without a restart. */
export type CredentialsResolver = () => S3Credentials;

/** Settings fields that older plugin versions stored in plaintext. */
const LEGACY_KEYS = ['accessKeyId', 'secretAccessKey', 'savedPassphrase'] as const;

/**
 * Thin wrapper over `app.secretStorage` for the plugin's three secrets.
 */
export class SecretVault {
	/**
	 * @param store - Obsidian's `app.secretStorage` (or a compatible fake in tests).
	 */
	constructor(private readonly store: SecretStore) {}

	/**
	 * Read a secret by ID.
	 *
	 * @param id - Secret ID; an empty ID yields `''` without touching the store.
	 * @returns The secret value, or `''` when missing or empty.
	 */
	get(id: string): string {
		if (!id) return '';
		return this.store.getSecret(id) ?? '';
	}

	/**
	 * Resolve the S3 credentials referenced by the settings.
	 *
	 * @param settings - Settings holding the secret names.
	 * @returns Current credential values (empty strings if unset).
	 */
	getCredentials(settings: Pick<S3SyncBackupSettings, 'accessKeyIdSecret' | 'secretAccessKeySecret'>): S3Credentials {
		return {
			accessKeyId: this.get(settings.accessKeyIdSecret),
			secretAccessKey: this.get(settings.secretAccessKeySecret),
		};
	}

	/** @returns The remembered passphrase, or `''` if none is stored. */
	getPassphrase(): string {
		return this.get(PASSPHRASE_SECRET_ID);
	}

	/**
	 * Store the passphrase for auto-unlock on startup.
	 *
	 * @param passphrase - Raw passphrase.
	 */
	setPassphrase(passphrase: string): void {
		this.store.setSecret(PASSPHRASE_SECRET_ID, passphrase);
	}

	/** Forget the remembered passphrase (stores an empty string; no delete API exists). */
	clearPassphrase(): void {
		this.store.setSecret(PASSPHRASE_SECRET_ID, '');
	}

	/**
	 * Move plaintext secrets left in `data.json` by older versions into SecretStorage.
	 *
	 * Mutates `settings` in place: sets the secret-name fields and deletes the legacy
	 * plaintext keys. An existing secret under the default ID with a different value is
	 * never overwritten; a numeric suffix is used instead. Idempotent.
	 *
	 * @param settings - Settings object merged from defaults and persisted data.
	 * @returns `true` if the object changed and must be persisted again.
	 */
	migrateLegacySettings(settings: S3SyncBackupSettings): boolean {
		const legacy = settings as unknown as Record<string, unknown>;
		const hasLegacy = LEGACY_KEYS.some((key) => key in legacy);
		if (!hasLegacy) return false;

		const accessKeyId = legacy.accessKeyId;
		if (typeof accessKeyId === 'string' && accessKeyId && !settings.accessKeyIdSecret) {
			settings.accessKeyIdSecret = this.storeUnderFreeId(DEFAULT_ACCESS_KEY_ID_SECRET, accessKeyId);
		}

		const secretAccessKey = legacy.secretAccessKey;
		if (typeof secretAccessKey === 'string' && secretAccessKey && !settings.secretAccessKeySecret) {
			settings.secretAccessKeySecret = this.storeUnderFreeId(DEFAULT_SECRET_ACCESS_KEY_SECRET, secretAccessKey);
		}

		const savedPassphrase = legacy.savedPassphrase;
		if (typeof savedPassphrase === 'string' && savedPassphrase && settings.rememberPassphrase) {
			this.setPassphrase(savedPassphrase);
		}

		for (const key of LEGACY_KEYS) {
			delete legacy[key];
		}
		return true;
	}

	/**
	 * Save `value` under `baseId`, or `baseId-2`, `baseId-3`, ... if the ID already holds
	 * a different non-empty value.
	 *
	 * @returns The ID the value was stored under.
	 */
	private storeUnderFreeId(baseId: string, value: string): string {
		let id = baseId;
		for (let n = 2; ; n++) {
			const existing = this.store.getSecret(id);
			if (!existing || existing === value) break;
			id = `${baseId}-${n}`;
		}
		this.store.setSecret(id, value);
		return id;
	}
}
