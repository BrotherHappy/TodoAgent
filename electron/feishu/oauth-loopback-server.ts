import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { FeishuOAuthCallback } from '../../src/shared/feishu-types';

export type OAuthLoopbackErrorCode =
  | 'NOT_LISTENING'
  | 'ALREADY_WAITING'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'OAUTH_ERROR'
  | 'MISSING_CODE';

export class OAuthLoopbackError extends Error {
  readonly code: OAuthLoopbackErrorCode;

  constructor(code: OAuthLoopbackErrorCode, message: string) {
    super(message);
    this.name = 'OAuthLoopbackError';
    this.code = code;
  }
}

export interface OAuthLoopbackServerOptions {
  callbackPath?: string;
  timeoutMs?: number;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

export class OAuthLoopbackServer {
  readonly callbackPath: string;
  readonly timeoutMs: number;
  private server?: Server;
  private redirectUri?: string;
  private expectedState?: string;
  private callbackPromise?: Promise<FeishuOAuthCallback>;
  private resolveCallback?: (callback: FeishuOAuthCallback) => void;
  private rejectCallback?: (error: Error) => void;
  private timer?: ReturnType<typeof setTimeout>;
  private settled = false;

  constructor(options: OAuthLoopbackServerOptions = {}) {
    const callbackPath = options.callbackPath ?? '/oauth/feishu/callback';
    if (
      !callbackPath.startsWith('/') ||
      callbackPath.includes('?') ||
      callbackPath.includes('#') ||
      callbackPath.split('/').includes('..')
    ) {
      throw new TypeError('OAuth callbackPath must be one absolute URL path.');
    }
    const timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new TypeError('OAuth timeoutMs must be positive.');
    }
    this.callbackPath = callbackPath;
    this.timeoutMs = timeoutMs;
  }

  async listen(): Promise<string> {
    if (this.redirectUri) return this.redirectUri;
    if (this.server) throw new Error('OAuth loopback server is already starting.');

    const server = createServer((request, response) => {
      this.handleRequest(request, response);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      // Port 0 delegates random-port selection to the operating system. Binding
      // the numeric loopback address prevents exposure on LAN/WAN interfaces.
      server.listen(0, '127.0.0.1');
    });

    const address = server.address() as AddressInfo | null;
    if (!address || address.address !== '127.0.0.1') {
      await this.close();
      throw new Error('OAuth callback server did not bind to IPv4 loopback.');
    }
    this.redirectUri = `http://127.0.0.1:${address.port}${this.callbackPath}`;
    return this.redirectUri;
  }

  waitForCallback(expectedState: string): Promise<FeishuOAuthCallback> {
    if (!this.server?.listening || !this.redirectUri) {
      return Promise.reject(
        new OAuthLoopbackError(
          'NOT_LISTENING',
          'OAuth loopback server must listen before waiting.',
        ),
      );
    }
    if (this.callbackPromise) {
      return Promise.reject(
        new OAuthLoopbackError(
          'ALREADY_WAITING',
          'OAuth loopback state can only be consumed once.',
        ),
      );
    }
    if (!expectedState) {
      return Promise.reject(new TypeError('OAuth expectedState is required.'));
    }

    this.expectedState = expectedState;
    this.callbackPromise = new Promise<FeishuOAuthCallback>((resolve, reject) => {
      this.resolveCallback = resolve;
      this.rejectCallback = reject;
    });
    this.timer = setTimeout(() => {
      this.finishWithError(
        new OAuthLoopbackError('TIMEOUT', 'OAuth callback timed out.'),
      );
    }, this.timeoutMs);
    return this.callbackPromise;
  }

  private handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('connection', 'close');
    response.setHeader('content-type', 'text/html; charset=utf-8');

    let url: URL;
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1');
    } catch {
      this.respond(response, 400, '无效的 OAuth 回调。');
      return;
    }
    if (request.method !== 'GET' || url.pathname !== this.callbackPath) {
      this.respond(response, 404, '不是预期的 OAuth 回调地址。');
      return;
    }
    if (!this.expectedState || this.settled) {
      this.respond(response, 409, '当前没有等待中的 OAuth 授权。');
      return;
    }

    const state = url.searchParams.get('state') ?? '';
    if (!safeEqual(state, this.expectedState)) {
      // A bad state does not consume the one legitimate attempt.
      this.respond(response, 400, 'OAuth state 校验失败。');
      return;
    }

    const oauthError = url.searchParams.get('error');
    if (oauthError) {
      const description = url.searchParams.get('error_description') || oauthError;
      this.respond(response, 400, '授权未完成，可以关闭此页面。', () => {
        this.finishWithError(
          new OAuthLoopbackError('OAUTH_ERROR', `OAuth denied: ${description}`),
        );
      });
      return;
    }

    const code = url.searchParams.get('code');
    if (!code) {
      this.respond(response, 400, '回调缺少授权码，可以关闭此页面。', () => {
        this.finishWithError(
          new OAuthLoopbackError(
            'MISSING_CODE',
            'OAuth callback did not contain an authorization code.',
          ),
        );
      });
      return;
    }

    this.respond(response, 200, '飞书授权成功，可以关闭此页面。', () => {
      this.finishWithSuccess({ code, state });
    });
  }

  private respond(
    response: ServerResponse,
    status: number,
    message: string,
    after?: () => void,
  ): void {
    response.statusCode = status;
    response.end(
      `<!doctype html><meta charset="utf-8"><title>Todo Agent</title><p>${message}</p>`,
      after,
    );
  }

  private clearPending(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.expectedState = undefined;
    this.resolveCallback = undefined;
    this.rejectCallback = undefined;
  }

  private finishWithSuccess(callback: FeishuOAuthCallback): void {
    if (this.settled) return;
    this.settled = true;
    const resolve = this.resolveCallback;
    this.clearPending();
    void this.close().finally(() => resolve?.(callback));
  }

  private finishWithError(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    const reject = this.rejectCallback;
    this.clearPending();
    void this.close().finally(() => reject?.(error));
  }

  async cancel(message = 'OAuth authorization was cancelled.'): Promise<void> {
    if (!this.settled && this.rejectCallback) {
      this.settled = true;
      const reject = this.rejectCallback;
      this.clearPending();
      await this.close();
      reject(new OAuthLoopbackError('CANCELLED', message));
      return;
    }
    await this.close();
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const server = this.server;
    this.server = undefined;
    this.redirectUri = undefined;
    if (!server?.listening) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
}
