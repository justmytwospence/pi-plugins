import { randomUUID } from "node:crypto";
import { type ExtensionContext, getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { PlanMarkdown } from "./mermaid-art.js";
import { type DiffLine, renderPlanDiff } from "./plan-diff.js";
import { planTitle } from "./plan-file.js";
import { formatCost } from "./planners.js";
import { COLLAPSED_LINES, type ReviewTone, reviewStatusLine, reviewTitle } from "./review-card.js";

export interface ExchangeIdentity {
  executionId?: string;
  exchangeId?: string;
  unresolvedReviewId?: string;
}
export interface AskDetails extends ExchangeIdentity {
  question: string;
  reply?: string;
  planner: string;
  number?: number;
  changes?: DiffLine[];
  costUsd?: number;
  pending?: boolean;
  activity?: string;
  error?: string;
}
export interface ChangeSummary {
  edited: string[];
  outside: string[];
  git?: string;
}
export interface CardFinding {
  id: string;
  title: string;
  detail: string;
  requestedChange: string;
}
export interface CardResponse {
  id: string;
  status: string;
  response: string;
}
export interface CardDecision {
  outcome: "accepted" | "changes_requested" | "user_needed";
  summary: string;
  evidence: string[];
  limitations: string[];
  findings: CardFinding[];
  question?: string;
  recommendation?: string;
}
export type CompletionAssessment =
  | { state: "reviewed"; planner: string; narrative: string; verdict: "done" | "changes" | "unclear"; costUsd: number }
  | { state: "disabled" }
  | { state: "unavailable"; reason: string }
  | { state: "failed"; reason: string; costUsd?: number };
export interface FinishDetails extends ExchangeIdentity {
  report: string;
  verification?: string;
  concerns?: string;
  assessment?: CompletionAssessment;
  pending?: boolean;
  activity?: string;
  planFile: string;
  changes?: ChangeSummary;
  implementer?: string;
  returnedTo?: string;
  headline?: string;
  asks?: number;
  costUsd?: number;
  round?: number;
  decision?: CardDecision;
  responses?: CardResponse[];
  previousFindings?: CardFinding[];
  completion?: "accepted" | "no_review" | "user_override" | "stopped";
  error?: string;
  question?: string;
  action?: string;
  negotiation?: {
    attempts: number;
    reviewCostUsd: number;
    phase: string;
    history: {
      report?: unknown;
      decision?: CardDecision;
      responses?: CardResponse[];
      error?: string;
      costUsd?: number;
    }[];
    pause?: { reason?: string; action?: string; question?: string };
  };
}
export type CurrentExchange = () => ExchangeIdentity | undefined;

/** Mounted results consult current execution state on every frame; historical details stay immutable. */
function dynamic(build: () => Component): Component {
  return { render: (width) => build().render(width), invalidate() {} };
}
function isCurrent(details: ExchangeIdentity, current?: CurrentExchange): boolean | undefined {
  if (!details.executionId || !details.exchangeId || !current) return undefined;
  const value = current();
  return (
    value?.executionId === details.executionId &&
    (value.exchangeId === details.exchangeId || value.unresolvedReviewId === details.exchangeId)
  );
}
function section(container: Container, theme: Theme, label: string, value: string) {
  if (container.children.length) container.addChild(new Spacer(1));
  container.addChild(reviewTitle(theme, label));
  container.addChild(new PlanMarkdown(value, getMarkdownTheme(), theme));
}
function folded(container: Container, theme: Theme, value: string, full: boolean) {
  const lines = value.split("\n");
  container.addChild(
    new PlanMarkdown(full ? value : lines.slice(0, COLLAPSED_LINES).join("\n"), getMarkdownTheme(), theme),
  );
  if (!full && lines.length > COLLAPSED_LINES)
    container.addChild(
      new Text(theme.fg("dim", `… ${lines.length - COLLAPSED_LINES} more lines (ctrl+o to expand)`), 0, 0),
    );
}
function status(container: Container, theme: Theme, label: string, tone: ReviewTone, context?: string) {
  container.addChild(new Spacer(1));
  container.addChild(new Text(reviewStatusLine(theme, { text: label, tone, context }), 0, 0));
}

export function renderAsk(
  details: AskDetails | undefined,
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  current?: CurrentExchange,
): Component {
  return dynamic(() => {
    const body = new Container();
    if (!details) return body;
    // A completed consultation always previews its actual first paragraph; only pending replies
    // need the full activity view. Consultations have no unresolved findings to keep expanded.
    void current;
    const full = options.expanded || details.pending;
    body.addChild(reviewTitle(theme, `Consultation ${details.number ?? ""}`.trim()));
    section(body, theme, "Question", details.question);
    if (details.pending) {
      section(body, theme, "Planner decision", `Planner thinking…${details.activity ? ` ${details.activity}` : ""}`);
    } else if (details.error || !details.reply?.trim()) {
      section(body, theme, "Consultation unavailable", details.error || "The planner returned no decision.");
    } else {
      section(body, theme, "Planner decision", full ? details.reply : details.reply.split(/\n\s*\n/u)[0]);
      if (!full && details.reply.includes("\n\n")) body.addChild(new Text(theme.fg("dim", "ctrl+o to expand"), 0, 0));
    }
    if (full && details.changes?.length) {
      body.addChild(new Spacer(1));
      body.addChild(reviewTitle(theme, "Plan amendment"));
      body.addChild(new Text(renderPlanDiff(theme, details.changes), 0, 0));
    }
    status(
      body,
      theme,
      details.pending
        ? "Planner thinking…"
        : details.error || !details.reply?.trim()
          ? "Consultation unavailable"
          : "Planner answered",
      details.pending ? "pending" : details.error || !details.reply?.trim() ? "error" : "warning",
      `${details.planner}${details.costUsd !== undefined ? ` · ${formatCost(details.costUsd)}` : ""}`,
    );
    return body;
  });
}

export function finishTone(details: FinishDetails | undefined): ReviewTone {
  if (details?.pending) return "pending";
  if (details?.completion === "accepted") return "success";
  if (details?.completion) return "warning";
  if (details?.error || details?.assessment?.state === "failed" || details?.assessment?.state === "unavailable")
    return "error";
  if (details?.decision?.outcome === "accepted") return "success";
  return "warning";
}
export function assessmentSummary(details: FinishDetails | undefined): string {
  if (details?.pending) return "Reviewing";
  switch (details?.completion) {
    case "accepted":
      return "Accepted";
    case "no_review":
      return "Completed without review";
    case "user_override":
      return "Completed by user override";
    case "stopped":
      return "Implementation stopped";
  }
  if (details?.error) return `Review unavailable: ${details.error}`;
  if (details?.decision)
    return (
      { accepted: "Accepted", changes_requested: "Changes requested", user_needed: "User input needed" } as const
    )[details.decision.outcome];
  const assessment = details?.assessment;
  if (!assessment) return "Review unavailable: no planner assessment was recorded.";
  switch (assessment.state) {
    case "disabled":
      return "Completed without review";
    case "unavailable":
      return `Review unavailable: ${assessment.reason}`;
    case "failed":
      return `Review unavailable: ${assessment.reason}`;
    case "reviewed":
      return `${assessment.planner} · ${assessment.verdict === "done" ? "Legacy assessment: done" : assessment.verdict === "changes" ? "Changes requested" : "Legacy assessment: unclear"}`;
  }
}
export function finishContext(details: FinishDetails | undefined): string {
  const asks = details?.asks ?? 0;
  const rounds = details?.negotiation?.attempts ?? details?.round ?? 0;
  const cost =
    details?.negotiation?.reviewCostUsd ??
    (details?.assessment && "costUsd" in details.assessment ? details.assessment.costUsd : 0);
  return [
    details?.planFile ? planTitle(details.planFile) : "Plan",
    details?.returnedTo && details.returnedTo !== details.implementer
      ? `${details.implementer ?? "Unknown implementer"} → ${details.returnedTo}`
      : (details?.implementer ?? "Unknown implementer"),
    `${asks} ${asks === 1 ? "consultation" : "consultations"} · ${formatCost(details?.costUsd ?? 0)}`,
    `${rounds} ${rounds === 1 ? "review" : "reviews"} · ${formatCost(cost ?? 0)}`,
  ].join(" · ");
}
export function changeSummaryText(changes: ChangeSummary | undefined): string {
  return [
    `Files edited: ${changes?.edited?.join(", ") || "none recorded"}`,
    `Not in the plan: ${changes?.outside?.join(", ") || "none recorded"}`,
    `git diff against HEAD: ${changes?.git || "no summary available (does not rule out committed work)"}`,
  ].join("\n");
}

/** A literal preview, never a generated summary. Limits count logical, not wrapped, lines. */
export function completionPreview(
  text: string,
  maxLines: number,
  maxChars: number,
): { text: string; truncated: boolean } {
  const normalized = text
    .trim()
    .replace(/\r\n?/gu, "\n")
    .replace(/\n[\t ]*\n(?:[\t ]*\n)*/gu, "\n\n");
  if (maxLines <= 0 || maxChars <= 0) return { text: "", truncated: !!normalized };
  const lines = normalized.split("\n").slice(0, Math.max(0, maxLines)).join("\n");
  let preview = lines.slice(0, Math.max(0, maxChars));
  const truncated = preview.length < normalized.length;
  if (truncated) {
    preview = preview.slice(0, Math.max(0, maxChars - 1)).trimEnd();
    if (preview.length < lines.length && /\S/u.test(lines[preview.length] ?? "")) {
      const boundary = preview.search(/\s+\S*$/u);
      if (boundary > 0) preview = preview.slice(0, boundary);
    }
    preview = `${preview.trimEnd()}…`;
  }
  return { text: preview, truncated };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function items(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
export function decisionText(value: unknown): string {
  const decision = record(value);
  return [
    string(decision.outcome) && `Decision: ${string(decision.outcome)}`,
    string(decision.summary),
    ...["evidence", "limitations"].flatMap((key) =>
      items(decision[key]).length
        ? [
            key === "evidence" ? "Reviewed evidence" : "Limitations",
            ...items(decision[key]).map((item) => `- ${string(item)}`),
          ]
        : [],
    ),
    ...items(decision.findings).flatMap((value) => {
      const finding = record(value);
      return [
        `Finding ${string(finding.id)}: ${string(finding.title)}`,
        string(finding.detail),
        `Requested change: ${string(finding.requestedChange)}`,
      ];
    }),
    string(decision.question) && `Question: ${string(decision.question)}`,
    string(decision.recommendation) && `Recommendation: ${string(decision.recommendation)}`,
  ]
    .filter(Boolean)
    .join("\n");
}
export function responsesText(value: unknown): string {
  return items(value)
    .map((value) => {
      const response = record(value);
      return `Response ${string(response.id)} (${string(response.status)}): ${string(response.response)}`;
    })
    .join("\n");
}
/** Readable substantive fields, with structural checks for historical persisted entries. */
export function negotiationText(value: unknown): string {
  const negotiation = record(value);
  if (!Object.keys(negotiation).length) return "";
  const pause = record(negotiation.pause);
  return [
    `Review history (${typeof negotiation.attempts === "number" ? negotiation.attempts : items(negotiation.history).length} review rounds; cumulative review cost ${formatCost(typeof negotiation.reviewCostUsd === "number" ? negotiation.reviewCostUsd : 0)})`,
    string(negotiation.phase) && `Phase: ${string(negotiation.phase)}`,
    typeof negotiation.revisionsUsed === "number" && `Revisions used: ${negotiation.revisionsUsed}`,
    typeof negotiation.maxRevisions === "number" && `Revision limit: ${negotiation.maxRevisions}`,
    typeof negotiation.revisionAuthorized === "boolean" && `Revision authorized: ${negotiation.revisionAuthorized}`,
    ...items(negotiation.userAnswers).map((answer) => `User-provided answer: ${string(answer)}`),
    ...items(negotiation.history).map((value, index) => {
      const attempt = record(value);
      const report = record(attempt.report);
      return [
        `Review ${index + 1}`,
        "Implementer report",
        typeof attempt.report === "string" ? attempt.report : string(report.report),
        string(report.verification) && `Verification (implementer reported):\n${string(report.verification)}`,
        string(report.concerns) && `Outstanding issues (implementer reported):\n${string(report.concerns)}`,
        responsesText(attempt.responses),
        decisionText(attempt.decision),
        string(attempt.error) && `Review error: ${string(attempt.error)}`,
        typeof attempt.costUsd === "number" && `Review cost: ${formatCost(attempt.costUsd)}`,
      ]
        .filter(Boolean)
        .join("\n\n");
    }),
    string(pause.reason) && `Pause reason: ${string(pause.reason)}`,
    string(pause.action) && `Next action: ${string(pause.action)}`,
    string(pause.question) && `Question: ${string(pause.question)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
export function finishTitle(details: FinishDetails | undefined): string {
  if (!details) return "Implementation review unavailable";
  return `${details.completion ? "Implementation" : `Review ${details.round ?? details.negotiation?.attempts ?? 1}`} · ${assessmentSummary(details)}`;
}

export function renderFinish(
  details: FinishDetails | undefined,
  options: { expanded: boolean; isPartial: boolean; omitTitle?: boolean },
  theme: Theme,
  current?: CurrentExchange,
): Component {
  return dynamic(() => {
    const body = new Container();
    if (!details) {
      if (!options.omitTitle) body.addChild(reviewTitle(theme, finishTitle(details)));
      return body;
    }
    const live = isCurrent(details, current);
    // Old sessions without identity respect normal expansion, rather than guessing liveness.
    const full = options.expanded || (!details.completion && (details.pending || live === true));
    const label = assessmentSummary(details);
    if (!options.omitTitle) body.addChild(reviewTitle(theme, finishTitle(details)));
    if (details.completion && !options.expanded) {
      for (const [label, value] of [
        ["What changed (implementer reported)", details.report || "Not provided."],
        ["Verification (implementer reported)", details.verification || "Not provided; verification is unknown."],
        [
          "Outstanding issues (implementer reported)",
          details.concerns || "Not provided; outstanding issues are unknown.",
        ],
      ])
        section(body, theme, label, completionPreview(value, 3, 320).text);
      // Recovery instructions must remain actionable without expanding the final report.
      if (details.action) section(body, theme, "Next action", details.action);
      body.addChild(new Spacer(1));
      body.addChild(new Text(theme.fg("dim", "ctrl+o to expand"), 0, 0));
      status(
        body,
        theme,
        {
          accepted: "Reviewed",
          no_review: "Review skipped",
          user_override: "Review overridden",
          stopped: "Not completed",
        }[details.completion],
        finishTone(details),
      );
      return body;
    }
    if (details.headline) body.addChild(new Text(theme.fg("dim", details.headline), 0, 0));
    const narrative = new Container();
    section(narrative, theme, "Implementer report", details.report || "Not provided.");
    section(
      narrative,
      theme,
      "Verification (implementer reported)",
      details.verification || "Not provided; verification is unknown.",
    );
    section(
      narrative,
      theme,
      "Outstanding issues (implementer reported)",
      details.concerns || "Not provided; outstanding issues are unknown.",
    );
    // Fold narrative text, not semantic outcome, findings or cost rows.
    if (full) body.addChild(narrative);
    else {
      body.addChild(new Spacer(1));
      folded(
        body,
        theme,
        `### Implementer report\n${details.report}\n\n### Verification (implementer reported)\n${details.verification ?? "Not provided."}\n\n### Outstanding issues\n${details.concerns ?? "Not provided."}`,
        false,
      );
    }
    for (const finding of details.previousFindings ?? []) {
      const response = details.responses?.find((item) => item.id === finding.id);
      section(
        body,
        theme,
        `Previous finding ${finding.id}: ${finding.title}`,
        full ? `${finding.detail}\n\nRequested change: ${finding.requestedChange}` : finding.title,
      );
      section(
        body,
        theme,
        "Implementer response",
        response ? `${response.status}: ${response.response}` : "No response recorded.",
      );
    }
    const unmatchedResponses = details.responses?.filter(
      (response) => !details.previousFindings?.some((finding) => finding.id === response.id),
    );
    if (unmatchedResponses?.length) section(body, theme, "Implementer responses", responsesText(unmatchedResponses));
    if (details.pending)
      section(body, theme, "Planner assessment", `Planner reviewing…${details.activity ? ` ${details.activity}` : ""}`);
    else if (details.decision) {
      if (full) {
        section(body, theme, "Planner assessment", details.decision.summary);
        if (details.decision.evidence?.length)
          section(
            body,
            theme,
            "Reviewed evidence",
            (details.decision.evidence ?? []).map((item) => `- ${item}`).join("\n"),
          );
        if (details.decision.limitations?.length)
          section(
            body,
            theme,
            "Limitations",
            (details.decision.limitations ?? []).map((item) => `- ${item}`).join("\n"),
          );
      } else {
        body.addChild(new Spacer(1));
        folded(
          body,
          theme,
          `### Planner assessment\n${details.decision.summary}\n\n### Reviewed evidence\n${(details.decision.evidence ?? []).map((item) => `- ${item}`).join("\n")}\n\n### Limitations\n${(details.decision.limitations ?? []).map((item) => `- ${item}`).join("\n")}`,
          false,
        );
      }
      for (const finding of details.decision.findings ?? [])
        section(
          body,
          theme,
          `${finding.id}: ${finding.title}`,
          full ? `${finding.detail}\n\nRequested change: ${finding.requestedChange}` : finding.title,
        );
    } else if (details.assessment?.state === "reviewed") {
      body.addChild(new Spacer(1));
      folded(body, theme, details.assessment.narrative, full);
    }
    const question = details.decision?.question ?? details.question ?? details.negotiation?.pause?.question;
    if (question) section(body, theme, "Question for you", question);
    if (details.decision?.recommendation) section(body, theme, "Recommendation", details.decision.recommendation);
    const action = details.action ?? details.negotiation?.pause?.action;
    if (action) section(body, theme, "Next action", action);
    if (details.error) section(body, theme, "Review error", details.error);
    if (full && details.negotiation) section(body, theme, "Review rounds", negotiationText(details.negotiation));
    if (full && details.changes) section(body, theme, "Changed files", changeSummaryText(details.changes));
    const callCost = details.negotiation?.history?.at((details.round ?? details.negotiation.attempts) - 1)?.costUsd;
    status(
      body,
      theme,
      label,
      finishTone(details),
      `${callCost !== undefined ? `this review ${formatCost(callCost)} · ` : ""}${finishContext(details)}`,
    );
    return body;
  });
}

/** A zero-row renderer proxy requests new frames without adding footer/widget content. */
export class ExecCardRefresh {
  private dispose?: () => void;
  private request?: () => void;
  begin(ctx: ExtensionContext): void {
    this.end();
    if (ctx.mode !== "tui") return;
    const key = `plan-exec-cards/${randomUUID()}`;
    this.dispose = () => ctx.ui.setWidget(key, undefined);
    try {
      ctx.ui.setWidget(key, (tui) => {
        this.request = () => tui.requestRender();
        return { render: () => [], invalidate() {} };
      });
    } catch {
      this.end();
    }
  }
  refresh(): void {
    try {
      this.request?.();
    } catch {
      /* stale UI */
    }
  }
  end(): void {
    const dispose = this.dispose;
    this.dispose = undefined;
    this.refresh();
    this.request = undefined;
    try {
      dispose?.();
    } catch {
      /* stale UI */
    }
  }
}
