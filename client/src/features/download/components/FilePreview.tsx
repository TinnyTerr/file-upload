import { useEffect, useState } from "react";
import { previewPath } from "../services/publicService";
import type { PublicFileInfo } from "../services/publicService";

/**
 * Inline preview for unencrypted, unlimited-use links only. HTML/SVG are never
 * rendered inline (XSS); PDFs go in a sandboxed iframe; text is escaped.
 */
export function FilePreview({ slug, info }: { slug: string; info: PublicFileInfo }) {
  const ct = (info.content_type ?? "").toLowerCase();
  const previewable = info.encryption_mode === "none" && info.max_uses == null && !info.archived;

  if (!previewable) return null;
  const src = previewPath(slug);

  if (ct.startsWith("image/") && !ct.includes("svg")) {
    return <img src={src} alt={info.filename} className="max-h-[480px] w-full rounded-lg border border-border object-contain" />;
  }
  if (ct.startsWith("video/")) {
    return <video src={src} controls className="max-h-[480px] w-full rounded-lg border border-border" />;
  }
  if (ct.startsWith("audio/")) {
    return <audio src={src} controls className="w-full" />;
  }
  if (ct === "application/pdf") {
    return (
      <iframe
        src={src}
        title={info.filename}
        sandbox=""
        className="h-[520px] w-full rounded-lg border border-border bg-background"
      />
    );
  }
  if (ct.startsWith("text/")) {
    return <TextPreview src={src} />;
  }
  return null;
}

function TextPreview({ src }: { src: string }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    fetch(src, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then((t) => active && setText(t.slice(0, 64 * 1024)))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [src]);

  if (failed) return null;
  if (text == null) return <div className="h-32 animate-pulse rounded-lg bg-secondary/40" />;
  return (
    <pre className="max-h-[420px] overflow-auto rounded-lg border border-border bg-background/40 p-3 font-mono text-xs">
      {text}
    </pre>
  );
}
