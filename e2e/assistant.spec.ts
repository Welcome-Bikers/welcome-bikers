import { expect, test } from "@playwright/test";
import { fulfillChatJson, mockProxyBase, mockProxyChat, mockProxySpeech } from "./helpers/mockProxy";

test.describe("Real Bro assistant", () => {
  test("opens from the main page with a greeting and text input", async ({ page }) => {
    await page.goto("/#/");
    const row = page.getByTestId("assistant-row");
    await expect(row).toBeVisible();
    await expect(row).toContainText("AI assistant");
    await expect(row).toContainText("Real Bro");
    await row.tap();
    await expect(page.getByTestId("assistant-sheet")).toBeVisible();
    await expect(page.locator(".rb-bubble.bro").first()).toContainText(/Yo, bro/i);
    await expect(page.locator(".rb-state")).toHaveText("Ready");
    await expect(page.getByTestId("assistant-input")).toBeVisible();
  });

  test("answers in English with place cards and rides to one", async ({ page }) => {
    await page.goto("/#/");
    await page.getByTestId("assistant-row").tap();
    await page.getByTestId("assistant-input").fill("what bars are in Montenegro?");
    await page.getByTestId("assistant-send").tap();

    const cards = page.locator('[data-testid="assistant-card"]');
    await expect(cards.first()).toBeVisible({ timeout: 15_000 });
    expect(await cards.count()).toBeGreaterThanOrEqual(3);
    const answer = page.locator(".rb-bubble.bro").last();
    await expect(answer).toContainText(/bikers bars/i);
    await expect(answer).toContainText(/Montenegro/i);
    await expect(answer).not.toContainText(/[а-яё]/i);

    const firstName = await cards.first().locator("b").textContent();
    await cards.first().getByTestId("assistant-ride").tap();
    await expect(page).toHaveURL(/\/#\/map\?to=[\d.-]+,[\d.-]+&name=/);
    expect(firstName?.length).toBeGreaterThan(0);
  });

  test("finds a known place from the base for a ride request", async ({ page }) => {
    await page.goto("/#/");
    await page.getByTestId("assistant-row").tap();
    await page.getByTestId("assistant-input").fill("ride to Magnus Moto");
    await page.getByTestId("assistant-input").press("Enter");
    const card = page.locator('[data-testid="assistant-card"]').first();
    await expect(card).toContainText("Magnus Moto", { timeout: 15_000 });
    await expect(card.getByTestId("assistant-ride")).toBeVisible();
  });

  test("answers unclear chat with OpenRouter Real Bro AI", async ({ page }) => {
    await mockProxyBase(page);
    await mockProxyChat(page, async (route) => {
      await fulfillChatJson(route, {
        reply:
          'Weather? Bro, I am not AccuWeather. Say "ride to Podgorica" to build a route, or ask what bars are in Montenegro.',
        intent: "chat",
      });
    });
    await page.goto("/#/");
    await page.getByTestId("assistant-row").tap();
    await page.getByTestId("assistant-input").fill("how is the weather?");
    await page.getByTestId("assistant-send").tap();
    await expect(page.locator(".rb-bubble.bro").last()).toContainText(/build a route/i, { timeout: 15_000 });
    await expect(page.locator(".rb-state")).toHaveText("Online");
  });

  test("labels local fallback honestly when the live provider is unavailable", async ({ page }) => {
    await page.route("**/health*", (route) => route.abort());
    await page.route("**/or-proxy.json*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: '{"base":""}' }),
    );
    await page.goto("/#/");
    await page.getByTestId("assistant-row").tap();
    await page.getByTestId("assistant-input").fill("hello");
    await page.getByTestId("assistant-send").tap();
    await expect(page.locator(".rb-bubble.bro").last()).toContainText(/Live AI is offline/i);
    await expect(page.locator(".rb-state")).toHaveText("Offline mode");
  });

  test("processes every queued message once and in order", async ({ page }) => {
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
    await mockProxySpeech(page);
    const received: string[] = [];
    await mockProxyChat(page, async (route, lastUserText) => {
      received.push(lastUserText);
      if (received.length === 1) await new Promise((resolve) => setTimeout(resolve, 250));
      await fulfillChatJson(route, { reply: `Reply ${received.length}: ${lastUserText}`, intent: "chat" });
    });

    await page.goto("/#/");
    await page.getByTestId("assistant-row").tap();
    const input = page.getByTestId("assistant-input");
    for (const text of ["queue alpha", "queue beta", "queue gamma"]) {
      await input.fill(text);
      await page.getByTestId("assistant-send").tap();
    }

    await expect(page.locator(".rb-bubble.bro").filter({ hasText: "Reply 3: queue gamma" })).toBeVisible();
    expect(received).toEqual(["queue alpha", "queue beta", "queue gamma"]);
    const answers = await page.locator(".rb-bubble.bro").allTextContents();
    expect(answers.filter((text) => /^Reply \d:/.test(text))).toEqual([
      "Reply 1: queue alpha",
      "Reply 2: queue beta",
      "Reply 3: queue gamma",
    ]);
  });

  test("closing Real Bro cancels a delayed provider reply", async ({ page }) => {
    await mockProxyBase(page);
    await mockProxyChat(page, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 700));
      await fulfillChatJson(route, { reply: "This reply should be cancelled.", intent: "chat" }).catch(() => undefined);
    });
    await page.goto("/#/");
    await page.getByTestId("assistant-row").tap();
    await page.getByTestId("assistant-input").fill("give me a delayed reply");
    await page.getByTestId("assistant-send").tap();
    await page.getByLabel("Close assistant").tap();
    await page.waitForTimeout(900);

    await page.getByTestId("assistant-row").tap();
    await expect(page.locator(".rb-bubble.bro").filter({ hasText: "This reply should be cancelled." })).toHaveCount(0);
    await expect(page.getByTestId("assistant-send")).toBeEnabled();
  });

  test("records in English and shows a live waveform", async ({ page }) => {
    await page.addInitScript(() => {
      // Exercise the Web Speech fallback even though the test project emulates Android.
      Object.defineProperty(window, "MediaRecorder", { value: undefined, configurable: true });
      class FakeRecognition {
        lang = "";
        continuous = false;
        interimResults = false;
        maxAlternatives = 1;
        onresult = null;
        onerror = null;
        onend: (() => void) | null = null;
        start() {
          const w = window as unknown as {
            __recognitionLang?: string;
            __recognitionContinuous?: boolean;
            __recognitionInterim?: boolean;
          };
          w.__recognitionLang = this.lang;
          w.__recognitionContinuous = this.continuous;
          w.__recognitionInterim = this.interimResults;
        }
        stop() {
          this.onend?.();
        }
      }
      Object.defineProperty(window, "SpeechRecognition", { value: FakeRecognition, configurable: true });
    });
    await page.goto("/#/");
    await page.getByTestId("assistant-row").tap();
    await page.getByLabel("Voice input").tap();
    await expect(page.getByTestId("assistant-waveform")).toBeVisible();
    await expect(page.locator(".rb-state")).toHaveText("Listening…");
    expect(
      await page.evaluate(() => (window as unknown as { __recognitionLang?: string }).__recognitionLang),
    ).toBe("en-US");
    expect(
      await page.evaluate(() => (window as unknown as { __recognitionContinuous?: boolean }).__recognitionContinuous),
    ).toBe(false);
    expect(
      await page.evaluate(() => (window as unknown as { __recognitionInterim?: boolean }).__recognitionInterim),
    ).toBe(true);

    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await expect(page.locator(".rb-state")).toHaveText("Listening…");
  });
});
