import CreatorDashboardShell from "../components/CreatorDashboardShell";

export default function CreatorGrowLearn() {
  return (
    <CreatorDashboardShell title="Learn">
      <main className="creator-learn-coming-soon">
        <section className="creator-coming-soon-card" aria-label="Grow Tips learn page coming soon">
          <span className="material-symbols-outlined" aria-hidden>lock_clock</span>
          <div>
            <strong>Coming soon</strong>
            <p>Short, practical Grow Tips lessons are being prepared for the beta.</p>
          </div>
        </section>
      </main>
    </CreatorDashboardShell>
  );
}
