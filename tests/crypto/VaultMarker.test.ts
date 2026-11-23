/** Tests vault marker verification and per-vault device IDs. */
import { App } from 'obsidian';
import { generateDeviceId, getOrCreateDeviceId, VaultMarker } from '../../src/crypto/VaultMarker';
import type { S3Provider } from '../../src/storage/S3Provider';
import type { VaultEncryptionMarker } from '../../src/types';

/** Confirm a new connection using the same marker document that verifies the passphrase. */
describe('VaultMarker.verify', () => {
	it('requires enabled encryption for a new connection and accepts markers from earlier releases', async () => {
		let stored = '';
		const provider = {
			uploadFile: jest.fn(async (_key: string, body: string) => { stored = body; }),
			downloadFileAsText: jest.fn(async () => stored),
		} as unknown as S3Provider;
		const marker = new VaultMarker(provider, 'vault');
		const passphrase = 'fixture passphrase';
		const key = await marker.create(passphrase, 'fixture-device');

		await expect(marker.verify(passphrase, true)).resolves.toBeNull();
		await expect(marker.verify(passphrase)).resolves.toEqual(key);

		const { state: _state, ...legacyMarker } = JSON.parse(stored) as VaultEncryptionMarker;
		stored = JSON.stringify(legacyMarker);
		await expect(marker.verify(passphrase, true)).resolves.toEqual(key);
	});
});

describe('generateDeviceId', () => {
	it('returns a string with "device-" prefix and 16 hex characters', () => {
		const id = generateDeviceId();
		expect(id).toMatch(/^device-[0-9a-f]{16}$/);
	});

	it('generates unique IDs on successive calls', () => {
		const ids = new Set(Array.from({ length: 20 }, () => generateDeviceId()));
		expect(ids.size).toBe(20);
	});
});

describe('getOrCreateDeviceId', () => {
	let mockApp: App;
	let vaultStorage: Map<string, string>;

	beforeEach(() => {
		vaultStorage = new Map();

		mockApp = {
			loadLocalStorage: jest.fn((key: string) => vaultStorage.get(key) ?? null),
			saveLocalStorage: jest.fn((key: string, value: string) => {
				vaultStorage.set(key, value);
			}),
		} as unknown as App;
	});

	it('generates a new device ID when no prior value exists', () => {
		const id = getOrCreateDeviceId(mockApp);

		expect(id).toMatch(/^device-[0-9a-f]{16}$/);
		expect(mockApp.saveLocalStorage).toHaveBeenCalledWith('s3-sync-device-id', id);
	});

	it('returns the existing vault-scoped ID without regenerating', () => {
		vaultStorage.set('s3-sync-device-id', 'device-existing1234abcd');

		const id = getOrCreateDeviceId(mockApp);

		expect(id).toBe('device-existing1234abcd');
		expect(mockApp.saveLocalStorage).not.toHaveBeenCalled();
	});

	it('produces distinct IDs for two different vaults (vault-scoped isolation)', () => {
		const vault1Storage = new Map<string, string>();
		const vault2Storage = new Map<string, string>();

		const app1 = {
			loadLocalStorage: jest.fn((key: string) => vault1Storage.get(key) ?? null),
			saveLocalStorage: jest.fn((key: string, value: string) => {
				vault1Storage.set(key, value);
			}),
		} as unknown as App;

		const app2 = {
			loadLocalStorage: jest.fn((key: string) => vault2Storage.get(key) ?? null),
			saveLocalStorage: jest.fn((key: string, value: string) => {
				vault2Storage.set(key, value);
			}),
		} as unknown as App;

		const id1 = getOrCreateDeviceId(app1);
		const id2 = getOrCreateDeviceId(app2);

		expect(id1).not.toBe(id2);
		expect(vault1Storage.get('s3-sync-device-id')).toBe(id1);
		expect(vault2Storage.get('s3-sync-device-id')).toBe(id2);
	});

	it('returns the same ID on repeated calls for the same vault', () => {
		const first = getOrCreateDeviceId(mockApp);
		const second = getOrCreateDeviceId(mockApp);

		expect(first).toBe(second);
	});

	it('regenerates a fresh ID when vault-scoped storage holds an empty string', () => {
		// `loadLocalStorage` returns `any | null`; an empty string is truthy-falsy
		// edge case that must not be adopted as a valid device ID.
		vaultStorage.set('s3-sync-device-id', '');

		const id = getOrCreateDeviceId(mockApp);

		expect(id).toMatch(/^device-[0-9a-f]{16}$/);
		expect(mockApp.saveLocalStorage).toHaveBeenCalledWith('s3-sync-device-id', id);
	});

	it('regenerates a fresh ID when vault-scoped storage holds a non-string value', () => {
		// Defensive against future regressions: a non-string stored value (e.g. an
		// object accidentally written by a future migration) must trigger fresh
		// generation rather than being returned as if it were a device ID.
		(mockApp.loadLocalStorage as jest.Mock).mockReturnValueOnce({ id: 'device-legacy0000000000' });

		const id = getOrCreateDeviceId(mockApp);

		expect(id).toMatch(/^device-[0-9a-f]{16}$/);
		expect(mockApp.saveLocalStorage).toHaveBeenCalledWith('s3-sync-device-id', id);
	});
});
