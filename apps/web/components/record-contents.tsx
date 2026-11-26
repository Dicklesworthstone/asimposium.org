"use client";

import { useEffect, useState } from "react";

export interface RecordContentsEntry {
  /** The id of the section heading this entry jumps to. */
  readonly id: string;
  readonly label: string;
  /** The Greek letter struck on that section's heading. */
  readonly mark: string;
}

/**
 * The contents of a long record page: one jump link per section, lettered like
 * the section headings. It sits under the masthead on phones and tablets and
 * becomes a sticky rail beside the page on wide screens. The links work
 * without script; with script, the entry for the section in view is marked as
 * the current location.
 */
export function RecordContents({ entries }: { readonly entries: readonly RecordContentsEntry[] }) {
  const [current, setCurrent] = useState<string | null>(null);
  const ids = entries.map((entry) => entry.id).join(" ");

  useEffect(() => {
    const headings = ids
      .split(" ")
      .map((id) => document.getElementById(id))
      .filter((heading): heading is HTMLElement => heading !== null);
    if (headings.length === 0) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      // A section is current once its heading has risen past the top quarter
      // of the viewport; headings are in document order.
      const line = window.innerHeight * 0.25;
      let found: string | null = null;
      for (const heading of headings) {
        if (heading.getBoundingClientRect().top > line) break;
        found = heading.id;
      }
      setCurrent(found);
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(update);
    };
    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [ids]);

  return (
    <nav className="record-contents" aria-labelledby="record-contents-label">
      <p className="record-contents-label" id="record-contents-label">
        On this page
      </p>
      <ol className="record-contents-list">
        {entries.map((entry) => (
          <li key={entry.id}>
            <a href={`#${entry.id}`} aria-current={current === entry.id ? "location" : undefined}>
              <span className="record-contents-mark" aria-hidden="true">
                {entry.mark}
              </span>
              {entry.label}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}
