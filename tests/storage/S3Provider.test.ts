/**
 * Unit tests for S3Provider request shaping.
 */

import { DeleteObjectCommand, DeleteObjectsCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { HttpResponse } from '@smithy/protocol-http';
import { ObsidianHttpHandler } from '../../src/storage/ObsidianHttpHandler';
import { S3Provider } from '../../src/storage/S3Provider';
import { S3SyncBackupSettings } from '../../src/types';

function createSettings(overrides: Partial<S3SyncBackupSettings> = {}): S3SyncBackupSettings {
	return {
		provider: 'aws',
		endpoint: '',
		region: 'us-east-1',
		bucket: 'test-bucket',
		accessKeyIdSecret: 'test-key',
		secretAccessKeySecret: 'test-secret',
		forcePathStyle: false,
		encryptionEnabled: false,
		syncEnabled: true,
		syncPrefix: 'vault',
		autoSyncEnabled: false,
		syncIntervalMinutes: 5,
		syncOnStartup: false,
		backupEnabled: false,
		backupPrefix: 'backups',
		backupInterval: '1day',
		retentionEnabled: false,
		retentionMode: 'copies',
		retentionDays: 30,
		retentionCopies: 30,
		excludePatterns: [],
		debugLogging: false,
		...overrides,
	};
}

/** Exercises production request signing and command shaping. */
describe('S3Provider', () => {
	/** Covers the deletion path used to prune a backup snapshot. */
	describe('deletePrefix', () => {
		it.each(['b2', 'custom'] as const)('uses single Backblaze deletes for the %s provider setting', async (providerType) => {
			const keys = ['backups/backup-old/note.md', 'backups/backup-old/.backup-manifest.json'];
			const send = jest.fn().mockImplementation(async (command: unknown) => {
				if (command instanceof DeleteObjectsCommand) {
					throw new Error('Backblaze rejected the batch POST');
				}
				return {};
			});
			const provider = new S3Provider(
				createSettings({ provider: providerType, endpoint: 'https://s3.us-west-004.backblazeb2.com' }),
				{ send } as unknown as S3Client,
			);
			jest.spyOn(provider, 'listObjects').mockResolvedValue(keys.map(key => ({ key, size: 1, lastModified: new Date(), etag: 'etag' })));

			await expect(provider.deletePrefix('backups/backup-old/')).resolves.toBe(keys.length);
			expect(send.mock.calls.map(([command]) => {
				expect(command).toBeInstanceOf(DeleteObjectCommand);
				return (command as DeleteObjectCommand).input.Key;
			})).toEqual(keys);
		});

		it.each(['bucket', 'backupPrefix'] as const)('stops before the next group when %s changes during Backblaze deletion', async field => {
			let release!: () => void;
			const pending = new Promise<void>(resolve => { release = resolve; });
			const send = jest.fn().mockReturnValue(pending);
			const settings = createSettings({ provider: 'b2', endpoint: 'https://s3.us-west-004.backblazeb2.com' });
			const provider = new S3Provider(settings, { send } as unknown as S3Client);
			const keys = Array.from({ length: 9 }, (_, index) => `backups/backup-old/${index}.md`);

			const deletion = provider.deleteFiles(keys);
			expect(send).toHaveBeenCalledTimes(8);
			// The settings UI mutates the shared object before persistence finishes.
			settings[field] = 'different-destination';
			release();

			await expect(deletion).rejects.toThrow('Storage settings changed');
			expect(send).toHaveBeenCalledTimes(8);
			expect(send.mock.calls.every(([command]) => (command as DeleteObjectCommand).input.Bucket === 'test-bucket')).toBe(true);
		});

		it('waits for outstanding Backblaze deletes before reporting a failed key', async () => {
			let release!: () => void;
			const pending = new Promise<void>(resolve => { release = resolve; });
			const send = jest.fn().mockReturnValue(pending).mockRejectedValueOnce(new Error('Access denied'));
			const provider = new S3Provider(
				createSettings({ provider: 'b2', endpoint: 'https://s3.us-west-004.backblazeb2.com' }),
				{ send } as unknown as S3Client,
			);
			const keys = Array.from({ length: 9 }, (_, index) => `backups/backup-old/${index}.md`);
			const settled = jest.fn();
			const deletion = provider.deleteFiles(keys);
			void deletion.catch(settled);
			await new Promise<void>(resolve => setImmediate(resolve));
			expect(settled).not.toHaveBeenCalled();
			expect(send).toHaveBeenCalledTimes(8);
			release();
			await expect(deletion).rejects.toThrow('Access denied');
			expect(send).toHaveBeenCalledTimes(8);
		});

		it.each(['bucket', 'backupPrefix'] as const)('does not delete previously listed keys when %s changes during listing', async field => {
			const send = jest.fn().mockResolvedValue({});
			const settings = createSettings();
			const provider = new S3Provider(settings, { send } as unknown as S3Client);
			jest.spyOn(provider, 'listObjects').mockImplementation(async () => {
				settings[field] = 'different-destination';
				return [{ key: 'backups/backup-old/note.md', size: 1, lastModified: new Date() }];
			});
			await expect(provider.deletePrefix('backups/backup-old/')).rejects.toThrow('Storage settings changed');
			expect(send).not.toHaveBeenCalled();
		});

		it('reports an incomplete batch when the provider returns per-key errors', async () => {
			const send = jest.fn().mockResolvedValue({ Errors: [{ Code: 'AccessDenied' }] });
			const provider = new S3Provider(createSettings(), { send } as unknown as S3Client);
			jest.spyOn(provider, 'listObjects').mockResolvedValue([
				{ key: 'backups/backup-old/note.md', size: 1, lastModified: new Date(), etag: 'etag' },
			]);

			await expect(provider.deletePrefix('backups/backup-old/')).rejects.toThrow('1 of 1 objects');
			expect(send.mock.calls[0][0]).toBeInstanceOf(DeleteObjectsCommand);
		});
	});

	it('signs subsequent requests with a rotated ID or secret on the same provider', async () => {
		const headers: string[] = [];
		const request = jest.spyOn(ObsidianHttpHandler.prototype, 'handle').mockImplementation(async (p) => {
			headers.push(p.headers.authorization ?? '');
			return { response: new HttpResponse({ statusCode: 200 }) };
		});
		const credentials = { accessKeyId: 'original-id', secretAccessKey: 'original-secret' };
		const provider = new S3Provider(createSettings(), undefined, () => credentials);

		try {
			await provider.fileExists('vault/probe.md');
			credentials.accessKeyId = 'rotated-id';
			await provider.fileExists('vault/probe.md');
			expect(headers[0]).toContain('Credential=original-id/');
			expect(headers[1]).toContain('Credential=rotated-id/');

			const now = new Date();
			jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }).setSystemTime(now);
			await provider.fileExists('vault/probe.md');
			credentials.secretAccessKey = 'rotated-secret';
			await provider.fileExists('vault/probe.md');
			expect(headers[3]).toContain('Credential=rotated-id/');
			expect(headers[3]).not.toBe(headers[2]);
		} finally {
			jest.useRealTimers();
			request.mockRestore();
			provider.destroy();
		}
	});
	it('quotes If-Match ETags for conditional uploads', async () => {
		const provider = new S3Provider(createSettings());
		const send = jest.fn().mockResolvedValue({ ETag: '"returned-etag"' });
		(provider as unknown as { client: { send: typeof send } }).client = { send };

		const etag = await provider.uploadFile('vault/test.md', 'hello', {
			ifMatch: 'abc123',
			ifNoneMatch: '*',
		});

		const command = send.mock.calls[0][0] as PutObjectCommand;
		expect(command).toBeInstanceOf(PutObjectCommand);
		expect(command.input.IfMatch).toBe('"abc123"');
		expect(command.input.IfNoneMatch).toBe('*');
		expect(etag).toBe('returned-etag');
	});

	it('preserves already quoted conditional ETags', async () => {
		const provider = new S3Provider(createSettings());
		const send = jest.fn().mockResolvedValue({ ETag: '"returned-etag"' });
		(provider as unknown as { client: { send: typeof send } }).client = { send };

		await provider.uploadFile('vault/test.md', 'hello', {
			ifMatch: '"abc123"',
		});

		const command = send.mock.calls[0][0] as PutObjectCommand;
		expect(command.input.IfMatch).toBe('"abc123"');
	});

	/**
	 * Backblaze B2 does not implement conditional PutObject, so
	 * `providerSupportsConditionalWrites('b2')` is false and uploadFile must
	 * emulate the guard with a HeadObject pre-check, then upload WITHOUT the
	 * If-Match / If-None-Match headers. These tests pin that contract with a
	 * mocked client (the real behaviour is also covered by the B2 provider
	 * integration matrix).
	 */
	describe('conditional-write emulation (providers without native support)', () => {
		function b2Settings(): S3SyncBackupSettings {
			return createSettings({ provider: 'b2', endpoint: 'https://s3.us-west-004.backblazeb2.com' });
		}

		it('create-only (If-None-Match: *) uploads without the header when the object is absent', async () => {
			const provider = new S3Provider(b2Settings());
			const send = jest.fn().mockImplementation((cmd) => {
				if (cmd instanceof HeadObjectCommand) {
					return Promise.reject({ name: 'NotFound' }); // object absent
				}
				return Promise.resolve({ ETag: '"created"' });
			});
			(provider as unknown as { client: { send: typeof send } }).client = { send };

			const etag = await provider.uploadFile('vault/new.md', 'hello', { ifNoneMatch: '*' });

			// First a HeadObject pre-check, then a PutObject with NO conditional headers.
			expect(send.mock.calls[0][0]).toBeInstanceOf(HeadObjectCommand);
			const put = send.mock.calls[1][0] as PutObjectCommand;
			expect(put).toBeInstanceOf(PutObjectCommand);
			expect(put.input.IfNoneMatch).toBeUndefined();
			expect(put.input.IfMatch).toBeUndefined();
			expect(etag).toBe('created');
		});

		it('create-only (If-None-Match: *) throws PreconditionFailed when the object already exists', async () => {
			const provider = new S3Provider(b2Settings());
			const send = jest.fn().mockImplementation((cmd) => {
				if (cmd instanceof HeadObjectCommand) {
					return Promise.resolve({ ETag: '"exists"', ContentLength: 1, LastModified: new Date(0) });
				}
				return Promise.resolve({ ETag: '"should-not-happen"' });
			});
			(provider as unknown as { client: { send: typeof send } }).client = { send };

			await expect(
				provider.uploadFile('vault/exists.md', 'hello', { ifNoneMatch: '*' }),
			).rejects.toMatchObject({ name: 'PreconditionFailed' });

			// The PutObject must never be sent once the precondition fails.
			expect(send.mock.calls.some(([cmd]) => cmd instanceof PutObjectCommand)).toBe(false);
		});

		it('update-only (If-Match) uploads without the header when the remote ETag matches', async () => {
			const provider = new S3Provider(b2Settings());
			const send = jest.fn().mockImplementation((cmd) => {
				if (cmd instanceof HeadObjectCommand) {
					return Promise.resolve({ ETag: '"abc123"', ContentLength: 1, LastModified: new Date(0) });
				}
				return Promise.resolve({ ETag: '"updated"' });
			});
			(provider as unknown as { client: { send: typeof send } }).client = { send };

			const etag = await provider.uploadFile('vault/update.md', 'hello', { ifMatch: 'abc123' });

			const put = send.mock.calls[1][0] as PutObjectCommand;
			expect(put.input.IfMatch).toBeUndefined();
			expect(etag).toBe('updated');
		});

		it('update-only (If-Match) throws PreconditionFailed when the remote ETag differs', async () => {
			const provider = new S3Provider(b2Settings());
			const send = jest.fn().mockImplementation((cmd) => {
				if (cmd instanceof HeadObjectCommand) {
					return Promise.resolve({ ETag: '"different"', ContentLength: 1, LastModified: new Date(0) });
				}
				return Promise.resolve({ ETag: '"should-not-happen"' });
			});
			(provider as unknown as { client: { send: typeof send } }).client = { send };

			await expect(
				provider.uploadFile('vault/update.md', 'hello', { ifMatch: 'abc123' }),
			).rejects.toMatchObject({ name: 'PreconditionFailed' });
			expect(send.mock.calls.some(([cmd]) => cmd instanceof PutObjectCommand)).toBe(false);
		});
	});

	describe('downloadFileAsTextWithEtag', () => {
		it('returns text content and cleaned ETag', async () => {
			const provider = new S3Provider(createSettings());
			const send = jest.fn().mockResolvedValue({
				Body: new TextEncoder().encode('hello world'),
				ETag: '"abc123"',
			});
			(provider as unknown as { client: { send: typeof send } }).client = { send };

			const result = await provider.downloadFileAsTextWithEtag('vault/test.md');

			expect(result).toEqual({ text: 'hello world', etag: 'abc123' });
		});

		it('returns null for NoSuchKey errors', async () => {
			const provider = new S3Provider(createSettings());
			const send = jest.fn().mockRejectedValue({ name: 'NoSuchKey' });
			(provider as unknown as { client: { send: typeof send } }).client = { send };

			const result = await provider.downloadFileAsTextWithEtag('vault/missing.md');

			expect(result).toBeNull();
		});

		it('returns null for NotFound errors', async () => {
			const provider = new S3Provider(createSettings());
			const send = jest.fn().mockRejectedValue({ name: 'NotFound' });
			(provider as unknown as { client: { send: typeof send } }).client = { send };

			const result = await provider.downloadFileAsTextWithEtag('vault/missing.md');

			expect(result).toBeNull();
		});

		it('re-throws non-not-found errors', async () => {
			const provider = new S3Provider(createSettings());
			const send = jest.fn().mockRejectedValue(new Error('Network error'));
			(provider as unknown as { client: { send: typeof send } }).client = { send };

			await expect(provider.downloadFileAsTextWithEtag('vault/test.md')).rejects.toThrow('Network error');
		});

		it('handles string body response', async () => {
			const provider = new S3Provider(createSettings());
			const send = jest.fn().mockResolvedValue({ Body: 'plain text', ETag: '"etag-str"' });
			(provider as unknown as { client: { send: typeof send } }).client = { send };

			const result = await provider.downloadFileAsTextWithEtag('vault/test.md');

			expect(result).toEqual({ text: 'plain text', etag: 'etag-str' });
		});
	});

	/**
	 * Regression coverage for the ETag normalization contract. S3-compatible
	 * storage (notably Cloudflare R2) can return weak entity-tags of the form
	 * `W/"abc"`. Every S3Provider method that surfaces an ETag to callers must
	 * strip both the `W/` weak-tag prefix and surrounding double-quotes so the
	 * sync engine can compare ETags against its own bare-form baselines.
	 */
	describe('ETag normalization', () => {
		it('strips W/ weak prefix from getFileEtag response', async () => {
			const provider = new S3Provider(createSettings());
			const send = jest.fn().mockResolvedValue({ ETag: 'W/"weak-etag"' });
			(provider as unknown as { client: { send: typeof send } }).client = { send };

			const etag = await provider.getFileEtag('vault/test.md');

			expect(etag).toBe('weak-etag');
		});

		it('strips W/ weak prefix from downloadFileAsTextWithEtag response', async () => {
			const provider = new S3Provider(createSettings());
			const send = jest.fn().mockResolvedValue({
				Body: new TextEncoder().encode('payload'),
				ETag: 'W/"weak-etag"',
			});
			(provider as unknown as { client: { send: typeof send } }).client = { send };

			const result = await provider.downloadFileAsTextWithEtag('vault/test.md');

			expect(result).toEqual({ text: 'payload', etag: 'weak-etag' });
		});

		it('strips W/ weak prefix from listObjects entries', async () => {
			const provider = new S3Provider(createSettings());
			const send = jest.fn().mockResolvedValue({
				Contents: [
					{ Key: 'vault/a.md', Size: 1, LastModified: new Date(0), ETag: 'W/"weak-a"' },
					{ Key: 'vault/b.md', Size: 2, LastModified: new Date(0), ETag: '"strong-b"' },
				],
			});
			(provider as unknown as { client: { send: typeof send } }).client = { send };

			const objects = await provider.listObjects('vault/');

			expect(send.mock.calls[0][0]).toBeInstanceOf(ListObjectsV2Command);
			expect(objects.map((o) => o.etag)).toEqual(['weak-a', 'strong-b']);
		});

		it('strips W/ weak prefix from uploadFile response', async () => {
			const provider = new S3Provider(createSettings());
			const send = jest.fn().mockResolvedValue({ ETag: 'W/"weak-uploaded"' });
			(provider as unknown as { client: { send: typeof send } }).client = { send };

			const etag = await provider.uploadFile('vault/test.md', 'hello');

			expect(etag).toBe('weak-uploaded');
		});

		it('strips W/ weak prefix from getFileMetadata response', async () => {
			const provider = new S3Provider(createSettings());
			const send = jest.fn().mockResolvedValue({
				ETag: 'W/"weak-meta"',
				ContentLength: 42,
				LastModified: new Date(0),
			});
			(provider as unknown as { client: { send: typeof send } }).client = { send };

			const info = await provider.getFileMetadata('vault/test.md');

			expect(info?.etag).toBe('weak-meta');
		});

		it('returns null from getFileEtag when the response ETag is missing', async () => {
			const provider = new S3Provider(createSettings());
			const send = jest.fn().mockResolvedValue({ ETag: undefined });
			(provider as unknown as { client: { send: typeof send } }).client = { send };

			const etag = await provider.getFileEtag('vault/test.md');

			expect(etag).toBeNull();
		});
	});
});
