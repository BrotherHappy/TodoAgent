// @vitest-environment node
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SettingsService, type EncryptionAdapter } from '../electron/services/settings-service';

const encryption: EncryptionAdapter = {
  isAvailable: () => true,
  encryptString: (value) => Buffer.from(`protected:${value}`, 'utf8'),
  decryptString: (value) => value.toString('utf8').replace(/^protected:/, ''),
};

describe('SettingsService', () => {
  it('creates defaults and persists nested updates', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'todo-agent-settings-'));
    const service = new SettingsService(root, encryption);
    await service.load();
    expect(service.get().ai.enabled).toBe(false);

    await service.update({
      theme: 'dark',
      notifications: { ...service.get().notifications, sound: false },
    });

    const reloaded = new SettingsService(root, encryption);
    await reloaded.load();
    expect(reloaded.get().theme).toBe('dark');
    expect(reloaded.get().notifications.sound).toBe(false);
    expect(reloaded.get().notifications.enabled).toBe(true);
  });

  it('migrates existing model settings to explicit bearer authentication', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'todo-agent-model-auth-'));
    const initial = new SettingsService(root, encryption);
    await initial.load();
    const settingsPath = path.join(root, 'settings.v1.json');
    const legacy = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      ai: Record<string, unknown>;
    };
    delete legacy.ai.authMode;
    await writeFile(settingsPath, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');

    const migrated = new SettingsService(root, encryption);
    await migrated.load();
    expect(migrated.get().ai.authMode).toBe('bearer');
    const persisted = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      ai: { authMode?: string };
    };
    expect(persisted.ai.authMode).toBe('bearer');
  });

  it('migrates a legacy orb or capsule into the unique Todo Pet configuration', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'todo-agent-floating-settings-'));
    const initial = new SettingsService(root, encryption);
    await initial.load();
    const settingsPath = path.join(root, 'settings.v1.json');
    const legacy = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      floating: Record<string, unknown>;
    };
    delete legacy.floating.hoverExpandDelayMs;
    delete legacy.floating.selectedTab;
    delete legacy.floating.scalePercent;
    legacy.floating.shape = 'orb';
    legacy.floating.topMode = 'focus-only';
    await writeFile(settingsPath, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');

    const migrated = new SettingsService(root, encryption);
    await migrated.load();
    expect(migrated.get().floating.hoverExpandDelayMs).toBe(1_000);
    expect(migrated.get().floating.topMode).toBe('always');
    expect(migrated.get().floating.selectedTab).toBe('all');
    expect(migrated.get().floating.scalePercent).toBe(100);
    const persistedMigration = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      floating: Record<string, unknown>;
    };
    expect(persistedMigration.floating.topMode).toBe('always');
    expect(persistedMigration.floating.selectedTab).toBe('all');
    expect(persistedMigration.floating.scalePercent).toBe(100);
    expect(persistedMigration.floating).not.toHaveProperty('shape');
    const replaced = await migrated.replace({
      ...migrated.get(),
      floating: {
        ...migrated.get().floating,
        hoverExpandDelayMs: 1_700,
        topMode: 'never',
      },
    });
    expect(replaced.floating.topMode).toBe('always');

    const reloaded = new SettingsService(root, encryption);
    await reloaded.load();
    expect(reloaded.get().floating.hoverExpandDelayMs).toBe(1_700);
    expect(reloaded.get().floating.topMode).toBe('always');
  });

  it('clamps malformed on-disk hover delays to the supported range', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'todo-agent-floating-clamp-'));
    const service = new SettingsService(root, encryption);
    await service.load();
    const settingsPath = path.join(root, 'settings.v1.json');
    const raw = JSON.parse(await readFile(settingsPath, 'utf8')) as {
      floating: { hoverExpandDelayMs: number };
    };
    raw.floating.hoverExpandDelayMs = 90_000;
    await writeFile(settingsPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

    const reloaded = new SettingsService(root, encryption);
    await reloaded.load();
    expect(reloaded.get().floating.hoverExpandDelayMs).toBe(5_000);
  });

  it('migrates missing Todo Pet domains and normalizes malformed focus and weather values', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'todo-agent-pet-settings-'));
    const service = new SettingsService(root, encryption);
    await service.load();
    const settingsPath = path.join(root, 'settings.v1.json');
    const raw = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
    delete raw.focus;
    delete raw.weather;
    delete raw.pet;
    await writeFile(settingsPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');

    const migrated = new SettingsService(root, encryption);
    await migrated.load();
    expect(migrated.get().focus).toMatchObject({ focusMinutes: 25, cycles: 4 });
    expect(migrated.get().weather).toMatchObject({ enabled: false, cacheMinutes: 45 });
    expect(migrated.get().pet).toMatchObject({
      interactionsEnabled: true,
      proactiveMessages: true,
    });

    const current = migrated.get();
    await migrated.replace({
      ...current,
      focus: {
        ...current.focus,
        focusMinutes: Number.NaN,
        shortBreakMinutes: 9_999,
        cycles: -4,
        environmentSound: 'invalid' as typeof current.focus.environmentSound,
      },
      weather: {
        ...current.weather,
        cacheMinutes: Number.NaN,
        latitude: Number.POSITIVE_INFINITY,
      },
    });
    expect(migrated.get().focus).toMatchObject({
      focusMinutes: 25,
      shortBreakMinutes: 60,
      cycles: 1,
      environmentSound: 'off',
    });
    expect(migrated.get().weather.cacheMinutes).toBe(45);
    expect(migrated.get().weather.latitude).toBeUndefined();
  });

  it('stores credentials encrypted and never exposes ciphertext metadata', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'todo-agent-secrets-'));
    const service = new SettingsService(root, encryption);
    await service.load();
    const credential = await service.setCredential('ai-api-key', 'sk-secret');

    expect(service.getCredential(credential.id)).toBe('sk-secret');
    expect(service.listCredentials()[0]).not.toHaveProperty('encryptedValue');
    const raw = await readFile(path.join(root, 'private', 'credentials.v1.json'), 'utf8');
    expect(raw).not.toContain('sk-secret');
    expect(raw).toContain(Buffer.from('protected:sk-secret').toString('base64'));
  });

  it('persists an existing-direct identity across restart while keeping all secret values out of ordinary settings', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'todo-agent-feishu-settings-'));
    const service = new SettingsService(root, encryption);
    await service.load();
    await service.setCredential(
      'feishu-app-secret',
      'EXISTING_APP_SECRET_SENTINEL',
      'existing-secret-ref',
    );
    await service.setCredential(
      'feishu-token',
      JSON.stringify({
        accessToken: 'ACCESS_TOKEN_SENTINEL',
        refreshToken: 'REFRESH_TOKEN_SENTINEL',
        tokenType: 'Bearer',
        scope: ['task:task:write', 'offline_access'],
        expiresAt: 1_800_000_000_000,
      }),
      'existing-token-ref',
    );

    const configured = service.get();
    await service.replace({
      ...configured,
      feishu: {
        ...configured.feishu,
        configured: true,
        mode: 'existing-direct',
        accountId: 'primary',
        clientId: 'cli_existing_persisted',
        appSecretCredentialId: 'existing-secret-ref',
        tokenCredentialId: 'existing-token-ref',
        // These execution-time extras model a mistaken internal caller. The
        // SettingsService allow-list must still keep them off disk.
        clientSecret: 'ACCIDENTAL_PLAINTEXT_SECRET',
        accessToken: 'ACCIDENTAL_ACCESS_TOKEN',
        refreshToken: 'ACCIDENTAL_REFRESH_TOKEN',
      },
    } as unknown as typeof configured);

    const ordinarySettings = await readFile(
      path.join(root, 'settings.v1.json'),
      'utf8',
    );
    expect(ordinarySettings).toContain('cli_existing_persisted');
    expect(ordinarySettings).toContain('existing-secret-ref');
    expect(ordinarySettings).toContain('existing-token-ref');
    for (const secret of [
      'EXISTING_APP_SECRET_SENTINEL',
      'ACCESS_TOKEN_SENTINEL',
      'REFRESH_TOKEN_SENTINEL',
      'ACCIDENTAL_PLAINTEXT_SECRET',
      'ACCIDENTAL_ACCESS_TOKEN',
      'ACCIDENTAL_REFRESH_TOKEN',
    ]) {
      expect(ordinarySettings).not.toContain(secret);
    }

    const encryptedCredentials = await readFile(
      path.join(root, 'private', 'credentials.v1.json'),
      'utf8',
    );
    expect(encryptedCredentials).not.toContain('EXISTING_APP_SECRET_SENTINEL');
    expect(encryptedCredentials).not.toContain('ACCESS_TOKEN_SENTINEL');
    expect(encryptedCredentials).not.toContain('REFRESH_TOKEN_SENTINEL');

    const reloaded = new SettingsService(root, encryption);
    await reloaded.load();
    expect(reloaded.get().feishu).toMatchObject({
      configured: true,
      mode: 'existing-direct',
      accountId: 'primary',
      clientId: 'cli_existing_persisted',
      appSecretCredentialId: 'existing-secret-ref',
      tokenCredentialId: 'existing-token-ref',
    });
    expect(reloaded.getCredential('existing-secret-ref')).toBe(
      'EXISTING_APP_SECRET_SENTINEL',
    );
    expect(reloaded.getCredential('existing-token-ref')).toContain(
      'REFRESH_TOKEN_SENTINEL',
    );
  });

  it('allocates a new credential reference without overwriting an older app secret', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'todo-agent-app-secrets-'));
    const service = new SettingsService(root, encryption);
    await service.load();
    const first = await service.setCredential('feishu-app-secret', 'FIRST-SECRET');
    const second = await service.setCredential('feishu-app-secret', 'SECOND-SECRET');

    expect(second.id).not.toBe(first.id);
    expect(service.getCredential(first.id)).toBe('FIRST-SECRET');
    expect(service.getCredential(second.id)).toBe('SECOND-SECRET');
  });

  it('serializes concurrent settings and credential writes without losing the latest state', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'todo-agent-concurrent-settings-'));
    const service = new SettingsService(root, encryption);
    await service.load();

    const firstSettings = service.replace({
      ...service.get(),
      theme: 'dark',
    });
    const secondSettings = service.replace({
      ...service.get(),
      theme: 'light',
      floating: {
        ...service.get().floating,
        hoverExpandDelayMs: 1_450,
      },
    });
    const firstCredential = service.setCredential(
      'ai-api-key',
      'FIRST-CONCURRENT-SECRET',
      'concurrent-first',
    );
    const secondCredential = service.setCredential(
      'feishu-app-secret',
      'SECOND-CONCURRENT-SECRET',
      'concurrent-second',
    );
    await Promise.all([
      firstSettings,
      secondSettings,
      firstCredential,
      secondCredential,
    ]);

    const reloaded = new SettingsService(root, encryption);
    await reloaded.load();
    expect(reloaded.get().theme).toBe('light');
    expect(reloaded.get().floating.hoverExpandDelayMs).toBe(1_450);
    expect(reloaded.getCredential('concurrent-first')).toBe(
      'FIRST-CONCURRENT-SECRET',
    );
    expect(reloaded.getCredential('concurrent-second')).toBe(
      'SECOND-CONCURRENT-SECRET',
    );
  });

  it('refuses plaintext persistence when secure storage is unavailable', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'todo-agent-insecure-'));
    const service = new SettingsService(root, { ...encryption, isAvailable: () => false });
    await service.load();
    await expect(service.setCredential('ai-api-key', 'secret')).rejects.toThrow('SECURE_STORAGE_UNAVAILABLE');
  });
});
