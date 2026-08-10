// @vitest-environment node

import { describe, expect, it } from 'vitest';

import {
  OAuthLoopbackError,
  OAuthLoopbackServer,
} from '../electron/feishu/oauth-loopback-server';

describe('OAuthLoopbackServer', () => {
  it('binds a random IPv4 loopback port and consumes only the expected path/state', async () => {
    const server = new OAuthLoopbackServer({ timeoutMs: 2_000 });
    const redirectUri = await server.listen();
    const redirect = new URL(redirectUri);
    expect(redirect.hostname).toBe('127.0.0.1');
    expect(Number(redirect.port)).toBeGreaterThan(0);
    expect(redirect.pathname).toBe('/oauth/feishu/callback');

    const callback = server.waitForCallback('one-time-state');
    const wrongPath = await fetch(
      `${redirect.origin}/not-the-callback?code=attacker&state=one-time-state`,
    );
    expect(wrongPath.status).toBe(404);
    const wrongState = await fetch(
      `${redirectUri}?code=attacker&state=wrong-state`,
    );
    expect(wrongState.status).toBe(400);

    const success = await fetch(
      `${redirectUri}?code=authorization-code&state=one-time-state`,
    );
    expect(success.status).toBe(200);
    await expect(callback).resolves.toEqual({
      code: 'authorization-code',
      state: 'one-time-state',
    });
    await expect(
      server.waitForCallback('second-state'),
    ).rejects.toMatchObject({ code: 'NOT_LISTENING' });
    await expect(fetch(`${redirectUri}?code=again&state=one-time-state`)).rejects.toThrow();
  });

  it('times out and closes when no valid callback arrives', async () => {
    const server = new OAuthLoopbackServer({ timeoutMs: 20 });
    const redirectUri = await server.listen();
    const waiting = server.waitForCallback('timeout-state');
    await expect(waiting).rejects.toMatchObject({
      name: 'OAuthLoopbackError',
      code: 'TIMEOUT',
    });
    await expect(fetch(redirectUri)).rejects.toThrow();
  });

  it('supports explicit cancellation and rejects provider errors', async () => {
    const cancelledServer = new OAuthLoopbackServer({ timeoutMs: 2_000 });
    const cancelledUri = await cancelledServer.listen();
    const cancelled = cancelledServer.waitForCallback('cancel-state');
    const cancelledAssertion = expect(cancelled).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    await cancelledServer.cancel('cancelled by test');
    await cancelledAssertion;
    await expect(fetch(cancelledUri)).rejects.toThrow();

    const deniedServer = new OAuthLoopbackServer({ timeoutMs: 2_000 });
    const deniedUri = await deniedServer.listen();
    const denied = deniedServer.waitForCallback('denied-state');
    const deniedResult = denied.catch((caught: unknown) => caught);
    const response = await fetch(
      `${deniedUri}?error=access_denied&error_description=user_cancelled&state=denied-state`,
    );
    expect(response.status).toBe(400);
    const error = await deniedResult;
    expect(error).toBeInstanceOf(OAuthLoopbackError);
    expect(error).toMatchObject({ code: 'OAUTH_ERROR' });
  });
});
