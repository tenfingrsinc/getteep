import type { ReactNode } from "react";

type CreatorClaimFlowStatus = "idle" | "starting" | "waiting" | "checking" | "success" | "error";

type CreatorClaimPromptProps = {
  open: boolean;
  started: boolean;
  title: string;
  body: string;
  status: CreatorClaimFlowStatus;
  message?: string | null;
  authUrl: string;
  claimEarnedUsd: string;
  onExpand: () => void;
  onMinimize: () => void;
  onDismiss: () => void;
  onStart: () => void;
  onCheck: () => void;
  onOpenCreatorOverview: () => void;
};

function ClaimStep({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <li>
      <span>{number}</span>
      <div>
        <strong>{title}</strong>
        <small>{children}</small>
      </div>
    </li>
  );
}

export default function CreatorClaimPrompt({
  open,
  started,
  title,
  body,
  status,
  message,
  authUrl,
  claimEarnedUsd,
  onExpand,
  onMinimize,
  onDismiss,
  onStart,
  onCheck,
  onOpenCreatorOverview,
}: CreatorClaimPromptProps) {
  const busy = status === "starting" || status === "checking";

  return (
    <aside className={`dashboard-creator-claim-toast${open ? " is-expanded" : ""}`} aria-live="polite">
      <div className="dashboard-toast-controls" role="group" aria-label="Creator claim prompt controls">
        {open && (
          <button type="button" className="dashboard-toast-icon-button" onClick={onMinimize} aria-label="Minimize creator claim prompt">
            <span className="material-symbols-outlined" aria-hidden>remove</span>
          </button>
        )}
        <button type="button" className="dashboard-toast-icon-button" onClick={onDismiss} aria-label="Dismiss creator claim prompt">
          <span className="material-symbols-outlined" aria-hidden>close</span>
        </button>
      </div>
      <div className="dashboard-creator-claim-toast-main">
        <span className="material-symbols-outlined" aria-hidden>verified_user</span>
        <div>
          <strong>{title}</strong>
          <p>{body}</p>
        </div>
      </div>

      {!open ? (
        <div className="dashboard-creator-claim-actions">
          <button type="button" className="btn-primary" aria-controls="creator-claim-panel" aria-expanded={open} onClick={onExpand}>
            {started ? "Finish setup" : "Connect X"}
          </button>
        </div>
      ) : (
        <div id="creator-claim-panel" className="dashboard-creator-claim-expanded">
          <ol>
            <ClaimStep number={1} title="Connect X">Verify the social account your audience tips.</ClaimStep>
            <ClaimStep number={2} title="Teep links your receiving account">Pending tips for that handle become available in your Teep account.</ClaimStep>
            <ClaimStep number={3} title="Use creator tools">Open the creator overview to withdraw, track support, or grow tips.</ClaimStep>
          </ol>

          {message && (
            <div className={`dashboard-creator-claim-status is-${status}`} role={status === "error" ? "alert" : "status"}>
              {status === "success" ? (
                <>
                  <strong>{message}</strong>
                  <small>Tips found: ${claimEarnedUsd}</small>
                </>
              ) : (
                <span>{message}</span>
              )}
            </div>
          )}

          {authUrl && status === "waiting" && (
            <a href={authUrl} target="_blank" rel="noopener noreferrer" className="dashboard-creator-claim-link">
              Open X verification
              <span className="material-symbols-outlined" aria-hidden>open_in_new</span>
            </a>
          )}

          <div className="dashboard-creator-claim-actions">
            {status === "success" ? (
              <button type="button" className="btn-primary" onClick={onOpenCreatorOverview}>
                Open creator overview
              </button>
            ) : (
              <>
                <button type="button" className="btn-primary" onClick={onStart} disabled={busy}>
                  {status === "starting" ? "Opening..." : "Connect X account"}
                </button>
                <button type="button" className="btn-secondary" onClick={onCheck} disabled={busy}>
                  I connected X
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </aside>
  );
}
