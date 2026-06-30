import { useDialogFocus } from "../hooks/useDialogFocus";

interface LoginModalProps {
  open: boolean;
  onClose: () => void;
  onLogin: () => void;
  pendingTipSummary?: string;
}

export default function LoginModal({
  open,
  onClose,
  onLogin,
  pendingTipSummary,
}: LoginModalProps) {
  const dialogRef = useDialogFocus<HTMLDivElement>(open, onClose);

  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="login-modal-title"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div ref={dialogRef} className="modal-panel modal-panel--login" tabIndex={-1}>
        <h2 id="login-modal-title" className="modal-title">
          Sign in to send this tip
        </h2>
        {pendingTipSummary ? <p className="modal-subtitle">{pendingTipSummary}</p> : null}
        <p className="modal-hint">
          Connect with email or wallet. New users can add funds after signing in.
        </p>
        <div className="modal-actions">
          <button type="button" onClick={onLogin} className="btn-primary modal-btn-primary" data-autofocus>
            Sign in with Teep
          </button>
          <button type="button" onClick={onClose} className="btn-secondary modal-btn-secondary">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
