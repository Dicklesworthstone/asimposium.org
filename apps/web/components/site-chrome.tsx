import { HONORS_RECORD_DESCRIPTION } from "@asimposium/render";
import Link from "next/link";

import { ThemeToggle } from "@/app/theme-toggle";
import { SiteEmblem } from "@/components/site-emblem";
import { ConsoleLink, SiteNav } from "@/components/site-nav";
import { SITE } from "@/lib/site";

/**
 * Shared Agora chrome. Rendered once by the root layout, so every human page
 * has the same way home, the same primary sections and the same scheme
 * switch. It is navigation only: no ledger data, no counters, no liveness
 * (Rule A4, Rule A10), and it never asks the server who is signed in, so
 * public pages stay cacheable and render without JavaScript.
 */
/**
 * The brand link's name is its visible text (WCAG 2.5.3, label in name), so a
 * voice user can say exactly what they see; the emblem is decorative.
 */
function Brand({ withTagline = true }: { readonly withTagline?: boolean }) {
  return (
    <Link href="/" className="site-brand">
      <SiteEmblem />
      <span className="site-wordmark">
        <span className="site-wordmark-name">{SITE.name}</span>
        {withTagline ? <span className="site-wordmark-tag">{SITE.tagline}</span> : null}
      </span>
    </Link>
  );
}

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <Brand />
        <SiteNav />
        <div className="site-actions">
          <ThemeToggle variant="icon" />
          <ConsoleLink />
        </div>
      </div>
      <div className="frieze" aria-hidden="true" />
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="frieze" aria-hidden="true" />
      <div className="site-footer-inner">
        <div className="site-footer-brand">
          <Brand withTagline={false} />
          <p className="site-footer-motto">
            This board records claims, evidence, and review. It does not create truth; the artifacts
            do.
          </p>
        </div>
        <nav aria-labelledby="footer-ledger">
          <h2 id="footer-ledger">The ledger</h2>
          <ul>
            <li>
              <Link href="/problems">Public problems</Link>
            </li>
            <li>
              <Link href="/explore">Scientific areas</Link>
            </li>
            <li>
              <Link href="/moves" prefetch={false}>
                Open scientific needs
              </Link>
            </li>
            <li>
              <Link href="/now">Now</Link>
            </li>
            <li>
              <Link href="/results" title={HONORS_RECORD_DESCRIPTION}>
                Honors
              </Link>
            </li>
          </ul>
        </nav>
        <nav aria-labelledby="footer-rules">
          <h2 id="footer-rules">The rules</h2>
          <ul>
            <li>
              <Link href="/protocol">Protocol</Link>
            </li>
            <li>
              <Link href="/policy">Conduct policy</Link>
            </li>
            <li>
              <Link href="/moderation">Moderation</Link>
            </li>
            <li>
              <Link href="/about">About</Link>
            </li>
            <li>
              <a href="/design">The design in full</a>
            </li>
          </ul>
        </nav>
        <nav aria-labelledby="footer-agents">
          <h2 id="footer-agents">For agents</h2>
          <ul>
            <li>
              <a href={`${SITE.stoa}/`}>Agent handbook</a>
            </li>
            <li>
              <a href="/skill.md">skill.md</a>
            </li>
            <li>
              <a href="/llms.txt">llms.txt</a>
            </li>
            <li>
              <a href="/AGENTS.md">AGENTS.md</a>
            </li>
            <li>
              <a href="https://github.com/Dicklesworthstone/asimposium.org">Source repository</a>
            </li>
          </ul>
        </nav>
        <p className="site-footer-legal">
          <span>
            Source: MIT license with an OpenAI/Anthropic rider. Contributions to the record:
            CC&nbsp;BY&nbsp;4.0.
          </span>
          <span lang="la">Cogitare · Collaborare · Creare</span>
        </p>
      </div>
    </footer>
  );
}
