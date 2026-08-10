// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

import {
  FEISHU_APP_REGISTRATION_USER_SCOPES,
  FeishuAppRegistrationError,
  startFeishuAppRegistration,
  type FeishuAppRegistrationDependencies,
} from "../electron/feishu/feishu-app-registration";

type RegistrationRunner = NonNullable<
  FeishuAppRegistrationDependencies["registerApp"]
>;

describe("Feishu one-click app registration", () => {
  it("requests only the required user scopes and exposes verification and credentials", async () => {
    const now = 1_800_000_000_000;
    const registerApp: RegistrationRunner = vi.fn(async (options) => {
      options.onQRCodeReady({
        url: "https://accounts.feishu.cn/device?user_code=ABCD",
        expireIn: 600,
      });
      return {
        client_id: "cli_personal",
        client_secret: "personal-secret",
        user_info: {
          open_id: "ou_owner",
          tenant_brand: "feishu" as const,
        },
      };
    });

    const session = startFeishuAppRegistration({
      registerApp,
      now: () => now,
    });

    await expect(session.verification).resolves.toEqual({
      verificationUrl:
        "https://accounts.feishu.cn/device?user_code=ABCD",
      expiresAt: now + 600_000,
    });
    await expect(session.result).resolves.toEqual({
      client_id: "cli_personal",
      client_secret: "personal-secret",
      open_id: "ou_owner",
      tenant_brand: "feishu",
    });

    expect(registerApp).toHaveBeenCalledOnce();
    const options = vi.mocked(registerApp).mock.calls[0][0];
    expect(options).toMatchObject({
      source: "todo-agent-desktop",
      createOnly: true,
      appPreset: {
        name: "Todo Agent - {user}",
      },
      addons: {
        preset: false,
        scopes: {
          user: [...FEISHU_APP_REGISTRATION_USER_SCOPES],
        },
      },
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal?.aborted).toBe(false);
  });

  it("rejects verification and result predictably when cancelled", async () => {
    let signal: AbortSignal | undefined;
    const registerApp: RegistrationRunner = vi.fn(
      (options) =>
        new Promise<never>((_resolve, reject) => {
          signal = options.signal;
          options.signal?.addEventListener(
            "abort",
            () => reject(new Error("SDK aborted")),
            { once: true },
          );
        }),
    );
    const session = startFeishuAppRegistration({ registerApp });
    const verificationRejection = expect(
      session.verification,
    ).rejects.toMatchObject({ code: "abort" });
    const resultRejection = expect(session.result).rejects.toMatchObject({
      code: "abort",
    });

    session.cancel();
    session.cancel();

    await verificationRejection;
    await resultRejection;
    expect(signal?.aborted).toBe(true);
  });

  it("propagates an SDK failure to verification and result", async () => {
    const denied = Object.assign(new Error("User rejected the request"), {
      code: "access_denied",
      description: "User rejected the request",
    });
    const registerApp: RegistrationRunner = vi.fn(async () => {
      throw denied;
    });
    const session = startFeishuAppRegistration({ registerApp });

    await expect(session.verification).rejects.toBe(denied);
    await expect(session.result).rejects.toBe(denied);
  });

  it("rejects an SDK result that skipped the verification callback", async () => {
    const registerApp: RegistrationRunner = vi.fn(async () => ({
      client_id: "cli_missing_verification",
      client_secret: "secret",
    }));
    const session = startFeishuAppRegistration({ registerApp });

    await expect(session.verification).rejects.toMatchObject({
      code: "invalid_response",
    });
    await expect(session.result).rejects.toBeInstanceOf(
      FeishuAppRegistrationError,
    );
    await expect(session.result).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("rejects a verification URL outside Feishu or Lark", async () => {
    const registerApp: RegistrationRunner = vi.fn(async (options) => {
      options.onQRCodeReady({
        url: "https://feishu.example/steal-credentials",
        expireIn: 600,
      });
      return {
        client_id: "cli_untrusted_url",
        client_secret: "must-not-be-exposed",
      };
    });
    const session = startFeishuAppRegistration({ registerApp });

    await expect(session.verification).rejects.toMatchObject({
      code: "invalid_response",
    });
    await expect(session.result).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});
