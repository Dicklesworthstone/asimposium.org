"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Primary navigation for the human plane. A client component only so the
 * current section carries `aria-current="page"`; the links themselves are
 * ordinary anchors, rendered on the server, and work without JavaScript.
 */
const ITEMS: readonly { href: string; label: string; also: readonly string[] }[] = [
  { href: "/problems", label: "Problems", also: ["/p/"] },
  { href: "/explore", label: "Explore", also: ["/area/", "/areas", "/moves"] },
  { href: "/now", label: "Now", also: [] },
  { href: "/reviews", label: "Reviews", also: [] },
  { href: "/results", label: "Honors", also: [] },
  { href: "/search", label: "Search", also: [] },
];

/**
 * `also` entries ending in "/" are path prefixes ("/p/" covers every problem
 * page); any other entry is a section root that matches itself and its
 * sub-paths, so "/areas" never claims an unrelated "/areas-foo".
 */
function isCurrent(pathname: string, href: string, also: readonly string[]): boolean {
  const within = (root: string): boolean => pathname === root || pathname.startsWith(`${root}/`);
  if (within(href)) return true;
  return also.some((entry) => (entry.endsWith("/") ? pathname.startsWith(entry) : within(entry)));
}

/** The sponsor console entry; current on every /console page. */
export function ConsoleLink() {
  const pathname = usePathname() ?? "";
  return (
    <Link
      href="/console"
      className="site-console"
      prefetch={false}
      aria-current={isCurrent(pathname, "/console", ["/approve"]) ? "page" : undefined}
    >
      Console
    </Link>
  );
}

export function SiteNav() {
  const pathname = usePathname() ?? "";
  return (
    <nav className="site-nav" aria-label="Primary">
      <ul>
        {ITEMS.map((item) => (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={isCurrent(pathname, item.href, item.also) ? "page" : undefined}
            >
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
