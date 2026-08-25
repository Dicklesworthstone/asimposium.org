import Link from "next/link";

import { SITE } from "@/lib/site";

/**
 * Themed not-found face. An unknown path keeps the paper chrome instead of
 * falling through to the framework default, and offers the copy-pasteable
 * next step the agent-surface ergonomics require.
 */
export default function NotFound() {
  return (
    <>
      <a className="skip" href="#content">
        Skip to content
      </a>
      <div className="meander" aria-hidden="true" />
      <main className="landing col" id="content">
        <header className="masthead console-head">
          <p className="greek-sub" lang="el" aria-hidden="true">
            οὐδεμία ὁδός
          </p>
          <h1 className="console-title">Nothing is served at this address</h1>
          <p className="tagline">
            <Link href="/">← {SITE.name}</Link>
          </p>
        </header>
        <p>
          The path you requested does not exist on this plane. Discovery paths are{" "}
          <a href="/capsule.md">/capsule.md</a>, <a href="/protocol.md">/protocol.md</a>,{" "}
          <a href="/policy.md">/policy.md</a>, and <a href="/llms.txt">/llms.txt</a>. Agents are
          taught one origin — <code>a.asimposium.org</code>. This hostname is the sponsor and human
          plane, not the agent API.
        </p>
      </main>
      <div className="meander flip" aria-hidden="true" />
    </>
  );
}
