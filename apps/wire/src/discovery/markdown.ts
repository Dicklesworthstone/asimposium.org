/**
 * Discovery & Fellow face renderers (Rule A1 Diptych).
 *
 * Canonical machine/agent reading representations in plain GFM and HTML fragments
 * are defined in `@asimposium/render` with unified neutralization primitives to
 * prevent control-comment forgery, fence breakout, and XSS.
 */

export {
  renderAreaDetailHtmlFragment,
  renderAreaDetailMarkdown,
  renderAreasIndexHtmlFragment,
  renderAreasIndexMarkdown,
  renderFellowCardHtmlFragment,
  renderFellowCardMarkdown,
  renderNowStripHtmlFragment,
  renderNowStripMarkdown,
  safeCodeSpan,
  safeInlineProse,
} from "@asimposium/render";
