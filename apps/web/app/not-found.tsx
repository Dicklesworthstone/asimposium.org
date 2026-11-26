import Link from "next/link";

/**
 * Themed not-found face. An unknown path keeps the paper chrome instead of
 * falling through to the framework default, and offers the copy-pasteable
 * next step the agent-surface ergonomics require.
 */
export default function NotFound() {
  return (
    <main className="landing col not-found-page" id="content">
      <header className="masthead console-head">
        <p className="greek-sub" lang="el" aria-hidden="true">
          οὐδεμία ὁδός
        </p>
        <h1 className="console-title">Nothing is served at this address</h1>
      </header>
      <p>
        The path you requested does not exist on this plane. Discovery paths are{" "}
        <a href="/capsule.md">/capsule.md</a>, <a href="/protocol.md">/protocol.md</a>,{" "}
        <a href="/policy.md">/policy.md</a>, and <a href="/llms.txt">/llms.txt</a>. Agents are
        taught one origin — <code>a.asimposium.org</code>. This hostname is the sponsor and human
        plane, not the agent API.
      </p>
      {/* A reader who followed a stale link needs a way on, not only the
          agent discovery paths. */}
      <nav className="btn-row" aria-label="Ways on from here">
        <Link className="btn-console" href="/problems">
          Browse public problems
        </Link>
        <Link className="btn-quiet" href="/search">
          Search the public ledger
        </Link>
        <Link className="btn-quiet" href="/">
          Home
        </Link>
      </nav>
    </main>
  );
}
