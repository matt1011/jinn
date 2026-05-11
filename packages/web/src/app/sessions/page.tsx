"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { type Session } from "@/lib/api";
import { SessionDetail } from "@/components/sessions/session-detail";

function SessionsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = searchParams?.get("id") ?? null;

  // No id → behave like the legacy redirect.
  useEffect(() => {
    if (!sessionId) router.replace("/chat");
  }, [sessionId, router]);

  const { data: session, isLoading, error } = useQuery({
    queryKey: ["sessions", sessionId],
    queryFn: async (): Promise<Session> => {
      const res = await fetch(`/api/sessions/${sessionId}`);
      if (!res.ok) throw new Error(`Session not found (HTTP ${res.status})`);
      return (await res.json()) as Session;
    },
    enabled: !!sessionId,
    refetchInterval: 5_000,
  });

  if (!sessionId) {
    // Render nothing while the redirect effect runs.
    return null;
  }

  if (isLoading) {
    return (
      <div style={{ padding: 24, fontFamily: "var(--font-sans, system-ui)" }}>
        Loading session...
      </div>
    );
  }

  if (error || !session) {
    return (
      <div style={{ padding: 24, fontFamily: "var(--font-sans, system-ui)" }}>
        <p>Session not found.</p>
        <button onClick={() => router.push("/chat")}>Back to chat</button>
      </div>
    );
  }

  return (
    <div style={{ padding: 24 }}>
      <SessionDetail
        session={session}
        onClose={() => router.push("/chat")}
        onNavigate={(otherId) => router.push(`/sessions?id=${otherId}`)}
      />
    </div>
  );
}

export default function SessionsPage() {
  return (
    <Suspense
      fallback={
        <div style={{ padding: 24, fontFamily: "var(--font-sans, system-ui)" }}>
          Loading...
        </div>
      }
    >
      <SessionsPageInner />
    </Suspense>
  );
}
