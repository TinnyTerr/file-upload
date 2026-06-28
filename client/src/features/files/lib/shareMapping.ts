import { fileUrl } from "./shareUrl";
import type { UploadOutcome } from "./uploadCore";
import type { ShareEntry } from "../components/ShareModal";

/** Build a ShareModal entry from a finished single-file upload. */
export function outcomeToShareEntry(filename: string, { result, clientKeyB64 }: UploadOutcome): ShareEntry | null {
  if (!result.slug) return null;
  return {
    filename,
    mode: result.encryption_mode,
    baseUrl: fileUrl(result.slug),
    accessKey: result.access_key,
    clientKeyB64,
  };
}
