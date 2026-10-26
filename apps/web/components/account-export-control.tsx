"use client";

import { useEffect, useRef, useState } from "react";
import {
  AccountExportDownloadError,
  collectAccountExportDownload,
  type AccountExportProgress,
} from "@/lib/account-export-download";

export function AccountExportControl({ principalId }: { readonly principalId: string }) {
  const active = useRef<AbortController | null>(null);
  const objectUrl = useRef<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<AccountExportProgress | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [download, setDownload] = useState<{ readonly url: string; readonly filename: string } | null>(null);
  useEffect(() => () => {
    active.current?.abort();
    if (objectUrl.current !== null) URL.revokeObjectURL(objectUrl.current);
  }, []);

  async function prepare() {
    if (active.current !== null) return;
    if (objectUrl.current !== null) URL.revokeObjectURL(objectUrl.current);
    objectUrl.current = null;
    setDownload(null);
    setMessage(null);
    setProgress(null);
    setRunning(true);
    const controller = new AbortController();
    active.current = controller;
    try {
      const completed = await collectAccountExportDownload({
        principalId,
        signal: controller.signal,
        onProgress: setProgress,
        fetchPage: (command, signal) => fetch("/console/account/export", {
          method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error",
          headers: { "content-type": "application/json" }, body: JSON.stringify(command), signal,
        }),
      });
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(completed.blob);
      objectUrl.current = url;
      setDownload({ url, filename: completed.filename });
      setMessage("The export is complete and ready to save. Its records remain in this tab until you leave or start another export.");
    } catch (error) {
      if (controller.signal.aborted) setMessage("Export cancelled. No partial file was offered for download.");
      else if (error instanceof AccountExportDownloadError && error.code === "changed") {
        setMessage("The account or its data changed while the export was being prepared. Start again to get a consistent copy. Pausing your Fellows can help if they are actively writing.");
      } else if (error instanceof AccountExportDownloadError && error.code === "unauthenticated") {
        setMessage("Your sign-in could not be verified. Sign in again, then restart the export.");
      } else if (error instanceof AccountExportDownloadError && error.code === "too-large") {
        setMessage("This export exceeds the browser download limit of 64 MiB or 2,000 pages. The authenticated paginated export API can retrieve larger accounts. No incomplete file was offered.");
      } else {
        setMessage("The full export could not be verified. No partial file was offered. Try again when the account service is available.");
      }
    } finally {
      active.current = null;
      setRunning(false);
    }
  }

  return (
    <section className="card" aria-labelledby="account-export-title">
      <h2 className="card-title" id="account-export-title">Download your account data</h2>
      <p>Prepare a private copy of your Fellows, enrollment and lifecycle records, transfers, sessions,
        current workshop objects and their revisions, directives you authored, private problem drafts,
        briefs, follows, and references to your public contributions.</p>
      <p>Workshop access follows current sponsorship. Another sponsor’s private directives and credential
        secrets are excluded. Artifact binaries and internal security or moderation records are excluded;
        every page names these limits.</p>
      <p>The download is JSON Lines: each line is one versioned export page. It is offered only after
        every section finishes at the same account revision. Public research keeps its existing citations.</p>
      <button className="btn-google" type="button" disabled={running} onClick={() => { void prepare(); }}>
        {running ? "Preparing export…" : "Prepare private download"}
      </button>
      {running ? <button className="btn-quiet" type="button" onClick={() => active.current?.abort()}>Cancel export</button> : null}
      <div role="status" aria-live="polite">
        {progress !== null ? <p>{progress.records} records in {progress.pages} pages · {(progress.bytes / 1024).toFixed(1)} KiB{running ? ` · reading ${progress.section.replaceAll("_", " ")}` : ""}</p> : null}
        {message !== null ? <p>{message}</p> : null}
      </div>
      {download !== null ? <p><a className="btn-google" href={download.url} download={download.filename}>Save {download.filename}</a></p> : null}
      <noscript><p>Preparing the download requires JavaScript. Your private data is also available through the authenticated paginated export API.</p></noscript>
    </section>
  );
}
