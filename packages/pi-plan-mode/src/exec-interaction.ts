import { randomUUID } from "node:crypto";
import type { InputEvent, InputSource, MessageEndEvent } from "@earendil-works/pi-coding-agent";
import { type NegotiationState, outstanding } from "./negotiation.js";

export interface PausePresentation {
  title: string;
  reason: string;
  next: string;
  question?: string;
}

function currentPause(n: NegotiationState) {
  if (n.phase !== "paused" || !n.pause) throw new Error("Execution is not paused.");
  return n.pause;
}

export function pausePresentation(n: NegotiationState): PausePresentation {
  const pause = currentPause(n);
  switch (pause.reason) {
    case "user_needed":
      return {
        title: "Waiting for your answer",
        reason: pause.action,
        question: pause.question,
        next: "Reply here. Ask for clarification if you need it; answering lets implementation continue.",
      };
    case "failure":
    case "interrupted":
      return {
        title: "Review did not finish",
        reason: pause.action,
        next: "Ask to retry the review, or discuss what happened. No retry has been authorized.",
      };
    case "exhausted":
      return {
        title: "Another revision needs your approval",
        reason: `Revisions used: ${n.revisionsUsed}. Outstanding findings: ${outstanding(n).length}.`,
        next: "Allow one more attempt, discuss the findings, or finish without review.",
      };
  }
}

export interface RecoveryChoice {
  action: "retry" | "extend" | "discuss" | "answer" | "accept" | "stop";
  label: string;
}

/** Actions describe choices, not authorization; callers must await the user's selection. */
export function recoveryChoices(n: NegotiationState): RecoveryChoice[] {
  const pause = currentPause(n);
  const first: RecoveryChoice[] =
    pause.reason === "user_needed"
      ? [{ action: "answer", label: "Answer in chat" }]
      : [
          pause.reason === "exhausted"
            ? { action: "extend", label: "Allow one more attempt" }
            : { action: "retry", label: "Retry review" },
          { action: "discuss", label: "Discuss first" },
        ];
  return [
    ...first,
    { action: "accept", label: "Finish without review" },
    { action: "stop", label: "Stop implementation" },
  ];
}

export interface EligibleReply {
  id: string;
  source: "interactive" | "rpc";
  text: string;
  executionId: string;
  exchangeId?: string;
}

interface PendingReply {
  source: InputSource;
  text: string;
  executionId: string;
  exchangeId?: string;
  eligible: boolean;
}

/**
 * Runtime-only authority. Pass the live negotiation to every event/read and sync on state transitions.
 * Call invalidate on reload, navigation and shutdown, even when restoring the same pause.
 * Returned replies are copies; consume returns captured text once, never model-supplied text.
 */
export class ExecReplyTracker {
  private pauseKey?: string;
  private pending?: PendingReply;
  private quarantined = false;
  private reply?: EligibleReply;

  sync(n: NegotiationState | undefined): void {
    const key =
      n?.phase === "paused" && n.pause?.reason === "user_needed"
        ? JSON.stringify([n.executionId, n.latestExchangeId, n.pause.question, n.pause.action])
        : undefined;
    if (key !== this.pauseKey) {
      this.invalidate();
      this.pauseKey = key;
    }
  }

  invalidate(): void {
    this.pauseKey = undefined;
    this.pending = undefined;
    this.quarantined = false;
    this.reply = undefined;
  }

  /** Only settlement proves that a queued batch has drained. */
  settled(): void {
    this.pending = undefined;
    this.quarantined = false;
    this.reply = undefined;
  }

  input(n: NegotiationState | undefined, event: InputEvent): void {
    this.sync(n);
    if (!this.pauseKey || !n) return;
    this.reply = undefined;
    if (this.quarantined) return;
    if (this.pending) {
      this.pending = undefined;
      this.quarantined = true;
      return;
    }
    this.pending = {
      source: event.source,
      text: event.text,
      executionId: n.executionId,
      exchangeId: n.latestExchangeId,
      eligible: Boolean(event.text.trim()) && !/^[/!]/u.test(event.text.trimStart()) && !event.images?.length,
    };
  }

  messageEnd(n: NegotiationState | undefined, event: MessageEndEvent): void {
    this.sync(n);
    if (event.message.role !== "user") return;
    // Every delivered user message supersedes any earlier authority, even if unmatched or image-only.
    this.reply = undefined;
    if (!this.pauseKey) return;
    const content = event.message.content;
    const text =
      typeof content === "string"
        ? content
        : content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
    const captured = this.pending;
    this.pending = undefined;
    if (this.quarantined) return;
    if (!captured || captured.text !== text) {
      this.quarantined = true;
      return;
    }
    if (!captured.eligible || captured.source === "extension") return;
    this.reply = {
      id: randomUUID(),
      source: captured.source,
      text: captured.text,
      executionId: captured.executionId,
      exchangeId: captured.exchangeId,
    };
  }

  eligible(n: NegotiationState | undefined): EligibleReply | undefined {
    this.sync(n);
    return this.reply ? { ...this.reply } : undefined;
  }

  consume(n: NegotiationState | undefined, replyId: string): EligibleReply | undefined {
    const reply = this.eligible(n);
    if (!reply || reply.id !== replyId) return undefined;
    this.reply = undefined;
    return reply;
  }
}
