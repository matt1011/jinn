"use client";

import { Suspense } from "react";
import { useRouter, useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { type Session } from "@/lib/api";
import { SessionDetail } from "@/components/sessions/session-detail";

function SessionDetailPageInner() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const sessionId = params?.id;

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
        onNavigate={(otherId) => router.push(`/sessions/${otherId}`)}
      />
    </div>
  );
}

export default function SessionDetailPage() {
  return (
    <Suspense
      fallback={
        <div style={{ padding: 24, fontFamily: "var(--font-sans, system-ui)" }}>
          Loading session...
        </div>
      }
    >
      <SessionDetailPageInner />
    </Suspense>
  );
}
