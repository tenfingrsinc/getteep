import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { usePrivy } from "@privy-io/react-auth";
import { API_BASE } from "../config";
import { useAccountRole } from "../context/AccountRoleContext";
import { useReferral } from "../context/ReferralContext";

type DashboardShellProps = {
  address?: string;
  title: string;
  children: ReactNode;
  headerActions?: ReactNode;
  sidebarKicker?: string;
  navSections?: DashboardNavSection[];
  mobileNavLinks?: DashboardNavLink[];
};

export type DashboardNavLink = {
  to: string;
  icon: string;
  label: string;
  active?: boolean;
};

export type DashboardNavSection = {
  title?: string;
  links: DashboardNavLink[];
};

function accountLabelFromSettings(settings: unknown) {
  const source = settings as { socialXHandle?: string | null; username?: string | null; displayName?: string | null } | null;
  const label = source?.socialXHandle || source?.username || source?.displayName || "";
  return label ? (label.startsWith("@") ? label : `@${label}`) : "Teep account";
}

function usernameFallback(email?: string | null) {
  const local = email?.includes("@") ? email.split("@")[0] : "";
  const cleaned = local
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  return cleaned.length >= 3 ? cleaned : "";
}

function initials(label?: string) {
  const clean = (label || "Teep account").replace(/^@/, "").trim();
  return clean.slice(0, 2).toUpperCase() || "TA";
}

type NotificationRecord = {
  id: number;
  title: string;
  body: string;
  status: "unread" | "read";
};

