/**
 * A section's Greek letter, struck as a small coin before its heading text.
 * Decorative: the heading text names the section, so the letter is hidden from
 * assistive technology. Renders nothing when the page assigns no letter.
 */
export function SectionCoin({ mark }: { readonly mark?: string | undefined }) {
  if (!mark) return null;
  return (
    <span className="gr" aria-hidden="true">
      {mark}
    </span>
  );
}
