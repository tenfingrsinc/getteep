import { Link } from "react-router-dom";

const lastUpdated = "2026-07-31";

export default function Terms() {
  return (
    <div className="page-section" style={{ paddingTop: "var(--space-4)" }}>
      <h1 style={{ fontSize: "var(--text-title)", marginBottom: "var(--space-2)" }}>Terms of Service</h1>
      <p style={{ color: "var(--text-muted)", fontSize: "var(--text-small)", marginBottom: "var(--space-4)" }}>
        Last updated: {lastUpdated}
      </p>
      <p style={{ color: "var(--text-primary)", lineHeight: "var(--line-relaxed)", marginBottom: "var(--space-4)" }}>
        <strong>Teep is currently a testnet beta.</strong> Balances and transactions use test funds on Arc testnet.
        Test funds have no real-world monetary value and cannot be withdrawn to a bank.
      </p>
      <p style={{ color: "var(--text-primary)", lineHeight: "var(--line-relaxed)", marginBottom: "var(--space-4)" }}>
        <strong>Tips are final.</strong> Once you send money to a creator, we cannot reverse or refund it.
        Only tip people you trust.
      </p>
      <p style={{ color: "var(--text-secondary)", lineHeight: "var(--line-relaxed)", marginBottom: "var(--space-4)" }}>
        You are responsible for your account and keeping it secure. We do not have access to your funds.
      </p>
      <p style={{ color: "var(--text-secondary)", lineHeight: "var(--line-relaxed)", marginBottom: "var(--space-4)" }}>
        Teep may show balances, receipts, and history from indexed blockchain activity and provider records. During beta, displayed history can lag while indexing catches up, but completed blockchain transactions remain final.
      </p>
      <p style={{ color: "var(--text-secondary)", lineHeight: "var(--line-relaxed)", marginBottom: "var(--space-4)" }}>
        <strong style={{ color: "var(--text-primary)" }}>X tip commands require express authorization.</strong>{" "}
        Linking or verifying X alone does not authorize commands. Commands are enabled only when you turn them on
        and approve the displayed per-tip limit, total budget, and token allowance. Teep may then process supported
        commands from that connected X account within those limits. You can pause commands or change their limits
        in Settings.
      </p>
      <p style={{ color: "var(--text-secondary)", lineHeight: "var(--line-relaxed)", marginBottom: "var(--space-4)" }}>
        <strong style={{ color: "var(--text-primary)" }}>Account deletion requires a settled account.</strong> Before
        deletion, you must transfer or withdraw all available balances, exit any Grow Tips position, resolve pending
        tips and money movements, and revoke active X tipping permission and token allowances. Teep will not delete
        an account while its checks detect funds, unsettled operations, or active spending authority. Deletion does
        not transfer, withdraw, recover, or forfeit funds for you.
      </p>
      <p style={{ color: "var(--text-secondary)", lineHeight: "var(--line-relaxed)", marginBottom: "var(--space-4)" }}>
        <strong style={{ color: "var(--text-primary)" }}>Deletion is permanent but does not erase the blockchain.</strong>{" "}
        Teep deletes its mutable account records and requests deletion of the associated Privy user. Confirmed tips,
        deposits, withdrawals, ClaimWallet deployments, smart-wallet deployments, and related public blockchain data
        remain available on-chain and may remain in Teep's transaction index. Privy may archive and disassociate an
        embedded wallet rather than erase it. Creating another account does not restore the deleted profile or its
        settings. See the <Link to="/privacy">Privacy Policy</Link> for the detailed deletion and retention policy.
      </p>
      <p style={{ color: "var(--text-secondary)", lineHeight: "var(--line-relaxed)" }}>
        Teep is an independent product and is not affiliated with, endorsed by, or sponsored by X Corp. For support, see <Link to="/support">Support</Link>.
      </p>
    </div>
  );
}
