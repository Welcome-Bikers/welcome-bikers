import { expect, test } from "@playwright/test";
import { fulfillChatJson, mockProxyBase, mockProxyChat, mockProxySpeech } from "./helpers/mockProxy";

test("Real Bro opens silently and only voices an actual reply", async ({ page }) => {
  let ttsHits = 0;
  let lastBody: Record<string, unknown> | null = null;

  await mockProxyBase(page);
  await mockProxySpeech(page, (body) => {
    ttsHits += 1;
    lastBody = body;
  });

  await mockProxyChat(page, async (route) => {
    await fulfillChatJson(route, {
      reply: "Yeah bro, I am the Real Bro AI. Lets roll.",
      intent: "chat",
    });
  });

  await page.goto("/#/");
  await page.getByTestId("assistant-row").tap();
  await page.waitForTimeout(300);
  expect(ttsHits).toBe(0);
  await page.getByTestId("assistant-input").fill("hello are you ai?");
  await page.getByTestId("assistant-send").tap();
  await expect.poll(() => ttsHits, { timeout: 15_000 }).toBe(1);

  expect(lastBody?.model).toBeTruthy();
  expect(String(lastBody?.voice || "")).toMatch(/DeepVoice|odysseus|Charon|fenrir|apollo/i);
  expect(lastBody?.input).toBeTruthy();
});

test("shows the complete answer when reply audio actually starts", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value() {
        const media = this as HTMLMediaElement;
        if (media.src.startsWith("data:audio/wav")) return Promise.resolve();
        window.setTimeout(() => {
          (window as unknown as { __replyAudioStarted?: boolean }).__replyAudioStarted = true;
          media.dispatchEvent(new Event("playing"));
        }, 350);
        window.setTimeout(() => media.dispatchEvent(new Event("ended")), 650);
        return Promise.resolve();
      },
    });
  });
  await mockProxyBase(page);
  await mockProxySpeech(page);
  await mockProxyChat(page, async (route) => {
    await fulfillChatJson(route, {
      reply: "Voice and text start together.",
      intent: "chat",
    });
  });

  await page.goto("/#/");
  await page.getByTestId("assistant-row").tap();
  await page.getByTestId("assistant-input").fill("test synchronized delivery");
  await page.getByTestId("assistant-send").tap();

  const answer = page.locator(".rb-bubble.bro").filter({ hasText: "Voice and text start together." });
  await expect(answer).toHaveCount(0);
  await expect.poll(() =>
    page.evaluate(() => Boolean((window as unknown as { __replyAudioStarted?: boolean }).__replyAudioStarted)),
  ).toBe(true);
  await expect(answer).toBeVisible();
  await expect(page.locator(".rb-state")).toHaveText(/Speaking|Online/);
});

test("tries the next speech provider after an upstream failure", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(HTMLMediaElement.prototype, "play", {
      configurable: true,
      value() {
        const media = this as HTMLMediaElement;
        if (!media.src.startsWith("data:audio/wav")) {
          queueMicrotask(() => media.dispatchEvent(new Event("playing")));
          window.setTimeout(() => media.dispatchEvent(new Event("ended")), 20);
        }
        return Promise.resolve();
      },
    });
  });
  await mockProxyBase(page);
  const models: string[] = [];
  await page.route(/\/speech\/?$/, async (route) => {
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };
    if (route.request().method() === "OPTIONS") {
      await route.fulfill({ status: 204, headers });
      return;
    }
    const body = route.request().postDataJSON() as { model?: string };
    models.push(String(body.model || ""));
    if (models.length === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        headers,
        body: '{"error":"provider unavailable"}',
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "audio/mpeg",
      headers,
      body: Buffer.from([0xff, 0xfb, 0x90, 0x00]),
    });
  });
  await mockProxyChat(page, async (route) => {
    await fulfillChatJson(route, { reply: "Provider failover works.", intent: "chat" });
  });

  await page.goto("/#/");
  await page.getByTestId("assistant-row").tap();
  await page.getByTestId("assistant-input").fill("test provider failover");
  await page.getByTestId("assistant-send").tap();

  await expect.poll(() => models.length).toBe(2);
  expect(models[0]).not.toBe(models[1]);
  await expect(page.locator(".rb-bubble.bro").filter({ hasText: "Provider failover works." })).toBeVisible();
});