export default function DashboardShell({
  address = "",
  title,
  children,
  sidebarKicker,
  navSections,
  mobileNavLinks,
}: DashboardShellProps) {
  const { pathname } = useLocation();
  const { logout, user } = usePrivy();
  const accountRole = useAccountRole();
  const {
    code: referralCode,
    referredCount: referralCount,
    loading: referralLoading,
    status: referralMsg,
    copyLink: copyReferralLink,
  } = useReferral();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [notificationUnread, setNotificationUnread] = useState(0);
  const [referralCopied, setReferralCopied] = useState(false);
  const [accountDisplayName, setAccountDisplayName] = useState("Teep account");
  const routeForcesCreatorNav = pathname.startsWith("/creator");
  const notificationRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const mobileMoreButtonRef = useRef<HTMLButtonElement>(null);
  const mobileMoreCloseRef = useRef<HTMLButtonElement>(null);
  const showCreatorNav = routeForcesCreatorNav || accountRole.isCreator;
  const roleResolved = routeForcesCreatorNav || accountRole.status !== "loading";

  const creatorDashboardLinks: DashboardNavLink[] = [
    { to: "/creator/dashboard", icon: "dashboard", label: "Overview", active: pathname === "/creator/dashboard" },
    { to: "/creator/withdraw", icon: "account_balance_wallet", label: "Withdraw", active: pathname === "/creator/withdraw" || pathname === "/dashboard/withdraw" },
    { to: "/creator/performance", icon: "monitoring", label: "Performance", active: pathname === "/creator/performance" },
  ];
  const growTipsLinks: DashboardNavLink[] = [
    { to: "/creator/grow/earn", icon: "eco", label: "Grow Tips", active: pathname === "/creator/grow/earn" },
    { to: "/creator/grow/learn", icon: "school", label: "Learn", active: pathname === "/creator/grow/learn" },
    { to: "/creator/referrals", icon: "card_giftcard", label: "Referrals", active: pathname === "/creator/referrals" },
  ];
  const creatorAccountLinks: DashboardNavLink[] = [
    { to: "/creator/settings", icon: "settings", label: "Settings", active: pathname === "/creator/settings" || pathname === "/creator/grow/settings" },
  ];
  const creatorTipperDashboardLinks: DashboardNavLink[] = [
    { to: "/dashboard?view=tipper", icon: "account_balance_wallet", label: "Tipper Dashboard", active: pathname === "/dashboard" },
  ];
  const tipperDashboardLinks: DashboardNavLink[] = [
    { to: "/dashboard", icon: "account_balance_wallet", label: "Tipper Dashboard", active: pathname === "/dashboard" },
    { to: "/dashboard/settings", icon: "manage_accounts", label: "Settings", active: pathname === "/dashboard/settings" },
    { to: "/dashboard/discover", icon: "explore", label: "Discover Creators", active: pathname === "/dashboard/discover" },
    { to: "/dashboard/referrals", icon: "card_giftcard", label: "Referrals", active: pathname === "/dashboard/referrals" },
  ];
  const dynamicNavSections: DashboardNavSection[] = showCreatorNav
    ? [
      { title: "Creator", links: creatorDashboardLinks },
      { title: "Growth", links: growTipsLinks },
      { title: "Tipper Dashboard", links: creatorTipperDashboardLinks },
      { title: "Account", links: creatorAccountLinks },
    ]
    : [{ title: "Tipper Dashboard", links: tipperDashboardLinks }];
  const resolvedNavSections = navSections || dynamicNavSections;
  const defaultMobileLinks = showCreatorNav
    ? [creatorDashboardLinks[0], creatorDashboardLinks[1], creatorDashboardLinks[2], growTipsLinks[0]]
    : tipperDashboardLinks;
  const resolvedMobileLinks = mobileNavLinks || defaultMobileLinks;
  const isLinkActive = (link: DashboardNavLink) => link.active ?? pathname === link.to;
  const mobilePrimaryPaths = new Set(resolvedMobileLinks.map((link) => link.to));
  const mobileMoreSections = showCreatorNav
    ? resolvedNavSections
      .map((section) => ({
        ...section,
        links: section.links.filter((link) => !mobilePrimaryPaths.has(link.to)),
      }))
      .filter((section) => section.links.length > 0)
    : [];
  const mobileMoreActive = mobileMoreSections.some((section) => section.links.some(isLinkActive));
  const resolvedSidebarKicker = sidebarKicker || (showCreatorNav ? "Creator Dashboard" : "Tipper Dashboard");
  const dashboardHomePath = showCreatorNav ? "/creator/dashboard" : "/dashboard";

  const fetchNotifications = useCallback(() => {
    if (!address) return;
    fetch(`${API_BASE}/api/v1/wallet/${address}/notifications?page=1&limit=7`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        setNotifications(Array.isArray(data?.records) ? data.records : []);
        setNotificationUnread(Number(data?.unread || 0));
      })
      .catch(() => {});
  }, [address]);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  useEffect(() => {
    if (!address) {
      setAccountDisplayName("Teep account");
      return;
    }
    let cancelled = false;
    const fallbackUsername = usernameFallback(user?.email?.address);
    const query = fallbackUsername ? `?preferredUsername=${encodeURIComponent(fallbackUsername)}` : "";
    fetch(`${API_BASE}/api/v1/wallet/${address}/settings${query}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((settings) => {
        if (!cancelled) setAccountDisplayName(accountLabelFromSettings(settings));
      })
      .catch(() => {
        if (!cancelled) setAccountDisplayName("Teep account");
      });
    return () => {
      cancelled = true;
    };
  }, [address, user?.email?.address]);

  useEffect(() => {
    if (!notificationOpen) return;
    function handleOutsideClick(event: MouseEvent) {
      if (notificationRef.current && !notificationRef.current.contains(event.target as Node)) {
        setNotificationOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [notificationOpen]);

  useEffect(() => {
    if (!userMenuOpen) return;
    function handleOutsideClick(event: MouseEvent) {
      if (userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) {
        setUserMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [userMenuOpen]);

  useEffect(() => {
    setMobileMoreOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileMoreOpen) return;
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileMoreOpen(false);
    };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleKeyDown);
    window.requestAnimationFrame(() => mobileMoreCloseRef.current?.focus());
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
      mobileMoreButtonRef.current?.focus();
    };
  }, [mobileMoreOpen]);

  const markNotificationRead = useCallback(async (id: number) => {
    if (!address) return;
    await fetch(`${API_BASE}/api/v1/wallet/${address}/notifications/${id}/read`, { method: "POST" }).catch(() => null);
    setNotifications((items) => items.map((item) => item.id === id ? { ...item, status: "read" } : item));
    setNotificationUnread((count) => Math.max(0, count - 1));
  }, [address]);

  const handleCopyReferral = useCallback(async () => {
    if (!address) return;
    const copied = await copyReferralLink();
    if (copied) {
      setReferralCopied(true);
      window.setTimeout(() => setReferralCopied(false), 2000);
    }
  }, [address, copyReferralLink]);

  return (
    <div className="dashboard-layout">
      <aside className="dashboard-sidebar">
        <div className="dashboard-sidebar-brand">
          <div className="dashboard-sidebar-logo-row">
            <img src="/logo.svg" alt="Teep" width={32} height={32} />
            <h1>Teep</h1>
          </div>
          <div className="dashboard-sidebar-kicker">{resolvedSidebarKicker}</div>
        </div>

        <nav className="dashboard-sidebar-nav">
          {!roleResolved && !navSections ? (
            <div className="dashboard-sidebar-nav-section" aria-hidden>
              <div className="dashboard-sidebar-nav-heading">Loading</div>
              <div className="dashboard-sidebar-nav-placeholder" />
              <div className="dashboard-sidebar-nav-placeholder" />
              <div className="dashboard-sidebar-nav-placeholder dashboard-sidebar-nav-placeholder--short" />
            </div>
          ) : resolvedNavSections.map((section, sectionIndex) => (
            <div key={section.title || sectionIndex} className="dashboard-sidebar-nav-section">
              {section.title && <div className="dashboard-sidebar-nav-heading">{section.title}</div>}
              {section.links.map((link) => (
                <Link key={link.to} to={link.to} className={`dashboard-sidebar-btn${isLinkActive(link) ? " dashboard-sidebar-btn--active" : ""}`}>
                  <span className="material-symbols-outlined" aria-hidden>{link.icon}</span>
                  {link.label}
                </Link>
              ))}
            </div>
          ))}
        </nav>

        <div className="dashboard-sidebar-footer">
          <div className="dashboard-sidebar-block dashboard-sidebar-referral-card">
            <div style={{ display: "flex", gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
              <div className="dashboard-sidebar-referral-icon">
                <span className="material-symbols-outlined" style={{ fontSize: 18 }}>card_giftcard</span>
              </div>
              <div>
                <div className="dashboard-sidebar-referral-title">Refer and Earn</div>
                <div className="dashboard-sidebar-referral-subtitle">{referralCount > 0 ? `${referralCount} referred` : "Earn from eligible withdrawals"}</div>
              </div>
            </div>
            <button type="button" onClick={handleCopyReferral} disabled={!address || referralLoading} className="dashboard-sidebar-referral-action">
              <span className="material-symbols-outlined" style={{ fontSize: 14 }}>{referralCopied ? "check" : "content_copy"}</span>
              {referralLoading ? "Preparing..." : referralCopied ? "Copied!" : referralCode ? "Copy link" : "Create link"}
            </button>
            {referralMsg && <div className="dashboard-sidebar-referral-message">{referralMsg}</div>}
          </div>
          <div className="dashboard-sidebar-wallet">
            <div>Account Connected</div>
            <strong>{accountDisplayName}</strong>
            <span aria-hidden />
          </div>
        </div>
      </aside>

      <div className={`dashboard-body${pathname === "/creator/dashboard" ? " dashboard-body--scrollbar-hidden" : ""}`}>
        <header className="dashboard-header">
          <Link to={dashboardHomePath} className="dashboard-header-logo" aria-label="Teep dashboard">
            <img src="/logo.svg" alt="" width={36} height={36} />
            <span>Teep</span>
          </Link>
          <h2>{title}</h2>
          <div className="dashboard-header-actions">
            <div className="dashboard-header-notification-wrap" ref={notificationRef}>
              <button type="button" className="dashboard-header-icon-btn" aria-label="Notifications" onClick={() => setNotificationOpen((open) => !open)}>
                <span className="material-symbols-outlined">notifications</span>
                {notificationUnread > 0 && <span className="dashboard-header-notification-count">{notificationUnread > 9 ? "9+" : notificationUnread}</span>}
              </button>
              {notificationOpen && (
                <div className="dashboard-notification-menu">
                  <div className="dashboard-notification-menu-head">
                    <strong>Notifications</strong>
                    <Link to={showCreatorNav ? "/creator/settings" : "/dashboard/settings"} onClick={() => setNotificationOpen(false)}>Settings</Link>
                  </div>
                  {notifications.length === 0 ? (
                    <div className="dashboard-notification-empty">No notifications yet.</div>
                  ) : (
                    <div className="dashboard-notification-list">
                      {notifications.map((item) => (
                        <button key={item.id} type="button" onClick={() => markNotificationRead(item.id)} className={item.status === "unread" ? "is-unread" : ""}>
                          <strong>{item.title}</strong>
                          <span>{item.body}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            {address && (
              <div className="dashboard-header-user-menu" ref={userMenuRef}>
                <button
                  type="button"
                  onClick={() => setUserMenuOpen((open) => !open)}
                  className="dashboard-header-avatar"
                  aria-label="Account menu"
                  aria-expanded={userMenuOpen}
                >
                  {initials(accountDisplayName)}
                </button>
                {userMenuOpen && (
                  <div className="dashboard-user-menu">
                    <button type="button" onClick={() => { logout(); setUserMenuOpen(false); }} className="dashboard-user-menu-logout">
                      <span className="material-symbols-outlined" style={{ fontSize: 18 }}>logout</span>
                      Log out
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </header>
        {children}
      </div>
      <nav className={`dashboard-mobile-nav${showCreatorNav ? " dashboard-mobile-nav--creator" : ""}`} aria-label="Dashboard navigation">
        {resolvedMobileLinks.map((link) => (
          <Link key={link.to} to={link.to} className={isLinkActive(link) ? "is-active" : ""}>
            <span className="material-symbols-outlined" aria-hidden>{link.icon}</span>
            <span>{link.label.replace(" Creators", "")}</span>
          </Link>
        ))}
        {showCreatorNav && mobileMoreSections.length > 0 && (
          <button
            ref={mobileMoreButtonRef}
            type="button"
            className={mobileMoreActive || mobileMoreOpen ? "is-active" : ""}
            aria-label="More dashboard navigation"
            aria-expanded={mobileMoreOpen}
            aria-controls="dashboard-mobile-more-sheet"
            onClick={() => setMobileMoreOpen(true)}
          >
            <span className="material-symbols-outlined" aria-hidden>menu</span>
            <span>More</span>
          </button>
        )}
      </nav>
      {showCreatorNav && mobileMoreSections.length > 0 && (
        <div className={`dashboard-mobile-more${mobileMoreOpen ? " is-open" : ""}`} aria-hidden={!mobileMoreOpen}>
          <button
            type="button"
            className="dashboard-mobile-more-backdrop"
            aria-label="Close more navigation"
            tabIndex={mobileMoreOpen ? 0 : -1}
            onClick={() => setMobileMoreOpen(false)}
          />
          <section
            id="dashboard-mobile-more-sheet"
            className="dashboard-mobile-more-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dashboard-mobile-more-title"
          >
            <div className="dashboard-mobile-more-handle" aria-hidden />
            <div className="dashboard-mobile-more-head">
              <div>
                <span>Creator dashboard</span>
                <h2 id="dashboard-mobile-more-title">More</h2>
              </div>
              <button ref={mobileMoreCloseRef} type="button" aria-label="Close more navigation" onClick={() => setMobileMoreOpen(false)}>
                <span className="material-symbols-outlined" aria-hidden>close</span>
              </button>
            </div>
            <nav className="dashboard-mobile-more-links" aria-label="More dashboard navigation">
              {mobileMoreSections.map((section, sectionIndex) => (
                <div key={section.title || sectionIndex} className="dashboard-mobile-more-group">
                  {section.title && <h3>{section.title}</h3>}
                  {section.links.map((link) => (
                    <Link key={link.to} to={link.to} className={isLinkActive(link) ? "is-active" : ""}>
                      <span className="material-symbols-outlined" aria-hidden>{link.icon}</span>
                      <span>{link.label}</span>
                      <span className="material-symbols-outlined dashboard-mobile-more-chevron" aria-hidden>chevron_right</span>
                    </Link>
                  ))}
                </div>
              ))}
            </nav>
          </section>
        </div>
      )}
    </div>
  );
}
