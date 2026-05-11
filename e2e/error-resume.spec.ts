import { test, expect } from "@playwright/test";

// Gateway URL used for API-contract assertions. Defaults match the project's
// Playwright webServer / dev-instance conventions and can be overridden in CI.
const GATEWAY = process.env.JINN_GATEWAY_URL ?? "http://localhost:7779";
const WEB = process.env.JINN_WEB_URL ?? "http://localhost:7779";

// The gateway must be running with JINN_E2E=1 for the PUT /api/sessions/:id
// error-state seeding fields to be accepted. Either run Playwright with
// JINN_E2E_START_GATEWAY=1 (see playwright.config.ts) or start the gateway
// externally with `JINN_E2E=1 node packages/jimmy/dist/bin/jimmy.js start --port 7779`.

test.describe("Recoverable session resume flow", () => {
  test("API contract: PUT seeds error state, POST /resume clears it", async ({ request }) => {
    // 1. Create a fresh stub session — no engine is spawned for stub sessions.
    const created = await request.post(`${GATEWAY}/api/sessions/stub`, {
      data: { engine: "claude", title: "E2E error-resume session" },
    });
    expect(created.ok()).toBeTruthy();
    const session = (await created.json()) as { id: string };
    expect(typeof session.id).toBe("string");

    // 2. Seed the session into recoverable-error state via the E2E-only PUT extension.
    //    If this fails with 400, the gateway is not running with JINN_E2E=1.
    const retryAt = new Date(Date.now() + 5 * 60_000).toISOString();
    const patched = await request.put(`${GATEWAY}/api/sessions/${session.id}`, {
      data: {
        status: "error",
        lastError: "You've hit your usage limit. Try again at 7:10 AM.",
        errorKind: "usage_cap",
        errorRecoverable: true,
        errorRetryAfter: retryAt,
      },
    });
    if (!patched.ok()) {
      const body = await patched.text().catch(() => "");
      throw new Error(
        `PUT to seed error state failed (${patched.status()}). ` +
          `Is the gateway running with JINN_E2E=1? Response: ${body.slice(0, 200)}`,
      );
    }
    const seeded = (await patched.json()) as {
      status: string;
      lastError: string | null;
      errorKind: string | null;
      errorRecoverable: boolean | null;
    };
    expect(seeded.status).toBe("error");
    expect(seeded.errorKind).toBe("usage_cap");
    expect(seeded.errorRecoverable).toBe(true);
    expect(seeded.lastError).toContain("usage limit");

    // 3. Confirm the session appears on GET /api/sessions/recoverable.
    const recoverableResp = await request.get(`${GATEWAY}/api/sessions/recoverable`);
    expect(recoverableResp.ok()).toBeTruthy();
    const recoverable = (await recoverableResp.json()) as Array<{ sessionId: string; errorKind: string }>;
    const ourEntry = recoverable.find((r) => r.sessionId === session.id);
    expect(ourEntry, "seeded session should appear in /api/sessions/recoverable").toBeDefined();
    expect(ourEntry!.errorKind).toBe("usage_cap");

    // 4. Hit POST /api/sessions/:id/resume with a nudge. This will clear the error
    //    state and dispatch a message via the gateway. The dispatch may fail in the
    //    hermetic env (no live engine), but the registry side-effect is what we test.
    const resumeResp = await request.post(`${GATEWAY}/api/sessions/${session.id}/resume`, {
      data: { nudge: "continue from where you left off" },
    });
    // Resume may return 200 if dispatch succeeds, or 5xx if dispatch fails because
    // the engine cannot actually run in the test sandbox. Either way the registry
    // is updated *before* dispatch is awaited, so we re-read state to verify.
    expect([200, 500, 502].includes(resumeResp.status())).toBeTruthy();

    // 5. Re-read the session; the recoverable-error fields should be cleared.
    const afterResp = await request.get(`${GATEWAY}/api/sessions/${session.id}`);
    expect(afterResp.ok()).toBeTruthy();
    const after = (await afterResp.json()) as {
      status: string;
      lastError: string | null;
      errorKind: string | null;
      errorRecoverable: boolean | null;
      errorRetryAfter: string | null;
    };
    // Cleared fields may serialize as either null or undefined (JSON drops
    // undefined keys); both indicate a clean recoverable-error reset.
    expect(after.lastError ?? null).toBeNull();
    expect(after.errorKind ?? null).toBeNull();
    expect(after.errorRecoverable ?? null).toBeNull();
    expect(after.errorRetryAfter ?? null).toBeNull();
    // status will be "running" (resume sets it) or "error" again if dispatch
    // re-applied an engine error — but never the original recoverable error.
    expect(after.status).not.toBe("error");

    // Cleanup.
    await request.delete(`${GATEWAY}/api/sessions/${session.id}`).catch(() => {});
  });

  // SessionDetail is mounted at /sessions/[id] (packages/web/src/app/sessions/[id]/page.tsx),
  // so this flow is reachable in the running web app. Component-level coverage lives in
  // `packages/web/src/components/sessions/__tests__/session-detail-resume.test.tsx`.
  test("UI: error chip opens modal; Resume now dispatches and dismisses", async ({
    page,
    request,
  }) => {
    const created = await request.post(`${GATEWAY}/api/sessions/stub`, {
      data: { engine: "claude", title: "E2E error-resume UI" },
    });
    const session = (await created.json()) as { id: string };
    await request.put(`${GATEWAY}/api/sessions/${session.id}`, {
      data: {
        status: "error",
        lastError: "You've hit your usage limit. Try again at 7:10 AM.",
        errorKind: "usage_cap",
        errorRecoverable: true,
        errorRetryAfter: new Date(Date.now() + 5 * 60_000).toISOString(),
      },
    });

    await page.goto(`${WEB}/sessions?id=${session.id}`);

    const chip = page.getByTestId("error-chip");
    await expect(chip).toBeVisible({ timeout: 10_000 });
    await chip.click();

    await expect(page.getByText(/resume session/i)).toBeVisible();
    const textarea = page.getByRole("textbox");
    await textarea.fill("continue from where you left off");

    const [resumeReq] = await Promise.all([
      page.waitForRequest(
        (req) => req.url().includes(`/api/sessions/${session.id}/resume`) && req.method() === "POST",
        { timeout: 5_000 },
      ),
      page.getByRole("button", { name: /resume now/i }).click(),
    ]);
    const body = JSON.parse(resumeReq.postData() ?? "{}");
    expect(body.nudge).toBe("continue from where you left off");

    await expect(page.getByTestId("error-chip")).toBeHidden({ timeout: 10_000 });
  });
});
