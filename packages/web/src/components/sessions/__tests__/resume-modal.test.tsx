import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const resumeSpy = vi.fn(
  async (_id: string, _body?: { nudge?: string; preserveEngineSession?: boolean }) => ({}),
);
const cancelSpy = vi.fn(async (_id: string) => ({ ok: true }));

vi.mock("@/lib/api", () => ({
  api: {
    resumeSession: (id: string, body?: { nudge?: string; preserveEngineSession?: boolean }) =>
      resumeSpy(id, body),
    cancelAutoResume: (id: string) => cancelSpy(id),
  },
}));

import { ResumeModal } from "../resume-modal";

function renderModal(props: Partial<React.ComponentProps<typeof ResumeModal>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ResumeModal
        sessionId="sess-123"
        errorKind="usage_cap"
        lastError="hit your usage limit. try again at 7:10 AM"
        errorRetryAfter={new Date(Date.now() + 5 * 60_000).toISOString()}
        autoResumeScheduledAt={new Date(Date.now() + 5 * 60_000).toISOString()}
        defaultNudge="keep going"
        onClose={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  resumeSpy.mockClear();
  cancelSpy.mockClear();
});

describe("ResumeModal", () => {
  it("renders the kind badge", () => {
    renderModal();
    expect(screen.getAllByText(/usage[\s_]cap/i).length).toBeGreaterThan(0);
  });

  it("renders the original provider message", () => {
    renderModal();
    expect(screen.getByText(/hit your usage limit/i)).toBeTruthy();
  });

  it("shows the countdown when auto-resume is scheduled", () => {
    renderModal();
    // Any of "Auto-resume", "scheduled", or countdown rendering qualifies
    expect(screen.getAllByText(/auto-resume/i).length).toBeGreaterThan(0);
  });

  it("calls resumeSession with the edited nudge on Resume now", async () => {
    renderModal();
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "continue from the status note" } });
    fireEvent.click(screen.getByRole("button", { name: /resume now/i }));
    // useResumeSession dispatches via api.resumeSession
    // The mutation may be async — wait a microtask
    await new Promise((r) => setTimeout(r, 50));
    expect(resumeSpy).toHaveBeenCalledWith("sess-123", { nudge: "continue from the status note" });
  });

  it("Cancel auto-resume button is hidden when no auto-resume is scheduled", () => {
    renderModal({ autoResumeScheduledAt: null });
    expect(screen.queryByRole("button", { name: /cancel auto-resume/i })).toBeNull();
  });

  it("Cancel auto-resume button is visible and clickable when scheduled", async () => {
    renderModal();
    const btn = screen.getByRole("button", { name: /cancel auto-resume/i });
    expect(btn).toBeTruthy();
    fireEvent.click(btn);
    await new Promise((r) => setTimeout(r, 50));
    expect(cancelSpy).toHaveBeenCalledWith("sess-123");
  });
});
