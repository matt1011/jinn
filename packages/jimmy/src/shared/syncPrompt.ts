export function buildClaudeSyncTranscriptPrompt(transcriptMessages: string[]): string {
  const transcript = transcriptMessages.slice(-20).join("\n\n");

  return [
    "We temporarily switched to GPT due to a Claude usage limit. You are now back on Claude.",
    "",
    "This work has already been attempted. Use the transcript below only to orient yourself to what happened and what the latest user asked for.",
    "",
    "Before acting, inspect the current codebase state and continue from the checked-out branch. Do not spend the turn broadly re-auditing for gaps or re-planning from scratch. Identify only blockers that materially affect implementation, then spend most of your effort finishing the requested development, updating files, and verifying the result.",
    "",
    "Transcript, most recent last:",
    "",
    transcript,
  ].join("\n");
}
