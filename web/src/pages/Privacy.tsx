import { Link } from "react-router-dom";

const lastUpdated = "2026-07-31";

const sectionStyle = {
  color: "var(--text-secondary)",
  lineHeight: "var(--line-relaxed)",
  marginBottom: "var(--space-4)",
};

const headingStyle = {
  fontSize: "var(--text-heading)",
  fontWeight: 600,
  marginTop: "var(--space-6)",
  marginBottom: "var(--space-2)",
};

export default function Privacy() {
  return (
    <div className="page-section" style={{ paddingTop: "var(--space-4)" }}>
      <h1 style={{ fontSize: "var(--text-title)", marginBottom: "var(--space-2)" }}>Privacy Policy</h1>
      <p style={{ color: "var(--text-muted)", fontSize: "var(--text-small)", marginBottom: "var(--space-4)" }}>
        Last updated: {lastUpdated}
      </p>

      <p style={{ ...sectionStyle, color: "var(--text-primary)" }}>
        Teep respects your privacy. This policy covers the Teep website, dashboards, and connected X tipping features.
        We do not sell personal data or use it for advertising.
      </p>

      <h2 style={headingStyle}>What Teep accesses</h2>
      <p style={sectionStyle}>
        Teep processes the account, wallet, creator, post, and transaction details needed to prepare tips,
        show receipts, verify creators, and process X tip commands you enable. Teep does not collect your
        general browsing history.
      </p>

      <h2 style={headingStyle}>Information we collect</h2>
      <ul style={{ ...sectionStyle, paddingLeft: "var(--space-5)" }}>
        <li><strong style={{ color: "var(--text-primary)" }}>Account and identity:</strong> email address, connected wallet addresses, X handle, X verification state, and creator profile information.</li>
        <li><strong style={{ color: "var(--text-primary)" }}>Tips and account activity:</strong> tip intents, transaction hashes, balances, withdrawals, referrals, receipts, and related creator or post identifiers.</li>
        <li><strong style={{ color: "var(--text-primary)" }}>Product preferences:</strong> receipt preferences, X command limits, acknowledged notices, and temporary transaction state used to prevent duplicate submissions.</li>
        <li><strong style={{ color: "var(--text-primary)" }}>Technical and security data:</strong> IP address, browser or device information, request logs, errors, and abuse-prevention signals.</li>
        <li><strong style={{ color: "var(--text-primary)" }}>Public blockchain data:</strong> wallet addresses and transactions are public and may remain permanently available on the blockchain.</li>
      </ul>

      <h2 style={headingStyle}>How we use information</h2>
      <p style={sectionStyle}>
        We use this information only to provide Teep features, authenticate users, create and secure wallets,
        prepare and record transactions, prevent duplicate or fraudulent activity, show receipts and history,
        provide support, maintain the beta, and comply with applicable law. We do not use product data for
        credit decisions, advertising, or sale to data brokers.
      </p>

      <h2 style={headingStyle}>Connected X features</h2>
      <p style={sectionStyle}>
        When you connect X, Teep stores the connected X account identifier, username, Teep account address,
        command preferences, and safety limits needed to recognize that account. Linking or verifying X does not
        by itself enable X tip commands. Commands are enabled only when you expressly turn them on and approve the
        displayed command limits and token allowance. You can pause them or change their limits in Settings.
      </p>

      <h2 style={headingStyle}>Service providers</h2>
      <p style={sectionStyle}>
        Teep uses service providers to operate the product. These currently include Privy for authentication
        and embedded-wallet services; smart-wallet, bundler, and paymaster infrastructure configured for Arc;
        Arc network RPC and blockchain-indexing services; X for creator verification and supported-page context;
        Crossmint for enabled funding or withdrawal routes; and Circle services, including the testnet faucet when
        a user chooses to request test funds. Providers process data needed to perform their services and may retain
        records under their own privacy terms and legal obligations.
      </p>

      <h2 style={headingStyle}>Browser storage</h2>
      <p style={sectionStyle}>
        The Teep web app may store local session preferences and temporary transaction state in your browser
        to keep the product usable between visits and prevent duplicate submissions. Clearing local browser
        storage does not delete Teep account records or public blockchain transactions.
      </p>

      <h2 style={headingStyle}>Retention</h2>
      <p style={sectionStyle}>
        While your account is active, we retain account, support, withdrawal, provider, and security records only
        as long as reasonably needed to operate Teep, prevent abuse, resolve disputes, and meet legal obligations.
        Our current target is up to 24 months for these operational records and generally 30 to 90 days for routine
        logs. The deletion process described below removes Teep-controlled account data associated with the account,
        except for records that reproduce or identify immutable blockchain activity. Service providers may apply
        their own retention periods.
      </p>

      <h2 style={headingStyle}>Your choices and deletion</h2>
      <p style={sectionStyle}>
        Depending on where you live, you may request access, correction, deletion, portability, restriction, or
        objection regarding personal data we control. You can permanently delete your Teep account from the Privacy
        and safety section of Settings. You must verify control of the connected wallet and type the displayed
        confirmation before deletion can begin.
      </p>
      <p style={sectionStyle}>
        To protect funds, deletion is blocked until all connected account and ClaimWallet balances, Teep internal
        balances, and Grow Tips positions are zero, and until claimable tips and pending funding, withdrawal, or Grow
        operations are settled. If X tipping permission or a token allowance remains active, Teep asks your wallet to
        revoke both before performing a final state check. Teep does not transfer, withdraw, forfeit, or claim funds
        on your behalf as part of deletion.
      </p>
      <p style={sectionStyle}>
        After the checks pass, Teep removes its mutable account data, including your profile and settings, linked X
        account, preferences, notifications, referrals, provider sessions and payloads, pending confirmations,
        off-chain activity, internal balance ledger, and Grow Tips account records. Teep retains only indexed records
        that reproduce immutable blockchain activity, including confirmed tips and deposits, completed withdrawal
        transactions, and ClaimWallet deployments. Those records may contain public wallet addresses, transaction
        hashes, amounts, and on-chain creator identifiers. Removable profile metadata is separated from retained
        transaction records where technically possible.
      </p>
      <p style={sectionStyle}>
        Teep also requests deletion of the associated Privy user. Privy disassociates and archives an embedded wallet
        rather than erasing the wallet itself. Public blockchain records, smart-wallet deployments, and other
        immutable on-chain data cannot be edited or deleted by Teep. Account deletion is permanent, and signing in
        again may create a new Privy user and wallet rather than restore the deleted account.
      </p>
      <p style={sectionStyle}>
        If you cannot use the in-product deletion control, email{" "}
        <a href="mailto:support@getteep.xyz?subject=Account%20deletion%20request" style={{ color: "var(--link)" }}>
          support@getteep.xyz
        </a>{" "}
        from your account email with the subject "Account deletion request" and include your Teep wallet address
        or X handle. We will require account ownership verification and the same financial-readiness checks before
        processing the request.
      </p>

      <h2 style={headingStyle}>Changes and contact</h2>
      <p style={sectionStyle}>
        We may update this policy as Teep changes. We will post the revised version here and update the date
        above. Questions and privacy requests can be sent to{" "}
        <a href="mailto:support@getteep.xyz" style={{ color: "var(--link)" }}>support@getteep.xyz</a>.
      </p>

      <p style={{ color: "var(--text-muted)", fontSize: "var(--text-small)", marginTop: "var(--space-6)" }}>
        See <Link to="/support#account-deletion">Support and deletion instructions</Link> or read the <Link to="/terms">Terms</Link>.
      </p>
    </div>
  );
}
